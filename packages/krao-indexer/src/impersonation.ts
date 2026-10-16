import type { IdResolver } from '@atproto/identity'
import type { AdminAuditLog } from './admin-roles.js'
import { fetchAvatarHash, similarAvatars } from './avatar-hash.js'
import type { Database } from './db.js'
import { handleKey, namesMatch, normalizeName } from './lookalike.js'

/*
 * Impersonation checks (M35). "Verified" accounts are those with an
 * app.bsky.graph.verification record from a trusted verifier
 * (KRAO_TRUSTED_VERIFIER_DIDS) that still matches their handle and display
 * name (as the AppView's blue check, M27). An account is a suspect when its
 * name looks like a verified account's (lookalike.ts) and either its avatar
 * looks alike (avatar-hash.ts) or its handle does. Verified accounts are
 * never suspects.
 *
 * Accounts are checked when their profile or handle changes, and all of them
 * when the verified set may have changed. Suspects get the
 * `impersonation-suspect` label from Krao's labeler (Ozone) and a report in
 * its queue; the label is taken off once they no longer match. Ozone calls
 * are retried until they succeed (impersonation_flag: desired vs applied).
 */

export const PROFILE_COLLECTION = 'app.bsky.actor.profile'
export const VERIFICATION_COLLECTION = 'app.bsky.graph.verification'
export const IMPERSONATION_LABEL = 'impersonation-suspect'

const CHECK_BATCH = 200
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60 * 60 * 1000
/** A failed avatar read is tried again after this long */
const AVATAR_RETRY_MS = 10 * 60 * 1000

/** Labels and reports in Krao's Ozone (see OzoneAdminClient) */
export interface ImpersonationModerator {
  /** Adds the label; `report` also files a report in the review queue */
  label(did: string, target: Target, report: boolean): Promise<void>
  /** Takes the label off, with a note */
  unlabel(did: string): Promise<void>
  /** Who the log names as acting (the labeler's or this service's DID) */
  actor: string
}

export type Target = { did: string; handle?: string | null }

type ProfileRow = {
  did: string
  handle: string | null
  displayName: string | null
  avatarCid: string | null
}

type Verified = ProfileRow & { nameKey: string; handleKey: string }

/** The name an account goes by: its display name, else its handle's first label */
export function shownName(row: {
  handle: string | null
  displayName: string | null
}): string {
  return row.displayName?.trim() || (row.handle ?? '').split('.')[0] || ''
}

/** A blob ref's CID, as the firehose (CID object) or JSON ($link) has it */
export function blobCid(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const ref = (value as { ref?: unknown }).ref
  if (!ref) return null
  if (typeof ref === 'object' && '$link' in ref) {
    return String((ref as { $link: unknown }).$link)
  }
  const cid = String(ref)
  return cid.startsWith('b') || cid.startsWith('Q') ? cid : null
}

export class ImpersonationWatcher {
  /** Called when work was queued (eg to run a round soon) */
  onQueued?: () => void

  constructor(
    private db: Database,
    private opts: {
      /** Trusted verifiers (a live set) */
      verifiers: Set<string>
      /** Krao's PDS over http(s): avatar blobs and the start-up backfill */
      pdsUrl: string
      idResolver: IdResolver
      moderator?: ImpersonationModerator
      audit?: AdminAuditLog
      fetchFn?: typeof fetch
    },
  ) {}

  private get fetch() {
    return this.opts.fetchFn ?? fetch
  }

  // Changes from the firehose
  // -------------------------

