import { isIP } from 'node:net'
import { sql } from 'kysely'
import type { Database, UnsafeDomainSource } from './db.js'
import { readLimited, safeFetch } from './safe-fetch.js'

/*
 * Krao's list of phishing and wallet-draining domains. Three sources:
 *   - list: an open list synced from KRAO_PHISHING_LIST_URL every 6 hours, in
 *     the shape of MetaMask's eth-phishing-detect config.json (blacklist,
 *     whitelist, fuzzylist, tolerance);
 *   - admin: domains Krao's safety admins add (net.krao.safety.admin.*);
 *   - seed: a few obviously malicious .test domains, so dev and e2e have
 *     something to match.
 * A domain covers its subdomains. The list's whitelist wins over list and
 * seed entries (as in eth-phishing-detect), but not over an admin's entry.
 * Posts linking to a listed domain are kept out of Popular and trending.
 */

export const SEED_DOMAINS: { domain: string; reason: string }[] = [
  { domain: 'drainer.test', reason: 'Wallet drainer (test entry)' },
  {
    domain: 'free-airdrop-claim.test',
    reason: 'Fake airdrop claim (test entry)',
  },
  {
    domain: 'wallet-verify.test',
    reason: 'Fake wallet verification (test entry)',
  },
]

/** How often the open list is fetched again */
export const PHISHING_LIST_SYNC_MS = 6 * 60 * 60 * 1000
/** Largest list accepted (MetaMask's is a few MB) */
export const PHISHING_LIST_MAX_BYTES = 32 * 1024 * 1024
/** Most entries taken from the list */
const MAX_LIST_ENTRIES = 1_000_000
/** Why open list entries are listed */
const LIST_REASON = 'Listed as phishing'
/** Most link hosts kept per post */
export const MAX_LINKS_PER_POST = 20

/**
 * The host of a URL (or of a bare host name), lowercase and in punycode, or
 * null when there is none. Any scheme is read like http, so that
 * internationalized names are converted the same way everywhere.
 */
export function normalizeHost(input: string): string | null {
  let text = input.trim()
  if (!text || text.length > 2048) return null
  text = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, 'http://')
    : `http://${text}`
  let host: string
  try {
    host = new URL(text).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return null
  }
  if (host.startsWith('[')) return isIP(host.slice(1, -1)) ? host : null
  if (isIP(host)) return host
  if (host.length > 253 || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(host)) {
    return null
  }
  return host
}

/** The host and its parent domains, most specific first (down to 2 labels) */
export function domainSuffixes(host: string): string[] {
  if (isIP(host) || host.startsWith('[')) return [host]
  const labels = host.split('.')
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) {
    out.push(labels.slice(i).join('.'))
  }
  return out
}

/** Whether the edit distance between `a` and `b` is at most `max` */
export function withinDistance(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      rowMin = Math.min(rowMin, cur[j])
    }
    if (rowMin > max) return false
    prev = cur
  }
  return prev[b.length] <= max
}

export type BlockEntry = { source: UnsafeDomainSource; reason: string | null }

export type LinkVerdict = { unsafe: boolean; domain?: string; reason?: string }

/** Matches hosts against the unsafe domain list (see the top of this file) */
export class DomainMatcher {
  constructor(
    /** Checked in order; admin entries win over the whitelist */
    private blocked: Map<string, BlockEntry>[] = [],
    private allowed: Set<string> = new Set(),
    private fuzzy: string[] = [],
    private tolerance = 0,
  ) {}

  check(host: string): LinkVerdict {
    const parts = domainSuffixes(host)
    const allowed = parts.some((d) => this.allowed.has(d))
    for (const domain of parts) {
      for (const map of this.blocked) {
        const entry = map.get(domain)
        if (entry && (!allowed || entry.source === 'admin')) {
          return { unsafe: true, domain, reason: entry.reason ?? undefined }
        }
      }
    }
    // Lookalikes of well-known crypto sites, compared on the last two labels
    if (!allowed && this.tolerance > 0 && !isIP(host) && host[0] !== '[') {
      const base = parts[parts.length - 1]
      for (const target of this.fuzzy) {
        if (base !== target && withinDistance(base, target, this.tolerance)) {
          return { unsafe: true, domain: base, reason: `Looks like ${target}` }
        }
      }
    }
    return { unsafe: false }
  }

  /** The first unsafe host of `hosts`, if any */
  firstUnsafe(hosts: string[]): (LinkVerdict & { host: string }) | undefined {
    for (const host of hosts) {
      const verdict = this.check(host)
      if (verdict.unsafe) return { ...verdict, host }
    }
    return undefined
  }
}

