import { sql } from 'kysely'
import { AtUri } from '@atproto/syntax'
import type { Database, MiniAppTable } from './db.js'

/*
 * Mini Apps (M34): web apps that run inside Krao, published by developers as
 * net.krao.miniapp.app records. Krao's safety admins review each version:
 *   approved  the record's current CID was approved (and nothing below holds)
 *   pending   new, or changed since its approval (a new CID)
 *   revoked   an admin took it down (any version, until approved again), its
 *             developer's account is taken down or deactivated, or its
 *             domain is on the unsafe domain list (checked on every read)
 *   invalid   the record breaks the rules: not https (outside development),
 *             Krao's own web app origin, unknown permissions or chains
 */

export const MINIAPP_COLLECTION = 'net.krao.miniapp.app'
export const MINIAPP_PERMISSIONS = [
  'identity',
  'wallet',
  'sign',
  'transaction',
] as const
export const MINIAPP_CHAINS = ['eip155:8453']
export const MINIAPP_NAME_MAX = 64
export const MINIAPP_DESCRIPTION_MAX = 300
const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const ICON_MAX_BYTES = 1_000_000

export type MiniAppStatus = 'approved' | 'pending' | 'revoked' | 'invalid'

export type MiniAppRules = {
  /** Development: http://localhost (any port) is allowed too */
  devMode?: boolean
  /** Krao's own web app origins, which Mini Apps may not use */
  webOrigins: string[]
}

export class MiniAppError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
  }
}

/** The origin of a Mini App URL, or why it is not allowed */
export function checkMiniAppUrl(
  raw: string,
  rules: MiniAppRules,
): { origin: string } | { reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { reason: 'url is not a valid URL' }
  }
  if (url.username || url.password) {
    return { reason: 'url may not contain credentials' }
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'http:') {
    if (!(rules.devMode && local)) return { reason: 'url must use https' }
  } else if (url.protocol !== 'https:') {
    return { reason: 'url must use https' }
  } else if (local && !rules.devMode) {
    return { reason: 'url must be a public host' }
  }
  const webOrigins = rules.webOrigins.map((o) => {
    try {
      return new URL(o).origin
    } catch {
      return o
    }
  })
  if (webOrigins.includes(url.origin)) {
    return { reason: "url may not be on Krao's own web app origin" }
  }
  return { origin: url.origin }
}

/** The CID of a blob ref, as the firehose (CID object) or JSON ($link) has it */
function blobCid(blob: unknown): string | null {
  const ref = (blob as { ref?: unknown } | null)?.ref
  if (!ref) return null
  const link = (ref as { $link?: unknown }).$link
  const cid = typeof link === 'string' ? link : String(ref)
  return /^[a-zA-Z0-9]{8,128}$/.test(cid) ? cid : null
}

export type MiniAppRecordRow = Omit<
  MiniAppTable,
  'approvedCid' | 'approvedAt' | 'approvedBy' | 'revokedAt' | 'revokedReason'
>

/**
 * The row for a Mini App record. A record that breaks the rules is still
 * indexed, with the reason, so its developer and clients see why.
 */
