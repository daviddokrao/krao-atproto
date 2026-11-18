import {
  type CompatibleOpOrTombstone,
  type DocumentData,
  def,
  formatDidDoc,
  normalizeOp,
  validateOperationLog,
} from '@did-plc/lib'
import type { Database } from './db.js'
import { type ChainOp, opCid, validateNextOp } from './validate.js'

/*
 * A copy of a PLC directory (Krao's services resolve DIDs here, so a
 * plc.directory outage or block does not take Krao down). Operations come
 * from the source's /export, page by page from a cursor kept in the
 * database, and each is checked (signatures, order, recoveries) with
 * @did-plc/lib before it is taken: a source that serves a forged operation
 * cannot make the mirror serve it. Operations posted through the mirror are
 * passed to the source and taken as soon as the source accepts them. A DID
 * the mirror does not have yet can be fetched from the source on demand.
 */

export type ExportEntry = {
  did: string
  operation: unknown
  cid?: string
  nullified?: boolean
  createdAt: string
  /** Newer directories number their operations */
  seq?: number
}

export type MirrorOptions = {
  /** The PLC directory copied (eg https://plc.directory) */
  source: string
  /** How long to wait between polls once caught up */
  pollMs?: number
  /** Longest wait between retries when the source fails */
  maxBackoffMs?: number
  /** Ask the source for a DID the mirror lacks (default true) */
  fallback?: boolean
  /**
   * Where to start the first time (an ISO time or `seq:<n>`); unset: the
   * whole history
   */
  startAfter?: string
  fetchFn?: typeof fetch
}

/**
 * `skipped`: a later operation of a DID the mirror never had (it started
 * after the DID's creation); the DID is copied whole when first asked for
 */
export type IngestResult = 'added' | 'known' | 'rejected' | 'skipped'

const PAGE_SIZE = 1000

export class PlcMirror {
  readonly source: string
  private pollMs: number
  private maxBackoffMs: number
  private fallback: boolean
  private startAfter?: string
  private fetchFn: typeof fetch
  private queue: Promise<unknown> = Promise.resolve()
  private fetching = new Map<string, Promise<boolean>>()
  private missing = new Map<string, number>()
  private timer?: NodeJS.Timeout
  private stopped = true
  readonly startedAt = Date.now()

  /** Counters and times for /_health */
  stats = {
    added: 0,
    rejected: 0,
    lastPollAt: null as string | null,
    caughtUpAt: null as string | null,
    lastError: null as string | null,
  }