export type PhishingConfig = {
  blacklist: string[]
  whitelist: string[]
  fuzzylist: string[]
  tolerance: number
}

/** Reads a list in the shape of eth-phishing-detect's config.json */
export function parsePhishingConfig(value: unknown): PhishingConfig {
  const config = value as Record<string, unknown> | null
  if (
    !config ||
    typeof config !== 'object' ||
    !Array.isArray(config.blacklist)
  ) {
    throw new Error('Not a phishing list: no blacklist')
  }
  const hosts = (list: unknown) =>
    Array.isArray(list)
      ? [
          ...new Set(
            list
              .slice(0, MAX_LIST_ENTRIES)
              .map((d) => (typeof d === 'string' ? normalizeHost(d) : null))
              .filter((d): d is string => !!d),
          ),
        ]
      : []
  const tolerance = Number(config.tolerance)
  return {
    blacklist: hosts(config.blacklist),
    whitelist: hosts(config.whitelist),
    fuzzylist: hosts(config.fuzzylist).slice(0, 1000),
    tolerance:
      Number.isInteger(tolerance) && tolerance >= 0 && tolerance <= 3
        ? tolerance
        : 0,
  }
}

/**
 * Hosts a post links to: link facets, external embeds (also under media)
 * and any http(s) URL in its text.
 */
export function postLinkHosts(record: unknown): string[] {
  const value = (record ?? {}) as {
    text?: unknown
    facets?: { features?: { $type?: string; uri?: unknown }[] }[]
    embed?: {
      external?: { uri?: unknown }
      media?: { external?: { uri?: unknown } }
    }
  }
  const urls: unknown[] = []
  for (const facet of value.facets ?? []) {
    for (const feature of facet?.features ?? []) {
      if (feature?.$type === 'app.bsky.richtext.facet#link') {
        urls.push(feature.uri)
      }
    }
  }
  urls.push(value.embed?.external?.uri, value.embed?.media?.external?.uri)
  if (typeof value.text === 'string') {
    for (const match of value.text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      urls.push(match[0])
    }
  }
  const hosts = new Set<string>()
  for (const url of urls) {
    if (typeof url !== 'string') continue
    const host = normalizeHost(url)
    if (host) hosts.add(host)
    if (hosts.size >= MAX_LINKS_PER_POST) break
  }
  return [...hosts]
}

/** Records the hosts a post links to, flagging it when one is unsafe */
export async function setPostLinks(
  db: Database,
  uri: string,
  did: string,
  hosts: string[],
  matcher?: DomainMatcher,
) {
  await db.deleteFrom('post_link').where('uri', '=', uri).execute()
  await db.deleteFrom('unsafe_post').where('uri', '=', uri).execute()
  if (!hosts.length) return
  const at = new Date().toISOString()
  await db
    .insertInto('post_link')
    .values(hosts.map((host) => ({ uri, did, host, indexedAt: at })))
    .execute()
  const hit = matcher?.firstUnsafe(hosts)
  if (hit?.domain) {
    await db
      .insertInto('unsafe_post')
      .values({ uri, did, domain: hit.domain, flaggedAt: at })
      .execute()
  }
}

export async function deletePostLinks(db: Database, uri: string) {
  await db.deleteFrom('post_link').where('uri', '=', uri).execute()
  await db.deleteFrom('unsafe_post').where('uri', '=', uri).execute()
}

/** Flags again every indexed post, after the list changed */
export async function rebuildUnsafePosts(db: Database, matcher: DomainMatcher) {
  const hosts = await db
    .selectFrom('post_link')
    .select('host')
    .distinct()
    .execute()
  const flagged = new Map<string, string>()
  for (const { host } of hosts) {
    const verdict = matcher.check(host)
    if (verdict.unsafe && verdict.domain) flagged.set(host, verdict.domain)
  }
  const at = new Date().toISOString()
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom('unsafe_post').execute()
    for (const [host, domain] of flagged) {
      await tx
        .insertInto('unsafe_post')
        .columns(['uri', 'did', 'domain', 'flaggedAt'])
        .expression((eb) =>
          eb
            .selectFrom('post_link')
            .select([
              'uri',
              'did',
              sql<string>`${domain}`.as('domain'),
              sql<string>`${at}`.as('flaggedAt'),
            ])
            .where('host', '=', host),
        )
        .onConflict((oc) => oc.column('uri').doNothing())
        .execute()
    }
  })
}

export type DomainRow = {
  domain: string
  source: UnsafeDomainSource
  reason: string | null
  addedAt: string
}