export function miniAppRowFromRecord(
  uri: string,
  did: string,
  cid: string,
  record: unknown,
  rules: MiniAppRules,
  now = new Date().toISOString(),
): MiniAppRecordRow {
  const value = (record ?? {}) as Record<string, unknown>
  const problems: string[] = []
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name) problems.push('name is required')
  else if ([...name].length > MINIAPP_NAME_MAX) {
    problems.push(`name is longer than ${MINIAPP_NAME_MAX} characters`)
  }
  const description =
    typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : null
  if (description && [...description].length > MINIAPP_DESCRIPTION_MAX) {
    problems.push(
      `description is longer than ${MINIAPP_DESCRIPTION_MAX} characters`,
    )
  }
  const url = typeof value.url === 'string' ? value.url : ''
  const checked = checkMiniAppUrl(url, rules)
  if ('reason' in checked) problems.push(checked.reason)
  const permissions = Array.isArray(value.permissions)
    ? value.permissions
    : null
  if (!permissions) problems.push('permissions is required')
  else if (
    permissions.some(
      (p) =>
        !(MINIAPP_PERMISSIONS as readonly unknown[]).includes(p) ||
        permissions.indexOf(p) !== permissions.lastIndexOf(p),
    )
  ) {
    problems.push(
      `permissions must be distinct values of ${MINIAPP_PERMISSIONS.join(', ')}`,
    )
  }
  let chains: string[] | null = null
  if (value.chains !== undefined) {
    if (
      !Array.isArray(value.chains) ||
      value.chains.some((c) => !MINIAPP_CHAINS.includes(c as string))
    ) {
      problems.push(`chains may only list ${MINIAPP_CHAINS.join(', ')}`)
    } else {
      chains = [...new Set(value.chains as string[])]
    }
  }
  // An icon of the wrong kind is left out; the app shows a placeholder
  const icon = value.icon as { mimeType?: unknown; size?: unknown } | undefined
  const iconCid = blobCid(icon)
  const iconOk =
    !!iconCid &&
    ICON_TYPES.includes(String(icon?.mimeType)) &&
    (typeof icon?.size !== 'number' || icon.size <= ICON_MAX_BYTES)
  const createdAt =
    typeof value.createdAt === 'string' && !isNaN(Date.parse(value.createdAt))
      ? value.createdAt
      : now
  return {
    uri,
    did,
    cid,
    name: name.slice(0, 640),
    description: description?.slice(0, 3000) ?? null,
    url: url.slice(0, 2048),
    origin: 'origin' in checked ? checked.origin : '',
    iconCid: iconOk ? iconCid : null,
    iconMime: iconOk ? String(icon?.mimeType) : null,
    permissions: JSON.stringify(
      problems.length ? [] : (permissions as string[]),
    ),
    chains: chains ? JSON.stringify(chains) : null,
    invalidReason: problems.length ? problems.join('; ') : null,
    createdAt,
    indexedAt: now,
  }
}

/** Indexes a Mini App record; its review (approval, revocation) is kept */
export async function upsertMiniApp(db: Database, row: MiniAppRecordRow) {
  await db
    .insertInto('miniapp')
    .values({
      ...row,
      approvedCid: null,
      approvedAt: null,
      approvedBy: null,
      revokedAt: null,
      revokedReason: null,
    })
    // The same uri and did: only the content changes
    .onConflict((oc) => oc.column('uri').doUpdateSet(row))
    .execute()
}

export async function deleteMiniApp(db: Database, uri: string) {
  await db.deleteFrom('miniapp').where('uri', '=', uri).execute()
}

export async function deleteMiniAppsForDid(db: Database, did: string) {
  await db.deleteFrom('miniapp').where('did', '=', did).execute()
}

export async function getMiniApp(
  db: Database,
  uri: string,
): Promise<MiniAppTable | undefined> {
  return db
    .selectFrom('miniapp')
    .selectAll()
    .where('uri', '=', uri)
    .executeTakeFirst()
}

export type StatusContext = {
  /** Accounts that are taken down, suspended or deactivated */
  hidden: Set<string>
  /** Whether a URL's domain is on the unsafe domain list */
  isUnsafe: (url: string) => boolean
}

/** The review status of a Mini App, as of now */
export function miniAppStatus(
  row: MiniAppTable,
  ctx: StatusContext,
): { status: MiniAppStatus; revokedReason?: string } {
  if (row.invalidReason) return { status: 'invalid' }
  if (row.revokedAt) {
    return {
      status: 'revoked',
      ...(row.revokedReason ? { revokedReason: row.revokedReason } : {}),
    }
  }
  if (ctx.hidden.has(row.did)) {
    return { status: 'revoked', revokedReason: 'developerTakenDown' }
  }
  if (ctx.isUnsafe(row.url)) {
    return { status: 'revoked', revokedReason: 'unsafeDomain' }
  }
  return {
    status: row.approvedCid === row.cid ? 'approved' : 'pending',
  }
}

