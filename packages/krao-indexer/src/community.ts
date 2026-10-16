import { type RawBuilder, sql } from 'kysely'
import { AtUri } from '@atproto/syntax'
import type { EvmRpc } from './chain.js'
import { parseAssetId } from './chain.js'
import {
  type CommunityAccessMode,
  type CommunityActionTable,
  type CommunityMembershipTable,
  type CommunitySubmissionTable,
  type CommunityTable,
  type Database,
  visibleDid,
} from './db.js'
import {
  type ChainCondition,
  isChainCondition,
  matchConditions,
  meetsCondition,
} from './gate.js'
import type { HumanCheck } from './human.js'
import { ownedEvmAddresses } from './wallets.js'

/*
 * Krao communities (net.krao.community.*). A community is a profile record in
 * its owner's repo (rkey = slug). Members join with a membership record in
 * their own repo; whether it counts depends on the access mode:
 *   open       always
 *   approval   an approval record by the owner or a moderator exists
 *   condition  the member's wallets meet the conditions (gate conditions,
 *              checked in the background and when the member looks)
 *   verified   the member verified a phone or passed KYC (rewards service)
 * The owner appoints moderators (moderator records in the owner's repo).
 * Approvals, bans and hides count when written by the owner or a current
 * moderator, which is checked on every read since moderators come and go.
 * A ban by a moderator does not apply to moderators; nobody bans the owner.
 * The feed lists submissions (a member's own posts) by members in good
 * standing, without hidden posts.
 */

export const COMMUNITY_COLLECTION = 'net.krao.community.profile'
export const MEMBERSHIP_COLLECTION = 'net.krao.community.membership'
export const MODERATOR_COLLECTION = 'net.krao.community.moderator'
export const APPROVAL_COLLECTION = 'net.krao.community.approval'
export const BAN_COLLECTION = 'net.krao.community.ban'
export const HIDE_COLLECTION = 'net.krao.community.hide'
export const SUBMISSION_COLLECTION = 'net.krao.community.submission'

/** Records written by the owner or moderators, and their tables */
const ACTION_TABLES = {
  [MODERATOR_COLLECTION]: 'community_moderator',
  [APPROVAL_COLLECTION]: 'community_approval',
  [BAN_COLLECTION]: 'community_ban',
  [HIDE_COLLECTION]: 'community_hide',
} as const

type ActionCollection = keyof typeof ACTION_TABLES

export const COMMUNITY_COLLECTIONS = [
  COMMUNITY_COLLECTION,
  MEMBERSHIP_COLLECTION,
  SUBMISSION_COLLECTION,
  ...(Object.keys(ACTION_TABLES) as ActionCollection[]),
]

export const isActionCollection = (c: string): c is ActionCollection =>
  c in ACTION_TABLES

const ACCESS_MODES: CommunityAccessMode[] = [
  'open',
  'approval',
  'condition',
  'verified',
]

/** 3 to 40 characters: a-z, 0-9 and inner '-' */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

/** What membership checks need: the chains, and the rewards service */
export type CommunityChecks = {
  rpcs: Map<string, EvmRpc>
  human?: HumanCheck
  /**
   * Told when a check finds an account meets a 'condition' or 'verified'
   * community's requirement (it may have just become a member)
   */
  onEligible?: (community: string, did: string) => Promise<void>
}

export type CommunityAccess = {
  mode: CommunityAccessMode
  conditions?: ChainCondition[]
  match?: 'all' | 'any'
}

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && !isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.slice(0, max) : null

function atUri(value: unknown, collection: string): AtUri | null {
  if (typeof value !== 'string') return null
  try {
    const uri = new AtUri(value)
    return uri.collection === collection && uri.rkey ? uri : null
  } catch {
    return null
  }
}

/** The CID of a blob ref, as the firehose (CID object) or JSON ($link) has it */
function blobCid(blob: unknown): string | null {
  const ref = (blob as { ref?: unknown } | null)?.ref
  if (!ref) return null
  const link = (ref as { $link?: unknown }).$link
  const cid = typeof link === 'string' ? link : String(ref)
  return /^[a-zA-Z0-9]{8,128}$/.test(cid) ? cid : null
}

// Records
// -------