export class InvalidDomainError extends Error {}

export type SafetyListOptions = {
  /** KRAO_PHISHING_LIST_URL; without it only seed and admin entries apply */
  listUrl?: string
  maxBytes?: number
  timeoutMs?: number
  syncIntervalMs?: number
  /** Allow a plain http list URL (development only) */
  allowHttp?: boolean
}

/** The unsafe domain list: its sync job, admin changes and the matcher */
export class SafetyList {
  matcher = new DomainMatcher()
  private listBlocked = new Map<string, BlockEntry>()
  private localBlocked = new Map<string, BlockEntry>()
  private allowed = new Set<string>()
  private fuzzy: string[] = []
  private tolerance = 0
  private timer?: NodeJS.Timeout
  private flagging: Promise<void> = Promise.resolve()

  constructor(
    private db: Database,
    private opts: SafetyListOptions = {},
  ) {}

  /** Writes the seed entries and loads the list */
  async init() {
    const at = new Date().toISOString()
    await this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('unsafe_domain')
        .where('source', '=', 'seed')
        .execute()
      await tx
        .insertInto('unsafe_domain')
        .values(
          SEED_DOMAINS.map((s) => ({
            domain: s.domain,
            source: 'seed' as const,
            reason: s.reason,
            addedAt: at,
          })),
        )
        .execute()
    })
    await this.loadList()
    await this.loadLocal()
  }

  /** Syncs the open list now and every 6 hours, when a URL is set */
  start() {
    if (!this.opts.listUrl) return
    const run = () =>
      void this.sync().catch((err: unknown) =>
        console.error('Krao indexer: phishing list sync failed', err),
      )
    run()
    this.timer = setInterval(
      run,
      this.opts.syncIntervalMs ?? PHISHING_LIST_SYNC_MS,
    )
    this.timer.unref?.()
  }

  async destroy() {
    clearInterval(this.timer)
    await this.flagging
  }

  /** Fetches the open list and replaces its entries; returns their count */
  async sync(): Promise<number | null> {
    const url = this.opts.listUrl
    if (!url) return null
    const etag = await this.getState('listEtag')
    const { res } = await safeFetch(url, {
      allowHttp: this.opts.allowHttp,
      timeoutMs: this.opts.timeoutMs ?? 60_000,
      headers: {
        accept: 'application/json',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    })
    if (res.status === 304) {
      await res.body?.cancel()
      await this.setState({ listSyncedAt: new Date().toISOString() })
      return null
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`Phishing list: HTTP ${res.status}`)
    }
    const body = await readLimited(
      res,
      this.opts.maxBytes ?? PHISHING_LIST_MAX_BYTES,
    )
    const config = parsePhishingConfig(JSON.parse(body.toString('utf8')))
    // An empty answer must not wipe the list
    if (!config.blacklist.length) throw new Error('Phishing list is empty')
    await this.replaceList(config, res.headers.get('etag') ?? undefined)
    return config.blacklist.length
  }

  /** Replaces the open list's entries (sync, and tests) */
  async replaceList(config: PhishingConfig, etag?: string) {
    const at = new Date().toISOString()
    await this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('unsafe_domain')
        .where('source', '=', 'list')
        .execute()
      for (let i = 0; i < config.blacklist.length; i += 500) {
        await tx
          .insertInto('unsafe_domain')
          .values(
            config.blacklist.slice(i, i + 500).map((domain) => ({
              domain,
              source: 'list' as const,
              reason: LIST_REASON,
              addedAt: at,
            })),
          )
          .execute()
      }
    })
    await this.setState({
      whitelist: JSON.stringify(config.whitelist),
      fuzzylist: JSON.stringify(config.fuzzylist),
      tolerance: String(config.tolerance),
      listSyncedAt: at,
      ...(etag ? { listEtag: etag } : {}),
    })
    await this.loadList()
    await this.flagPosts()
  }

  check(url: string): LinkVerdict {
    const host = normalizeHost(url)
    return host ? this.matcher.check(host) : { unsafe: false }
  }

  async addDomain(
    adminDid: string,
    input: string,
    reason?: string,
  ): Promise<DomainRow> {
    const domain = normalizeHost(input)
    if (!domain) throw new InvalidDomainError('Not a domain name')
    const row: DomainRow = {
      domain,
      source: 'admin',
      reason: reason?.trim() || null,
      addedAt: new Date().toISOString(),
    }
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('unsafe_domain')
        .values(row)
        .onConflict((oc) =>
          oc
            .columns(['domain', 'source'])
            .doUpdateSet({ reason: row.reason, addedAt: row.addedAt }),
        )
        .execute()
      await tx
        .insertInto('safety_audit_log')
        .values({
          adminDid,
          action: 'domain.add',
          domain,
          reason: row.reason,
          at: row.addedAt,
        })
        .execute()
    })
    await this.loadLocal()
    await this.flagPosts()
    return row
  }

  async removeDomain(adminDid: string, input: string): Promise<boolean> {
    const domain = normalizeHost(input) ?? input.trim().toLowerCase()
    const removed = await this.db.transaction().execute(async (tx) => {
      const res = await tx
        .deleteFrom('unsafe_domain')
        .where('domain', '=', domain)
        .where('source', '=', 'admin')
        .executeTakeFirst()
      if (!Number(res.numDeletedRows)) return false
      await tx
        .insertInto('safety_audit_log')
        .values({
          adminDid,
          action: 'domain.remove',
          domain,
          reason: null,
          at: new Date().toISOString(),
        })
        .execute()
      return true
    })
    if (removed) {
      await this.loadLocal()
      await this.flagPosts()
    }
    return removed
  }

  /** Newest first; the cursor is a rowid */
  async listDomains(opts: {
    source?: string
    query?: string
    limit: number
    cursor?: string
  }) {
    let qb = this.db
      .selectFrom('unsafe_domain')
      .select([
        'domain',
        'source',
        'reason',
        'addedAt',
        sql<number>`rowid`.as('rowid'),
      ])
      .orderBy(sql`rowid`, 'desc')
      .limit(opts.limit)
    if (opts.source) {
      qb = qb.where('source', '=', opts.source as UnsafeDomainSource)
    }
    if (opts.query) {
      const pattern = `%${opts.query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      qb = qb.where(sql<boolean>`domain like ${pattern} escape '\\'`)
    }
    if (opts.cursor) {
      const before = Number(opts.cursor)
      if (!Number.isInteger(before)) throw new Error('Malformed cursor')
      qb = qb.where(sql<boolean>`rowid < ${before}`)
    }
    const rows = await qb.execute()
    return {
      domains: rows.map(({ rowid: _rowid, ...row }) => row as DomainRow),
      cursor:
        rows.length === opts.limit
          ? String(rows[rows.length - 1].rowid)
          : undefined,
    }
  }

  /** Flags indexed posts again with the current list, one run at a time */
  flagPosts(): Promise<void> {
    this.flagging = this.flagging
      .then(() => rebuildUnsafePosts(this.db, this.matcher))
      .catch((err: unknown) =>
        console.error('Krao indexer: flagging unsafe posts failed', err),
      )
    return this.flagging
  }

  private async loadList() {
    const rows = await this.db
      .selectFrom('unsafe_domain')
      .select(['domain', 'reason'])
      .where('source', '=', 'list')
      .execute()
    // One shared entry for the usual reason: the list can be large
    const usual: BlockEntry = { source: 'list', reason: LIST_REASON }
    this.listBlocked = new Map(
      rows.map((r) => [
        r.domain,
        r.reason === LIST_REASON ? usual : { source: 'list', reason: r.reason },
      ]),
    )
    const parse = (value: string | undefined) => {
      try {
        const list = JSON.parse(value ?? '[]')
        return Array.isArray(list) ? (list as string[]) : []
      } catch {
        return []
      }
    }
    this.allowed = new Set(parse(await this.getState('whitelist')))
    this.fuzzy = parse(await this.getState('fuzzylist'))
    this.tolerance = Number((await this.getState('tolerance')) ?? 0) || 0
    this.rebuildMatcher()
  }

  private async loadLocal() {
    const rows = await this.db
      .selectFrom('unsafe_domain')
      .select(['domain', 'source', 'reason'])
      .where('source', 'in', ['admin', 'seed'])
      .execute()
    const local = new Map<string, BlockEntry>()
    for (const row of rows) {
      if (!local.has(row.domain) || row.source === 'admin') {
        local.set(row.domain, { source: row.source, reason: row.reason })
      }
    }
    this.localBlocked = local
    this.rebuildMatcher()
  }

  private rebuildMatcher() {
    this.matcher = new DomainMatcher(
      [this.localBlocked, this.listBlocked],
      this.allowed,
      this.fuzzy,
      this.tolerance,
    )
  }

  private async getState(key: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('safety_state')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return row?.value
  }

  private async setState(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      await this.db
        .insertInto('safety_state')
        .values({ key, value })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
        .execute()
    }
  }
}