/** Which of these accounts are hidden (taken down, deactivated) */
export async function hiddenDids(
  db: Database,
  dids: string[],
): Promise<Set<string>> {
  if (!dids.length) return new Set()
  const rows = await db
    .selectFrom('hidden_actor')
    .select('did')
    .where('did', 'in', [...new Set(dids)])
    .execute()
  return new Set(rows.map((r) => r.did))
}

export type MiniAppViewData = {
  uri: string
  cid: string
  developer: string
  name: string
  description?: string
  url: string
  origin: string
  iconUrl?: string
  permissions: string[]
  chains?: string[]
  status: MiniAppStatus
  revokedReason?: string
  invalidReason?: string
  approvedAt?: string
  indexedAt: string
}

/** The icon through this service's proxy (see miniapp-routes.ts) */
export function miniAppIconUrl(baseUrl: string, row: MiniAppTable) {
  const url = new URL('/miniapp-icon', baseUrl)
  url.searchParams.set('uri', row.uri)
  url.searchParams.set('cid', row.iconCid ?? '')
  return url.toString()
}

export function miniAppView(
  row: MiniAppTable,
  ctx: StatusContext & { baseUrl: string },
): MiniAppViewData {
  const { status, revokedReason } = miniAppStatus(row, ctx)
  return {
    uri: row.uri,
    cid: row.cid,
    developer: row.did,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    url: row.url,
    origin: row.origin,
    ...(row.iconCid ? { iconUrl: miniAppIconUrl(ctx.baseUrl, row) } : {}),
    permissions: JSON.parse(row.permissions) as string[],
    ...(row.chains ? { chains: JSON.parse(row.chains) as string[] } : {}),
    status,
    ...(revokedReason ? { revokedReason } : {}),
    ...(row.invalidReason ? { invalidReason: row.invalidReason } : {}),
    // Only for the version that was approved
    ...(status === 'approved' && row.approvedAt
      ? { approvedAt: row.approvedAt }
      : {}),
    indexedAt: row.indexedAt,
  }
}

const SEP = '::'

function parseCursor(cursor?: string): [string, string] | undefined {
  if (!cursor) return undefined
  const at = cursor.indexOf(SEP)
  if (at < 1) throw new MiniAppError('Malformed cursor', 'InvalidRequest')
  return [cursor.slice(0, at), cursor.slice(at + SEP.length)]
}

/**
 * Approved Mini Apps, most recently approved first. Apps revoked at read
 * time (developer taken down, unsafe domain) are left out of the page.
 */
export async function listApprovedMiniApps(
  db: Database,
  opts: { limit: number; cursor?: string; isUnsafe: (url: string) => boolean },
): Promise<{ rows: MiniAppTable[]; cursor?: string }> {
  const after = parseCursor(opts.cursor)
  let query = db
    .selectFrom('miniapp')
    .selectAll()
    .where('invalidReason', 'is', null)
    .where('revokedAt', 'is', null)
    .where('approvedAt', 'is not', null)
    .where(sql<boolean>`approvedCid = cid`)
    .where(sql<boolean>`did not in (select did from hidden_actor)`)
  if (after) {
    query = query.where((eb) =>
      eb.or([
        eb('approvedAt', '<', after[0]),
        eb.and([eb('approvedAt', '=', after[0]), eb('uri', '<', after[1])]),
      ]),
    )
  }
  const rows = await query
    .orderBy('approvedAt', 'desc')
    .orderBy('uri', 'desc')
    .limit(opts.limit)
    .execute()
  const last = rows.at(-1)
  return {
    rows: rows.filter((row) => !opts.isUnsafe(row.url)),
    cursor:
      rows.length === opts.limit && last
        ? `${last.approvedAt}${SEP}${last.uri}`
        : undefined,
  }
}