export function communityRowFromRecord(
  uri: string,
  did: string,
  cid: string,
  record: unknown,
): CommunityTable | null {
  const at = atUri(uri, COMMUNITY_COLLECTION)
  if (!at || at.host !== did || !SLUG.test(at.rkey)) return null
  const value = (record ?? {}) as Record<string, unknown>
  const name = text(value.name, 640)?.trim()
  if (!name) return null
  const access = (value.access ?? {}) as Record<string, unknown>
  const mode = access.mode as CommunityAccessMode
  if (!ACCESS_MODES.includes(mode)) return null
  const stored: CommunityAccess = { mode }
  if (mode === 'condition') {
    const conditions = Array.isArray(access.conditions)
      ? access.conditions.filter(isChainCondition).slice(0, 5)
      : []
    if (!conditions.length) return null
    stored.conditions = conditions
    stored.match = access.match === 'any' ? 'any' : 'all'
  }
  const rules = Array.isArray(value.rules)
    ? value.rules
        .map((r) => text(r, 3000))
        .filter((r): r is string => !!r)
        .slice(0, 10)
    : []
  const link = typeof value.chatJoinLink === 'string' ? value.chatJoinLink : ''
  const now = new Date().toISOString()
  return {
    uri,
    did,
    cid,
    slug: at.rkey,
    name,
    description: text(value.description, 3000),
    avatar: blobCid(value.avatar),
    rules: JSON.stringify(rules),
    accessMode: mode,
    access: JSON.stringify(stored),
    chatJoinLink:
      /^https?:\/\/[^\s]+$/.test(link) && link.length <= 2048 ? link : null,
    createdAt: isoDate(value.createdAt) ?? now,
    indexedAt: now,
  }
}

/**
 * New access rules make every membership a question again (the background
 * round checks them; open and approval communities need no check)
 */
export async function upsertCommunity(db: Database, row: CommunityTable) {
  const old = await db
    .selectFrom('community')
    .select('access')
    .where('uri', '=', row.uri)
    .executeTakeFirst()
  // indexedAt stays the first time the community was seen ("new" sort)
  const { indexedAt: _first, ...update } = row
  await db
    .insertInto('community')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(update))
    .execute()
  if (old && old.access !== row.access) {
    await db
      .updateTable('community_membership')
      .set({ eligible: null, reason: null, checkedAt: null })
      .where('community', '=', row.uri)
      .execute()
  }
}

export function membershipRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): CommunityMembershipTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  const community = atUri(value.subject, COMMUNITY_COLLECTION)
  if (!community) return null
  const now = new Date().toISOString()
  return {
    uri,
    did,
    community: community.toString(),
    eligible: null,
    reason: null,
    checkedAt: null,
    createdAt: isoDate(value.createdAt) ?? now,
    indexedAt: now,
  }
}

export async function upsertMembership(
  db: Database,
  row: CommunityMembershipTable,
) {
  await db
    .insertInto('community_membership')
    .values(row)
    .onConflict((oc) =>
      oc.column('uri').doUpdateSet({
        community: row.community,
        createdAt: row.createdAt,
        eligible: null,
        reason: null,
        checkedAt: null,
      }),
    )
    .execute()
}

/**
 * A moderator, approval, ban or hide record. Moderators only count in the
 * owner's repo; the others are checked against the staff when read.
 */
export function actionRowFromRecord(
  collection: ActionCollection,
  uri: string,
  did: string,
  record: unknown,
): CommunityActionTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  const community = atUri(value.community, COMMUNITY_COLLECTION)
  if (!community) return null
  if (collection === MODERATOR_COLLECTION && community.host !== did) {
    return null
  }
  let subject: string | null
  if (collection === HIDE_COLLECTION) {
    subject = atUri(value.post, 'app.bsky.feed.post')?.toString() ?? null
  } else {
    subject =
      typeof value.subject === 'string' && value.subject.startsWith('did:')
        ? value.subject
        : null
  }
  if (!subject) return null
  return {
    uri,
    did,
    community: community.toString(),
    subject,
    reason: text(value.reason, 3000),
    createdAt: isoDate(value.createdAt) ?? new Date().toISOString(),
  }
}

export async function upsertAction(
  db: Database,
  collection: ActionCollection,
  row: CommunityActionTable,
) {
  await db
    .insertInto(ACTION_TABLES[collection])
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(row))
    .execute()
}

/** A submission of one of the author's own posts */
export function submissionRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): CommunitySubmissionTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  const community = atUri(value.community, COMMUNITY_COLLECTION)
  const ref = (value.post ?? {}) as { uri?: unknown; cid?: unknown }
  const post = atUri(ref.uri, 'app.bsky.feed.post')
  if (!community || !post || post.host !== did) return null
  if (typeof ref.cid !== 'string') return null
  const now = new Date().toISOString()
  return {
    uri,
    did,
    community: community.toString(),
    post: post.toString(),
    postCid: ref.cid,
    createdAt: isoDate(value.createdAt) ?? now,
    indexedAt: now,
  }
}