  async onRecord(
    did: string,
    collection: string,
    uri: string,
    record: unknown,
  ): Promise<void> {
    const value = (record ?? {}) as Record<string, unknown>
    if (collection === PROFILE_COLLECTION) {
      if (!uri.endsWith('/self')) return
      const displayName =
        typeof value.displayName === 'string' ? value.displayName : null
      await this.upsertProfile(did, {
        displayName,
        avatarCid: blobCid(value.avatar),
      })
    } else if (collection === VERIFICATION_COLLECTION) {
      const subject = typeof value.subject === 'string' ? value.subject : null
      if (!subject) return
      await this.db
        .insertInto('verification')
        .values({
          uri,
          issuer: did,
          subject,
          handle: typeof value.handle === 'string' ? value.handle : '',
          displayName:
            typeof value.displayName === 'string' ? value.displayName : '',
          createdAt:
            typeof value.createdAt === 'string'
              ? value.createdAt
              : new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.column('uri').doUpdateSet({
            subject,
            handle: typeof value.handle === 'string' ? value.handle : '',
            displayName:
              typeof value.displayName === 'string' ? value.displayName : '',
          }),
        )
        .execute()
      if (this.opts.verifiers.has(did)) await this.queueAll()
    }
  }

  async onDelete(did: string, collection: string, uri: string) {
    if (collection === PROFILE_COLLECTION) {
      if (!uri.endsWith('/self')) return
      await this.upsertProfile(did, { displayName: null, avatarCid: null })
    } else if (collection === VERIFICATION_COLLECTION) {
      const res = await this.db
        .deleteFrom('verification')
        .where('uri', '=', uri)
        .executeTakeFirst()
      if (Number(res.numDeletedRows) && this.opts.verifiers.has(did)) {
        await this.queueAll()
      }
    }
  }

  /** A handle change: the DID document is read again */
  async onIdentity(did: string) {
    const handle = await this.resolveHandle(did)
    await this.upsertProfile(did, { handle })
  }

  async onAccountDeleted(did: string) {
    const wasVerified = await this.isVerified(did)
    await this.db.deleteFrom('actor_profile').where('did', '=', did).execute()
    await this.db
      .deleteFrom('verification')
      .where('subject', '=', did)
      .execute()
    // Its label goes (an account that is gone impersonates nobody)
    await this.setDesired(did, null)
    if (wasVerified) await this.queueAll()
  }

  /** Trusted verifiers changed (eg one added at startup): check everyone */
  async verifiersChanged() {
    await this.queueAll()
  }

  private async resolveHandle(did: string): Promise<string | null> {
    try {
      const doc = await this.opts.idResolver.did.resolve(did, true)
      const aka = doc?.alsoKnownAs?.find((a) => a.startsWith('at://'))
      return aka ? aka.slice('at://'.length).toLowerCase() : null
    } catch {
      return null
    }
  }

  private async upsertProfile(
    did: string,
    change: Partial<Omit<ProfileRow, 'did'>>,
  ) {
    const before = await this.db
      .selectFrom('actor_profile')
      .selectAll()
      .where('did', '=', did)
      .executeTakeFirst()
    const row: ProfileRow = {
      did,
      handle: before?.handle ?? null,
      displayName: before?.displayName ?? null,
      avatarCid: before?.avatarCid ?? null,
      ...change,
    }
    if (row.handle === null && change.handle === undefined) {
      row.handle = await this.resolveHandle(did)
    }
    const wasVerified = before ? await this.isVerified(did) : false
    const values = {
      ...row,
      updatedAt: new Date().toISOString(),
    }
    await this.db
      .insertInto('actor_profile')
      .values(values)
      .onConflict((oc) => oc.column('did').doUpdateSet(values))
      .execute()
    // A verified account changing (or becoming verified) moves the bar for
    // everyone; others only need their own check
    if (wasVerified || (await this.isVerified(did))) await this.queueAll()
    else await this.queue([did])
  }

  // Checks
  // ------

  async queue(dids: string[]) {
    if (!dids.length) return
    const at = new Date().toISOString()
    await this.db
      .insertInto('impersonation_check')
      .values(dids.map((did) => ({ did, queuedAt: at })))
      .onConflict((oc) => oc.column('did').doNothing())
      .execute()
    this.onQueued?.()
  }

  async queueAll() {
    const at = new Date().toISOString()
    await this.db
      .insertInto('impersonation_check')
      .columns(['did', 'queuedAt'])
      .expression((eb) =>
        eb
          .selectFrom('actor_profile')
          .select(['did', eb.val(at).as('queuedAt')])
          // SQLite needs a WHERE before ON CONFLICT in INSERT ... SELECT
          .where('did', 'is not', null),
      )
      .onConflict((oc) => oc.column('did').doNothing())
      .execute()
    this.onQueued?.()
  }

  /** Accounts verified now, with their names normalized */
  async verifiedAccounts(): Promise<Verified[]> {
    const verifiers = [...this.opts.verifiers]
    if (!verifiers.length) return []
    const rows = await this.db
      .selectFrom('verification')
      .innerJoin('actor_profile', 'actor_profile.did', 'verification.subject')
      .select([
        'actor_profile.did',
        'actor_profile.handle',
        'actor_profile.displayName',
        'actor_profile.avatarCid',
        'verification.handle as vHandle',
        'verification.displayName as vDisplayName',
      ])
      .where('verification.issuer', 'in', verifiers)
      .execute()
    const seen = new Map<string, Verified>()
    for (const r of rows) {
      if (seen.has(r.did)) continue
      // Still the handle and name that were verified
      if ((r.handle ?? '').toLowerCase() !== r.vHandle.toLowerCase()) continue
      if ((r.displayName ?? '') !== r.vDisplayName) continue
      seen.set(r.did, {
        did: r.did,
        handle: r.handle,
        displayName: r.displayName,
        avatarCid: r.avatarCid,
        nameKey: normalizeName(shownName(r)),
        handleKey: handleKey(r.handle),
      })
    }
    return [...seen.values()]
  }

  async isVerified(did: string) {
    return (await this.verifiedAccounts()).some((v) => v.did === did)
  }

  /** The verified account `did` looks like, if any */
  async suspectTarget(
    did: string,
    verified?: Verified[],
  ): Promise<Verified | null> {
    const all = verified ?? (await this.verifiedAccounts())
    if (all.some((v) => v.did === did)) return null
    const row = await this.db
      .selectFrom('actor_profile')
      .selectAll()
      .where('did', '=', did)
      .executeTakeFirst()
    if (!row) return null
    const nameKey = normalizeName(shownName(row))
    const ownHandle = handleKey(row.handle)
    for (const v of all) {
      if (!namesMatch(nameKey, v.nameKey)) continue
      if (namesMatch(ownHandle, v.handleKey)) return v
      const [mine, theirs] = await Promise.all([
        this.avatarHash(row.did, row.avatarCid),
        this.avatarHash(v.did, v.avatarCid),
      ])
      if (similarAvatars(mine, theirs)) return v
    }
    return null
  }

  /** The avatar's hash, read once per blob (failures retried later) */
  async avatarHash(did: string, cid: string | null): Promise<string | null> {
    if (!cid) return null
    const cached = await this.db
      .selectFrom('avatar_hash')
      .selectAll()
      .where('cid', '=', cid)
      .executeTakeFirst()
    if (
      cached &&
      (cached.hash ||
        Date.now() - Date.parse(cached.checkedAt) < AVATAR_RETRY_MS)
    ) {
      return cached.hash
    }
    let hash: string | null = null
    let error: string | null = null
    try {
      hash = await fetchAvatarHash(this.opts.pdsUrl, did, cid, this.fetch)
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, 500)
    }
    const values = { cid, hash, error, checkedAt: new Date().toISOString() }
    await this.db
      .insertInto('avatar_hash')
      .values(values)
      .onConflict((oc) => oc.column('cid').doUpdateSet(values))
      .execute()
    return hash
  }