/** Mini Apps waiting for review (new or changed), oldest first */
export async function listPendingMiniApps(
  db: Database,
  opts: { limit: number; cursor?: string },
): Promise<{ rows: MiniAppTable[]; cursor?: string }> {
  const after = parseCursor(opts.cursor)
  let query = db
    .selectFrom('miniapp')
    .selectAll()
    .where('invalidReason', 'is', null)
    .where('revokedAt', 'is', null)
    .where(sql<boolean>`(approvedCid is null or approvedCid != cid)`)
    .where(sql<boolean>`did not in (select did from hidden_actor)`)
  if (after) {
    query = query.where((eb) =>
      eb.or([
        eb('indexedAt', '>', after[0]),
        eb.and([eb('indexedAt', '=', after[0]), eb('uri', '>', after[1])]),
      ]),
    )
  }
  const rows = await query
    .orderBy('indexedAt', 'asc')
    .orderBy('uri', 'asc')
    .limit(opts.limit)
    .execute()
  const last = rows.at(-1)
  return {
    rows,
    cursor:
      rows.length === opts.limit && last
        ? `${last.indexedAt}${SEP}${last.uri}`
        : undefined,
  }
}

function normalizeUri(uri: string): string {
  try {
    const parsed = new AtUri(uri)
    if (parsed.collection !== MINIAPP_COLLECTION || !parsed.rkey) {
      throw new Error()
    }
    return parsed.toString()
  } catch {
    throw new MiniAppError('Not a Mini App record', 'NotFound')
  }
}

/**
 * Approves the Mini App at `cid`, which must be its current version; lifts
 * a revocation. Logged in the safety audit log.
 */
export async function approveMiniApp(
  db: Database,
  admin: string,
  input: { uri: string; cid: string },
  isUnsafe: (url: string) => boolean,
  now = new Date().toISOString(),
): Promise<MiniAppTable> {
  const uri = normalizeUri(input.uri)
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('miniapp')
      .selectAll()
      .where('uri', '=', uri)
      .executeTakeFirst()
    if (!row) throw new MiniAppError('Mini App not found', 'NotFound')
    if (row.cid !== input.cid) {
      throw new MiniAppError(
        'The record changed: review its current version',
        'CidMismatch',
      )
    }
    if (row.invalidReason) {
      throw new MiniAppError(
        `The record breaks the rules: ${row.invalidReason}`,
        'InvalidApp',
      )
    }
    if (isUnsafe(row.url)) {
      throw new MiniAppError(
        "The app's domain is on the unsafe domain list",
        'UnsafeDomain',
      )
    }
    await tx
      .updateTable('miniapp')
      .set({
        approvedCid: row.cid,
        approvedAt: now,
        approvedBy: admin,
        revokedAt: null,
        revokedReason: null,
      })
      .where('uri', '=', uri)
      .execute()
    await tx
      .insertInto('safety_audit_log')
      .values({
        adminDid: admin,
        action: 'miniapp.approve',
        domain: uri,
        reason: `cid ${row.cid}`,
        at: now,
      })
      .execute()
    return {
      ...row,
      approvedCid: row.cid,
      approvedAt: now,
      approvedBy: admin,
      revokedAt: null,
      revokedReason: null,
    }
  })
}

/** Takes a Mini App down (every version, until approved again); logged */
export async function revokeMiniApp(
  db: Database,
  admin: string,
  input: { uri: string; reason?: string },
  now = new Date().toISOString(),
): Promise<MiniAppTable> {
  const uri = normalizeUri(input.uri)
  const reason = input.reason?.trim().slice(0, 1000) || null
  return db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('miniapp')
      .selectAll()
      .where('uri', '=', uri)
      .executeTakeFirst()
    if (!row) throw new MiniAppError('Mini App not found', 'NotFound')
    await tx
      .updateTable('miniapp')
      .set({ revokedAt: now, revokedReason: reason })
      .where('uri', '=', uri)
      .execute()
    await tx
      .insertInto('safety_audit_log')
      .values({
        adminDid: admin,
        action: 'miniapp.revoke',
        domain: uri,
        reason,
        at: now,
      })
      .execute()
    return { ...row, revokedAt: now, revokedReason: reason }
  })
}