  constructor(
    public db: Database,
    opts: MirrorOptions,
  ) {
    this.source = opts.source.replace(/\/+$/, '')
    this.pollMs = opts.pollMs ?? 5_000
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000
    this.fallback = opts.fallback ?? true
    this.startAfter = opts.startAfter
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** Runs `fn` after every earlier ingest (one DID chain changes at a time) */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  // Reads
  // -----

  /** The DID's operations, oldest first */
  async ops(did: string, includeNullified = false) {
    let query = this.db
      .selectFrom('op')
      .selectAll()
      .where('did', '=', did)
      .orderBy('id', 'asc')
    if (!includeNullified) query = query.where('nullified', '=', 0)
    const rows = await query.execute()
    return rows.map((r) => ({
      did: r.did,
      cid: r.cid,
      operation: JSON.parse(r.operation) as CompatibleOpOrTombstone,
      nullified: !!r.nullified,
      createdAt: r.createdAt,
    }))
  }

  /** The DID's operations, from the source first if the mirror lacks them */
  async opsOrFetch(did: string, includeNullified = false) {
    let ops = await this.ops(did, includeNullified)
    if (!ops.length && this.fallback && (await this.fetchDid(did))) {
      ops = await this.ops(did, includeNullified)
    }
    return ops
  }

  /** The log as the directory serves it (legacy create ops normalized) */
  static log(ops: { operation: CompatibleOpOrTombstone }[]) {
    return ops.map((o) =>
      def.createOpV1.safeParse(o.operation).success
        ? normalizeOp(o.operation as never)
        : o.operation,
    )
  }

  /** The DID's current data, null when tombstoned, undefined when unknown */
  async data(did: string): Promise<DocumentData | null | undefined> {
    const ops = await this.opsOrFetch(did)
    if (!ops.length) return undefined
    return validateOperationLog(
      did,
      ops.map((o) => o.operation),
    )
  }

  async didDoc(did: string) {
    const data = await this.data(did)
    return data ? formatDidDoc(data) : data
  }

  // Taking operations
  // -----------------

  /**
   * Takes one operation if it may follow what the mirror has for its DID;
   * those it undoes (a recovery) are marked nullified
   */
  ingest(entry: ExportEntry): Promise<IngestResult> {
    return this.serialized(() => this.ingestNow(entry))
  }

  private async ingestNow(entry: ExportEntry): Promise<IngestResult> {
    const { did } = entry
    if (typeof did !== 'string' || !did.startsWith('did:plc:')) {
      this.stats.rejected++
      return 'rejected'
    }
    let cid: string
    try {
      cid = await opCid(entry.operation)
    } catch {
      this.stats.rejected++
      return 'rejected'
    }
    if (entry.cid && entry.cid !== cid) {
      // The source names another CID than the operation hashes to
      this.stats.rejected++
      return 'rejected'
    }
    const known = await this.db
      .selectFrom('op')
      .select('id')
      .where('did', '=', did)
      .where('cid', '=', cid)
      .executeTakeFirst()
    if (known) return 'known'
    const history: ChainOp[] = (await this.ops(did)).map((o) => ({
      cid: o.cid,
      operation: o.operation,
      createdAt: o.createdAt,
    }))
    const prev = (entry.operation as { prev?: unknown } | null)?.prev
    if (!history.length && prev) return 'skipped'
    const createdAt = isNaN(Date.parse(entry.createdAt))
      ? new Date().toISOString()
      : new Date(entry.createdAt).toISOString()
    let nullified: string[]
    try {
      ;({ nullified } = await validateNextOp(
        did,
        history,
        entry.operation,
        createdAt,
      ))
    } catch (err) {
      this.stats.rejected++
      console.warn(
        `Krao PLC mirror: rejected an operation for ${did} (${cid}): ${(err as Error)?.message ?? err}`,
      )
      return 'rejected'
    }
    await this.db.transaction().execute(async (tx) => {
      if (nullified.length) {
        await tx
          .updateTable('op')
          .set({ nullified: 1 })
          .where('did', '=', did)
          .where('cid', 'in', nullified)
          .execute()
      }
      await tx
        .insertInto('op')
        .values({
          did,
          cid,
          operation: JSON.stringify(entry.operation),
          nullified: 0,
          createdAt,
          receivedAt: new Date().toISOString(),
        })
        .execute()
    })
    this.missing.delete(did)
    this.stats.added++
    return 'added'
  }

  /**
   * Copies a DID the mirror lacks from the source's audit log (once at a
   * time per DID; misses are remembered for 2 seconds). True when it has it.
   */
  fetchDid(did: string): Promise<boolean> {
    const missedAt = this.missing.get(did)
    if (missedAt && Date.now() - missedAt < 2_000) return Promise.resolve(false)
    let pending = this.fetching.get(did)
    if (!pending) {
      pending = this.fetchDidNow(did).finally(() => this.fetching.delete(did))
      this.fetching.set(did, pending)
    }
    return pending
  }

  private async fetchDidNow(did: string): Promise<boolean> {
    if (!did.startsWith('did:plc:')) return false
    let entries: ExportEntry[]
    try {
      const res = await this.fetchFn(
        `${this.source}/${encodeURIComponent(did)}/log/audit`,
        { signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) {
        this.rememberMiss(did)
        return false
      }
      entries = (await res.json()) as ExportEntry[]
    } catch {
      return false
    }
    if (!Array.isArray(entries)) return false
    // Oldest first; nullified ones too, so recoveries replay as they happened
    entries.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    for (const entry of entries) await this.ingest({ ...entry, did })
    const has = (await this.ops(did)).length > 0
    if (!has) this.rememberMiss(did)
    return has
  }

  private rememberMiss(did: string) {
    if (this.missing.size > 10_000) this.missing.clear()
    this.missing.set(did, Date.now())
  }

  /**
   * Passes an operation to the source (POST /:did); once the source takes
   * it, the mirror takes it too. Returns the source's answer.
   */
  async forward(
    did: string,
    body: unknown,
  ): Promise<{ status: number; body: string; contentType: string }> {
    const res = await this.fetchFn(
      `${this.source}/${encodeURIComponent(did)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    )
    const text = await res.text()
    if (res.ok) {
      // The mirror may not have the earlier operations yet
      if (!(await this.ops(did)).length) await this.fetchDid(did)
      await this.ingest({
        did,
        operation: body,
        createdAt: new Date().toISOString(),
      })
    }
    return {
      status: res.status,
      body: text,
      contentType: res.headers.get('content-type') ?? 'text/plain',
    }
  }

  // Following the source
  // --------------------

  async getState(key: string) {
    const row = await this.db
      .selectFrom('state')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst()
    return row?.value
  }

  private async setState(key: string, value: string) {
    await this.db
      .insertInto('state')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute()
  }

  /**
   * Reads one page of the source's export from the cursor and takes it.
   * True when there may be more right away (a full page).
   */
  async pollOnce(): Promise<boolean> {
    const cursor = (await this.getState('cursor')) ?? this.startAfter
    const url = new URL(`${this.source}/export`)
    url.searchParams.set('count', String(PAGE_SIZE))
    if (cursor?.startsWith('seq:')) {
      url.searchParams.set('after', cursor.slice(4))
    } else if (cursor) {
      // Operations of the same millisecond may straddle pages: ask from
      // just before, and skip the ones already taken
      url.searchParams.set(
        'after',
        new Date(Date.parse(cursor) - 1).toISOString(),
      )
    }
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`export: HTTP ${res.status}`)
    const text = await res.text()
    const entries = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ExportEntry)
    let next = cursor
    for (const entry of entries) {
      await this.ingest(entry)
      next =
        typeof entry.seq === 'number'
          ? `seq:${entry.seq}`
          : new Date(entry.createdAt).toISOString()
    }
    const full = entries.length >= PAGE_SIZE
    if (
      full &&
      next &&
      !next.startsWith('seq:') &&
      cursor &&
      !cursor.startsWith('seq:') &&
      Date.parse(next) <= Date.parse(cursor)
    ) {
      // A full page within the cursor's millisecond would come back again
      // forever: step past it. Otherwise the next page starts just before
      // the last time taken (operations of that millisecond may straddle
      // pages), whatever became of the operations.
      next = new Date(Date.parse(cursor) + 1).toISOString()
    }
    if (next && next !== cursor) {
      await this.setState('cursor', next)
    }
    const now = new Date().toISOString()
    this.stats.lastPollAt = now
    this.stats.lastError = null
    if (!full) this.stats.caughtUpAt = now
    return full
  }

  /** Seconds the mirror may be behind the source (null: never caught up) */
  lagSeconds(): number | null {
    if (!this.stats.caughtUpAt) return null
    return Math.max(0, (Date.now() - Date.parse(this.stats.caughtUpAt)) / 1000)
  }

  start() {
    this.stopped = false
    let backoff = 1_000
    const loop = async () => {
      if (this.stopped) return
      let delay = this.pollMs
      try {
        if (await this.pollOnce()) delay = 0
        backoff = 1_000
      } catch (err) {
        this.stats.lastError = String((err as Error)?.message ?? err)
        delay = backoff
        backoff = Math.min(backoff * 2, this.maxBackoffMs)
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => void loop(), delay)
        this.timer.unref()
      }
    }
    void loop()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.queue
  }
}