  /** Checks the queued accounts, then brings Ozone up to date */
  async round() {
    for (;;) {
      const due = await this.db
        .selectFrom('impersonation_check')
        .select('did')
        .orderBy('queuedAt', 'asc')
        .limit(CHECK_BATCH)
        .execute()
      if (!due.length) break
      const verified = await this.verifiedAccounts()
      for (const { did } of due) {
        const target = await this.suspectTarget(did, verified)
        await this.setDesired(did, target)
        await this.db
          .deleteFrom('impersonation_check')
          .where('did', '=', did)
          .execute()
      }
    }
    await this.applyFlags()
  }

  private async setDesired(did: string, target: Verified | null) {
    const now = new Date().toISOString()
    const row = await this.db
      .selectFrom('impersonation_flag')
      .selectAll()
      .where('did', '=', did)
      .executeTakeFirst()
    if (!target) {
      if (row?.desired) {
        await this.db
          .updateTable('impersonation_flag')
          .set({ desired: 0, attempts: 0, nextAttemptAt: now, updatedAt: now })
          .where('did', '=', did)
          .execute()
      }
      return
    }
    if (row?.desired && row.targetDid === target.did) return
    const values = {
      did,
      targetDid: target.did,
      targetHandle: target.handle,
      desired: 1,
      applied: row?.applied ?? 0,
      attempts: 0,
      nextAttemptAt: now,
      error: null,
      updatedAt: now,
    }
    await this.db
      .insertInto('impersonation_flag')
      .values(values)
      .onConflict((oc) =>
        oc.column('did').doUpdateSet({
          targetDid: values.targetDid,
          targetHandle: values.targetHandle,
          desired: 1,
          attempts: 0,
          nextAttemptAt: now,
          updatedAt: now,
        }),
      )
      .execute()
  }