export async function upsertSubmission(
  db: Database,
  row: CommunitySubmissionTable,
) {
  // A post already in the feed (another submission of it) stays as it is
  await db
    .insertInto('community_submission')
    .values(row)
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/** Removes the row of a deleted (or now invalid) community record */
export async function deleteCommunityRecord(
  db: Database,
  collection: string,
  uri: string,
) {
  if (collection === COMMUNITY_COLLECTION) {
    await db.deleteFrom('community').where('uri', '=', uri).execute()
  } else if (collection === MEMBERSHIP_COLLECTION) {
    await db.deleteFrom('community_membership').where('uri', '=', uri).execute()
  } else if (collection === SUBMISSION_COLLECTION) {
    await db.deleteFrom('community_submission').where('uri', '=', uri).execute()
  } else if (isActionCollection(collection)) {
    await db
      .deleteFrom(ACTION_TABLES[collection])
      .where('uri', '=', uri)
      .execute()
  }
}

/**
 * A deleted community: its memberships, approvals and feed go with it, so a
 * community created again at the same slug starts empty. Moderators, bans and
 * hides stay (records the staff still hold in their repos; a ban must not
 * lapse because the community was re-created).
 */
export async function deleteCommunity(db: Database, uri: string) {
  await db.deleteFrom('community').where('uri', '=', uri).execute()
  for (const table of [
    'community_membership',
    'community_submission',
    'community_approval',
  ] as const) {
    await db.deleteFrom(table).where('community', '=', uri).execute()
  }
}

/** A deleted post leaves every community feed */
export async function deleteSubmissionsForPost(db: Database, post: string) {
  await db.deleteFrom('community_submission').where('post', '=', post).execute()
}

/**
 * A deleted account: its communities (with everything that refers to them)
 * and every community record it wrote
 */
export async function deleteCommunityDataForDid(db: Database, did: string) {
  const owned = (
    await db
      .selectFrom('community')
      .select('uri')
      .where('did', '=', did)
      .execute()
  ).map((r) => r.uri)
  const tables = [
    'community_membership',
    'community_submission',
    ...Object.values(ACTION_TABLES),
  ] as const
  for (const table of tables) {
    if (owned.length) {
      await db.deleteFrom(table).where('community', 'in', owned).execute()
    }
    await db.deleteFrom(table).where('did', '=', did).execute()
  }
  await db.deleteFrom('community').where('did', '=', did).execute()
}

// Standing
// --------

/*
 * SQL over a community row aliased `c`. The fragments are fixed text (column
 * names only), never user input.
 */
const MODS = `select mo.subject from community_moderator mo where mo.community = c.uri and mo.did = c.did`
const notHidden = (col: string) =>
  `${col} not in (select did from hidden_actor)`
/** Moderators whose approvals, bans and hides count: not hidden, not banned by the owner */
const ACTIVE_MODS = `${MODS} and ${notHidden('mo.subject')} and not exists (select 1 from community_ban ob where ob.community = c.uri and ob.subject = mo.subject and ob.did = c.did)`
const isStaff = (col: string) =>
  `(${col} = c.did or ${col} in (${ACTIVE_MODS}))`
const isBanned = (col: string) =>
  `exists (select 1 from community_ban b where b.community = c.uri and b.subject = ${col} and ${col} != c.did and (b.did = c.did or (b.did in (${ACTIVE_MODS}) and ${col} not in (${MODS}))))`
const isApproved = (col: string) =>
  `exists (select 1 from community_approval a where a.community = c.uri and a.subject = ${col} and ${isStaff('a.did')})`
const validMembership = (m: string) =>
  `(c.accessMode = 'open' or (c.accessMode = 'approval' and ${isApproved(`${m}.did`)}) or (c.accessMode in ('condition', 'verified') and ${m}.eligible = 1))`
/** `col` is a member in good standing of `c` (owner, moderator or member) */
const inGoodStanding = (col: string) =>
  `(${notHidden(col)} and not ${isBanned(col)} and (${isStaff(col)} or exists (select 1 from community_membership gm where gm.community = c.uri and gm.did = ${col} and ${validMembership('gm')})))`

/** Members in good standing of `c`, the owner and moderators included */
const MEMBER_COUNT = sql.raw<number>(
  `((case when ${notHidden('c.did')} then 1 else 0 end) + (select count(distinct mc.subject) from community_moderator mc where mc.community = c.uri and mc.did = c.did and mc.subject != c.did and ${notHidden('mc.subject')} and not ${isBanned('mc.subject')}) + (select count(distinct mm.did) from community_membership mm where mm.community = c.uri and mm.did != c.did and mm.did not in (${MODS}) and ${notHidden('mm.did')} and not ${isBanned('mm.did')} and ${validMembership('mm')}))`,
)

export type CommunityRow = CommunityTable & { memberCount: number }

/** A community whose owner is not hidden, with its member count */
export async function getCommunity(
  db: Database,
  uri: string,
): Promise<CommunityRow | undefined> {
  const row = await db
    .selectFrom('community as c')
    .selectAll('c')
    .select(MEMBER_COUNT.as('memberCount'))
    .where('c.uri', '=', uri)
    .where(visibleDid('c.did'))
    .executeTakeFirst()
  return row && { ...row, memberCount: Number(row.memberCount) }
}

export async function getCommunities(
  db: Database,
  uris: string[],
): Promise<CommunityRow[]> {
  if (!uris.length) return []
  const rows = await db
    .selectFrom('community as c')
    .selectAll('c')
    .select(MEMBER_COUNT.as('memberCount'))
    .where('c.uri', 'in', uris)
    .where(visibleDid('c.did'))
    .execute()
  const byUri = new Map(
    rows.map((r) => [r.uri, { ...r, memberCount: Number(r.memberCount) }]),
  )
  return uris.flatMap((u) => byUri.get(u) ?? [])
}

/** Communities by member count or newest first; the cursor is an offset */
export async function listCommunities(
  db: Database,
  opts: { query?: string; sort?: string; limit: number; cursor?: string },
): Promise<{ communities: CommunityRow[]; cursor?: string }> {
  const offset = parseOffset(opts.cursor)
  let qb = db
    .selectFrom('community as c')
    .selectAll('c')
    .select(MEMBER_COUNT.as('memberCount'))
    .where(visibleDid('c.did'))
  const q = opts.query?.trim().toLowerCase()
  if (q) {
    qb = qb.where(
      sql<boolean>`(instr(lower(c.name), ${q}) > 0 or instr(c.slug, ${q}) > 0 or instr(lower(coalesce(c.description, '')), ${q}) > 0)`,
    )
  }
  qb =
    opts.sort === 'new'
      ? qb.orderBy('c.indexedAt', 'desc').orderBy('c.uri', 'desc')
      : qb
          .orderBy('memberCount', 'desc')
          .orderBy('c.indexedAt', 'desc')
          .orderBy('c.uri', 'desc')
  const rows = await qb.limit(opts.limit).offset(offset).execute()
  return {
    communities: rows.map((r) => ({
      ...r,
      memberCount: Number(r.memberCount),
    })),
    cursor:
      rows.length === opts.limit ? String(offset + rows.length) : undefined,
  }
}

function parseOffset(cursor?: string): number {
  if (!cursor) return 0
  if (!/^[0-9]{1,5}$/.test(cursor)) throw new Error('Malformed cursor')
  return Number(cursor)
}

/**
 * Current moderators (appointed in the owner's repo) in good standing (not
 * hidden, not banned by the owner), oldest first
 */
export async function getModerators(
  db: Database,
  community: CommunityTable,
): Promise<string[]> {
  const { rows } = await sql<{ subject: string }>`select mo.subject as subject
    from community_moderator mo join community c on c.uri = mo.community
    where mo.community = ${community.uri} and mo.did = c.did and mo.subject != c.did
      and ${sql.raw(notHidden('mo.subject'))} and not ${sql.raw(isBanned('mo.subject'))}
    order by mo.createdAt asc`.execute(db)
  return [...new Set(rows.map((r) => r.subject))]
}

/** Whether `did` may moderate: the owner or a current moderator */
export async function isStaffMember(
  db: Database,
  community: CommunityTable,
  did: string,
): Promise<boolean> {
  if (did === community.did) return true
  const row = await db
    .selectFrom('community_moderator')
    .select('uri')
    .where('community', '=', community.uri)
    .where('did', '=', community.did)
    .where('subject', '=', did)
    .executeTakeFirst()
  return !!row
}

async function standingFlags(
  db: Database,
  community: string,
  did: string,
): Promise<{ banned: boolean; approved: boolean }> {
  const { rows } = await sql<{
    banned: number
    approved: number
  }>`select ${sql.raw(isBanned('v.did'))} as banned, ${sql.raw(
    isApproved('v.did'),
  )} as approved from community c, (select ${did} as did) v where c.uri = ${community}`.execute(
    db,
  )
  return { banned: !!rows[0]?.banned, approved: !!rows[0]?.approved }
}

export type MembershipState =
  'member' | 'pending' | 'ineligible' | 'banned' | 'none'

export type ViewerState = {
  state: MembershipState
  role?: 'owner' | 'moderator' | 'member'
  eligible?: boolean
  reason?: string
  membership?: string
}

/*
 * Condition checks cost on-chain calls: a yes is cached for a while per
 * (community, access, member, wallets), like token gates; a no never is.
 */
const ELIGIBLE_TTL_MS = 2 * 60 * 1000
const eligibleCache = new Map<string, number>()

/**
 * Whether `did` meets the requirement of a 'condition' or 'verified'
 * community now. Throws when the chain or the rewards service cannot answer.
 * `fresh` skips the cached yes (background re-checks).
 */
export async function checkEligibility(
  db: Database,
  checks: CommunityChecks,
  community: CommunityTable,
  did: string,
  fresh = false,
): Promise<{ eligible: boolean; reason?: string }> {
  if (community.accessMode === 'verified') {
    if (!checks.human) {
      return { eligible: false, reason: 'VerificationUnavailable' }
    }
    return (await checks.human.isHuman(did))
      ? { eligible: true }
      : { eligible: false, reason: 'NotVerified' }
  }
  if (community.accessMode !== 'condition') return { eligible: true }
  const access = JSON.parse(community.access) as CommunityAccess
  const addresses = [...(await ownedEvmAddresses(db, did))].sort()
  if (!addresses.length) return { eligible: false, reason: 'NoWallet' }
  const key = [community.uri, community.access, did, ...addresses].join('|')
  const now = Date.now()
  if (!fresh && (eligibleCache.get(key) ?? 0) > now) return { eligible: true }
  const eligible = await matchConditions(
    access.conditions ?? [],
    access.match ?? 'all',
    (condition) => meetsCondition(checks.rpcs, condition, addresses),
  )
  if (!eligible) {
    eligibleCache.delete(key)
    return { eligible: false, reason: 'ConditionsNotMet' }
  }
  if (eligibleCache.size > 10_000) eligibleCache.clear()
  eligibleCache.set(key, now + ELIGIBLE_TTL_MS)
  return { eligible: true }
}

/** Stores a check's result on the account's memberships of the community */
async function recordEligibility(
  db: Database,
  checks: CommunityChecks,
  community: string,
  did: string,
  result: { eligible: boolean; reason?: string },
) {
  await db
    .updateTable('community_membership')
    .set({
      eligible: result.eligible ? 1 : 0,
      reason: result.reason ?? null,
      checkedAt: new Date().toISOString(),
    })
    .where('community', '=', community)
    .where('did', '=', did)
    .execute()
  if (result.eligible) await checks.onEligible?.(community, did)
}

/**
 * The account's place in the community. With `live`, 'condition' and
 * 'verified' requirements are checked now (and the result stored); without,
 * the last background check is used.
 */
export async function getViewerState(
  db: Database,
  checks: CommunityChecks,
  community: CommunityTable,
  did: string,
  live: boolean,
): Promise<ViewerState> {
  const hidden = await db
    .selectFrom('hidden_actor')
    .select('did')
    .where('did', '=', did)
    .executeTakeFirst()
  if (hidden) return { state: 'none' }
  const membership = await db
    .selectFrom('community_membership')
    .selectAll()
    .where('community', '=', community.uri)
    .where('did', '=', did)
    .orderBy('indexedAt', 'asc')
    .executeTakeFirst()
  const mine = membership ? { membership: membership.uri } : {}
  if (did === community.did) return { state: 'member', role: 'owner', ...mine }
  const { banned, approved } = await standingFlags(db, community.uri, did)
  const moderator = await isStaffMember(db, community, did)
  if (banned) return { state: 'banned', reason: 'Banned', ...mine }
  if (moderator) return { state: 'member', role: 'moderator', ...mine }

  let eligible: boolean | undefined
  let reason: string | undefined
  if (
    community.accessMode === 'condition' ||
    community.accessMode === 'verified'
  ) {
    if (live) {
      try {
        const result = await checkEligibility(db, checks, community, did)
        eligible = result.eligible
        reason = result.reason
        if (membership) {
          await recordEligibility(db, checks, community.uri, did, result)
        }
      } catch {
        // Fall back to the last check
      }
    }
    if (eligible === undefined && membership?.eligible != null) {
      eligible = membership.eligible === 1
      reason = membership.reason ?? undefined
    }
  }
  const eligibility = eligible === undefined ? {} : { eligible }
  if (!membership) {
    return {
      state: 'none',
      ...eligibility,
      ...(eligible === false && reason ? { reason } : {}),
    }
  }
  if (community.accessMode === 'open') {
    return { state: 'member', role: 'member', ...mine }
  }
  if (community.accessMode === 'approval') {
    return approved
      ? { state: 'member', role: 'member', ...mine }
      : { state: 'pending', reason: 'AwaitingApproval', ...mine }
  }
  if (eligible === true) {
    return { state: 'member', role: 'member', eligible, ...mine }
  }
  if (eligible === false) {
    return {
      state: 'ineligible',
      eligible,
      reason: reason ?? 'ConditionsNotMet',
      ...mine,
    }
  }
  return { state: 'pending', reason: 'NotCheckedYet', ...mine }
}

/** For gates: whether `did` is a member in good standing right now */
export async function isCommunityMember(
  db: Database,
  checks: CommunityChecks,
  uri: string,
  did: string,
): Promise<boolean> {
  const community = await db
    .selectFrom('community')
    .selectAll()
    .where('uri', '=', uri)
    .where(visibleDid('did'))
    .executeTakeFirst()
  if (!community) return false
  return (
    (await getViewerState(db, checks, community, did, true)).state === 'member'
  )
}

/** A community needs this many other members for joining it to be rewarded */
export const JOIN_REWARD_MIN_OTHERS = 3

/**
 * Whether `did` joining `community` now counts for community.joined (M33):
 * it is a member in good standing (as last checked: membership accepted,
 * approved, or the requirement met) of a community it does not own, which
 * has at least JOIN_REWARD_MIN_OTHERS other members in good standing, the
 * owner and moderators included.
 */
export async function isRewardableJoin(
  db: Database,
  community: string,
  did: string,
): Promise<boolean> {
  const { rows } = await sql<{
    owner: string
    member: number
    count: number
  }>`select c.did as owner, ${sql.raw(inGoodStanding('v.did'))} as member, ${MEMBER_COUNT} as count
    from community c, (select ${did} as did) v
    where c.uri = ${community} and ${sql.raw(notHidden('c.did'))}`.execute(db)
  const row = rows[0]
  if (!row || row.owner === did || !row.member) return false
  // The member count includes the newcomer
  return Number(row.count) - 1 >= JOIN_REWARD_MIN_OTHERS
}

/**
 * Checks memberships of 'condition' and 'verified' communities that were
 * never checked or not since `dueBefore`. A member who no longer qualifies
 * is only dropped once the chain is seen answering, so an RPC outage does not
 * empty the feeds.
 */
export async function recheckMemberships(
  db: Database,
  checks: CommunityChecks,
  dueBefore: string,
  limit = 200,
): Promise<number> {
  const due = await db
    .selectFrom('community_membership as m')
    .innerJoin('community as c', 'c.uri', 'm.community')
    .select(['m.did', 'm.community', 'm.eligible'])
    .where('c.accessMode', 'in', ['condition', 'verified'])
    .where((eb) =>
      eb.or([eb('m.checkedAt', 'is', null), eb('m.checkedAt', '<', dueBefore)]),
    )
    .where(visibleDid('m.did'))
    .orderBy(sql`m.checkedAt is not null`)
    .orderBy('m.checkedAt', 'asc')
    .limit(limit)
    .execute()
  const seen = new Set<string>()
  let checked = 0
  for (const row of due) {
    const key = `${row.community} ${row.did}`
    if (seen.has(key)) continue
    seen.add(key)
    const community = await db
      .selectFrom('community')
      .selectAll()
      .where('uri', '=', row.community)
      .executeTakeFirst()
    if (!community) continue
    try {
      const result = await checkEligibility(
        db,
        checks,
        community,
        row.did,
        true,
      )
      if (
        !result.eligible &&
        row.eligible === 1 &&
        community.accessMode === 'condition' &&
        !(await chainsAnswer(checks, community))
      ) {
        throw new Error('Chain not answering')
      }
      await recordEligibility(db, checks, community.uri, row.did, result)
      checked++
    } catch (err) {
      console.error('Krao indexer: membership check failed', key, err)
      // Tried again after the recheck interval, keeping the last answer
      await db
        .updateTable('community_membership')
        .set({ checkedAt: new Date().toISOString() })
        .where('community', '=', row.community)
        .where('did', '=', row.did)
        .execute()
    }
  }
  return checked
}

/** Whether every chain a community's conditions use answers right now */
async function chainsAnswer(
  checks: CommunityChecks,
  community: CommunityTable,
): Promise<boolean> {
  const access = JSON.parse(community.access) as CommunityAccess
  const chains = new Set(
    (access.conditions ?? []).map((c) =>
      c.$type === 'net.krao.gate.defs#tokenBalance'
        ? parseAssetId(c.asset)?.chainId
        : c.chain,
    ),
  )
  for (const chain of chains) {
    const rpc = chain ? checks.rpcs.get(chain) : undefined
    if (!rpc) continue
    try {
      await rpc.blockNumber()
    } catch {
      return false
    }
  }
  return true
}

// Lists
// -----

export type MemberRow = {
  did: string
  role: 'owner' | 'moderator' | 'member'
  membership?: string
  joinedAt?: string
}

/**
 * Members in good standing: the owner and moderators on the first page, then
 * members, the most recent first. The cursor is an offset into the members.
 */
export async function getMembers(
  db: Database,
  community: CommunityTable,
  limit: number,
  cursor?: string,
): Promise<{ members: MemberRow[]; cursor?: string }> {
  const offset = parseOffset(cursor)
  const staff: MemberRow[] = []
  if (!offset) {
    if (await isVisible(db, community.did)) {
      staff.push({
        did: community.did,
        role: 'owner',
        joinedAt: community.createdAt,
      })
    }
    for (const did of await getModerators(db, community)) {
      staff.push({ did, role: 'moderator' })
    }
  }
  const { rows } = await sql<{
    did: string
    membership: string
    joinedAt: string
  }>`select m.did as did, min(m.uri) as membership, min(m.createdAt) as joinedAt
    from community_membership m join community c on c.uri = m.community
    where m.community = ${community.uri} and m.did != c.did and m.did not in (${sql.raw(MODS)})
      and ${sql.raw(notHidden('m.did'))} and not ${sql.raw(isBanned('m.did'))} and ${sql.raw(validMembership('m'))}
    group by m.did order by joinedAt desc, m.did desc limit ${limit} offset ${offset}`.execute(
    db,
  )
  return {
    members: [
      ...staff,
      ...rows.map((r) => ({
        did: r.did,
        role: 'member' as const,
        membership: r.membership,
        joinedAt: r.joinedAt,
      })),
    ],
    cursor: rows.length === limit ? String(offset + rows.length) : undefined,
  }
}

/** Accounts waiting for approval, the oldest first (approval communities) */
export async function getPendingMembers(
  db: Database,
  community: CommunityTable,
  limit: number,
  cursor?: string,
): Promise<{ members: MemberRow[]; cursor?: string }> {
  const offset = parseOffset(cursor)
  if (community.accessMode !== 'approval') return { members: [] }
  const { rows } = await sql<{
    did: string
    membership: string
    joinedAt: string
  }>`select m.did as did, min(m.uri) as membership, min(m.createdAt) as joinedAt
    from community_membership m join community c on c.uri = m.community
    where m.community = ${community.uri} and not ${sql.raw(isStaff('m.did'))}
      and ${sql.raw(notHidden('m.did'))} and not ${sql.raw(isBanned('m.did'))} and not ${sql.raw(isApproved('m.did'))}
    group by m.did order by joinedAt asc, m.did asc limit ${limit} offset ${offset}`.execute(
    db,
  )
  return {
    members: rows.map((r) => ({
      did: r.did,
      role: 'member' as const,
      membership: r.membership,
      joinedAt: r.joinedAt,
    })),
    cursor: rows.length === limit ? String(offset + rows.length) : undefined,
  }
}

async function isVisible(db: Database, did: string) {
  return !(await db
    .selectFrom('hidden_actor')
    .select('did')
    .where('did', '=', did)
    .executeTakeFirst())
}

export type FeedItemRow = {
  post: string
  submission: string
  author: string
  indexedAt: string
}

/**
 * The community feed, newest first: submissions by members in good standing
 * minus posts hidden by the staff. The cursor is `<indexedAt>::<uri>`. With
 * `publicOnly` (the community's feed generator), posts with a gate (members
 * only or any other condition) are left out too.
 */
export async function getCommunityFeed(
  db: Database,
  community: string,
  limit: number,
  cursor?: string,
  opts: { publicOnly?: boolean } = {},
): Promise<{ feed: FeedItemRow[]; cursor?: string }> {
  const gated = opts.publicOnly
    ? sql`and not exists (select 1 from gate_rule g where g.subject = s.post)`
    : sql``
  let after: RawBuilder<unknown> = sql``
  if (cursor) {
    const [indexedAt, uri] = cursor.split('::')
    if (!indexedAt || !uri) throw new Error('Malformed cursor')
    after = sql`and (s.indexedAt < ${indexedAt} or (s.indexedAt = ${indexedAt} and s.uri < ${uri}))`
  }
  const { rows } = await sql<{
    uri: string
    post: string
    did: string
    indexedAt: string
  }>`select s.uri, s.post, s.did, s.indexedAt
    from community_submission s join community c on c.uri = s.community
    where s.community = ${community} ${after} ${gated}
      and ${sql.raw(inGoodStanding('s.did'))}
      and not exists (select 1 from community_hide h where h.community = c.uri and h.subject = s.post and ${sql.raw(isStaff('h.did'))})
    order by s.indexedAt desc, s.uri desc limit ${limit}`.execute(db)
  const last = rows.at(-1)
  return {
    feed: rows.map((r) => ({
      post: r.post,
      submission: r.uri,
      author: r.did,
      indexedAt: r.indexedAt,
    })),
    cursor:
      last && rows.length === limit
        ? `${last.indexedAt}::${last.uri}`
        : undefined,
  }
}

/**
 * Communities an account owns, moderates or joined, the most recent first;
 * the cursor is an offset
 */
export async function listAccountCommunities(
  db: Database,
  did: string,
  limit: number,
  cursor?: string,
): Promise<{ uris: string[]; cursor?: string }> {
  const offset = parseOffset(cursor)
  const { rows } = await sql<{ uri: string }>`select x.uri as uri from (
      select o.uri as uri, o.indexedAt as at from community o where o.did = ${did}
      union all
      select mo.community, mo.createdAt from community_moderator mo join community o on o.uri = mo.community and o.did = mo.did where mo.subject = ${did}
      union all
      select m.community, m.indexedAt from community_membership m where m.did = ${did}
    ) x join community c on c.uri = x.uri and ${sql.raw(notHidden('c.did'))}
    group by x.uri order by max(x.at) desc, x.uri desc limit ${limit} offset ${offset}`.execute(
    db,
  )
  return {
    uris: rows.map((r) => r.uri),
    cursor: rows.length === limit ? String(offset + rows.length) : undefined,
  }
}

/** What an account wrote about communities, for its data export */
export async function exportCommunityData(db: Database, did: string) {
  const limit = 10_000
  const actions = async (table: (typeof ACTION_TABLES)[ActionCollection]) =>
    db
      .selectFrom(table)
      .select(['uri', 'community', 'subject', 'reason', 'createdAt'])
      .where('did', '=', did)
      .limit(limit)
      .execute()
  return {
    communitiesOwned: await db
      .selectFrom('community')
      .select([
        'uri',
        'slug',
        'name',
        'description',
        'rules',
        'access',
        'chatJoinLink',
        'createdAt',
      ])
      .where('did', '=', did)
      .execute()
      .then((rows) =>
        rows.map((r) => ({
          ...r,
          rules: JSON.parse(r.rules) as unknown,
          access: JSON.parse(r.access) as unknown,
        })),
      ),
    communityMemberships: await db
      .selectFrom('community_membership')
      .select(['uri', 'community', 'eligible', 'reason', 'createdAt'])
      .where('did', '=', did)
      .limit(limit)
      .execute()
      .then((rows) =>
        rows.map((r) => ({
          ...r,
          eligible: r.eligible === null ? null : r.eligible === 1,
        })),
      ),
    communitySubmissions: await db
      .selectFrom('community_submission')
      .select(['uri', 'community', 'post', 'createdAt'])
      .where('did', '=', did)
      .limit(limit)
      .execute(),
    communityModerators: await actions('community_moderator'),
    communityApprovals: await actions('community_approval'),
    communityBans: await actions('community_ban'),
    communityHides: await actions('community_hide'),
  }
}