  /** Labels and unlabels in Ozone what changed; failures wait longer */
  async applyFlags(now = Date.now()) {
    const moderator = this.opts.moderator
    if (!moderator) return
    const rows = await this.db
      .selectFrom('impersonation_flag')
      .selectAll()
      .whereRef('desired', '!=', 'applied')
      .where('nextAttemptAt', '<=', new Date(now).toISOString())
      .limit(100)
      .execute()
    for (const row of rows) {
      try {
        if (row.desired) {
          await moderator.label(
            row.did,
            { did: row.targetDid, handle: row.targetHandle },
            !row.reported,
          )
        } else {
          await moderator.unlabel(row.did)
        }
        await this.db
          .updateTable('impersonation_flag')
          .set({
            applied: row.desired,
            reported: row.desired ? 1 : row.reported,
            error: null,
          })
          .where('did', '=', row.did)
          .execute()
        await this.opts.audit?.record({
          service: 'moderation',
          actor: moderator.actor,
          action: row.desired ? 'impersonation.label' : 'impersonation.unlabel',
          subject: row.did,
          details: {
            target: row.targetDid,
            ...(row.targetHandle ? { targetHandle: row.targetHandle } : {}),
          },
        })
      } catch (err) {
        const delay = Math.min(RETRY_BASE_MS * 2 ** row.attempts, RETRY_MAX_MS)
        await this.db
          .updateTable('impersonation_flag')
          .set({
            attempts: row.attempts + 1,
            nextAttemptAt: new Date(now + delay).toISOString(),
            error: String((err as Error)?.message ?? err).slice(0, 500),
          })
          .where('did', '=', row.did)
          .execute()
        console.error('Krao indexer: impersonation label failed', row.did, err)
      }
    }
    // Unlabeled and never reported again: nothing left to remember
    await this.db
      .deleteFrom('impersonation_flag')
      .where('desired', '=', 0)
      .where('applied', '=', 0)
      .where('reported', '=', 0)
      .execute()
  }

  /** The verified account a suspect was labeled for (for the app) */
  async flagOf(did: string) {
    const row = await this.db
      .selectFrom('impersonation_flag')
      .select(['targetDid', 'targetHandle'])
      .where('did', '=', did)
      .where('desired', '=', 1)
      .executeTakeFirst()
    return row ?? null
  }

  // Start-up backfill
  // -----------------

  /**
   * Once per database: profiles and handles of every account on Krao's PDS,
   * and the verifications by trusted verifiers, from before this feature
   * (the firehose brings changes from then on)
   */
  async backfill() {
    const done = await this.db
      .selectFrom('impersonation_state')
      .select('value')
      .where('key', '=', 'backfill')
      .executeTakeFirst()
    if (done) return
    const base = this.opts.pdsUrl
    const getJson = async (path: string, params: Record<string, string>) => {
      const url = new URL(path, base)
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      const res = await this.fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return null
      return (await res.json()) as Record<string, any>
    }
    let cursor: string | undefined
    do {
      const page = await getJson('/xrpc/com.atproto.sync.listRepos', {
        limit: '500',
        ...(cursor ? { cursor } : {}),
      })
      if (!page) throw new Error('listRepos failed')
      for (const repo of (page.repos ?? []) as { did: string }[]) {
        const [described, profile] = await Promise.all([
          getJson('/xrpc/com.atproto.repo.describeRepo', { repo: repo.did }),
          getJson('/xrpc/com.atproto.repo.getRecord', {
            repo: repo.did,
            collection: PROFILE_COLLECTION,
            rkey: 'self',
          }),
        ])
        const value = (profile?.value ?? {}) as Record<string, unknown>
        const values = {
          did: repo.did,
          handle:
            typeof described?.handle === 'string'
              ? described.handle.toLowerCase()
              : null,
          displayName:
            typeof value.displayName === 'string' ? value.displayName : null,
          avatarCid: blobCid(value.avatar),
          updatedAt: new Date().toISOString(),
        }
        await this.db
          .insertInto('actor_profile')
          .values(values)
          .onConflict((oc) => oc.column('did').doNothing())
          .execute()
      }
      cursor = page.repos?.length ? page.cursor : undefined
    } while (cursor)
    for (const verifier of this.opts.verifiers) {
      let next: string | undefined
      do {
        const page = await getJson('/xrpc/com.atproto.repo.listRecords', {
          repo: verifier,
          collection: VERIFICATION_COLLECTION,
          limit: '100',
          ...(next ? { cursor: next } : {}),
        })
        if (!page) break
        for (const rec of (page.records ?? []) as {
          uri: string
          value: unknown
        }[]) {
          await this.onRecord(
            verifier,
            VERIFICATION_COLLECTION,
            rec.uri,
            rec.value,
          )
        }
        next = page.records?.length ? page.cursor : undefined
      } while (next)
    }
    await this.db
      .insertInto('impersonation_state')
      .values({ key: 'backfill', value: new Date().toISOString() })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute()
    await this.queueAll()
  }
}

/**
 * Krao's Ozone, with its admin password (OZONE_ADMIN_PASSWORD): labels with
 * tools.ozone.moderation.emitEvent (modEventLabel), reports with
 * modEventReport, both on the account (repoRef). `createdBy` is the DID the
 * events are recorded as coming from (this service).
 */
export class OzoneAdminClient implements ImpersonationModerator {
  constructor(
    private url: string,
    private adminPassword: string,
    private createdBy: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  get actor() {
    return this.createdBy
  }

  private async emit(did: string, event: Record<string, unknown>) {
    const res = await this.fetchFn(
      new URL('/xrpc/tools.ozone.moderation.emitEvent', this.url),
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${this.adminPassword}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          event,
          subject: { $type: 'com.atproto.admin.defs#repoRef', did },
          createdBy: this.createdBy,
          modTool: { name: 'krao-indexer/impersonation' },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Ozone emitEvent: HTTP ${res.status} ${body.slice(0, 200)}`,
      )
    }
  }

  async label(did: string, target: Target, report: boolean) {
    const whom = target.handle
      ? `@${target.handle} (${target.did})`
      : target.did
    await this.emit(did, {
      $type: 'tools.ozone.moderation.defs#modEventLabel',
      createLabelVals: [IMPERSONATION_LABEL],
      negateLabelVals: [],
      comment: `Krao: possible impersonation of ${whom} (name and avatar or handle look alike)`,
    })
    if (report) {
      await this.emit(did, {
        $type: 'tools.ozone.moderation.defs#modEventReport',
        reportType: 'tools.ozone.report.defs#reasonMisleadingImpersonation',
        comment: `Krao automatic check: may impersonate the verified account ${whom}`,
      })
    }
  }

  async unlabel(did: string) {
    await this.emit(did, {
      $type: 'tools.ozone.moderation.defs#modEventLabel',
      createLabelVals: [],
      negateLabelVals: [IMPERSONATION_LABEL],
      comment:
        'Krao: no longer looks like a verified account (name or avatar changed); label removed automatically',
    })
  }
}
