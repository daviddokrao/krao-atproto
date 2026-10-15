import pg from 'pg'
import {
  PREFERENCE_KEY,
  type Profile,
  SHOWS_RECORD,
  SHOWS_SUBJECT,
  excerpt,
  nameOf,
  socialTitle,
} from './compose.js'
import { getState, setState } from './db.js'
import type { PushService } from './service.js'

/** Public reads from the AppView, to name people and quote posts */
export class AppviewClient {
  constructor(
    private url: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async get<T>(nsid: string, params: [string, string][]) {
    const qs = new URLSearchParams(params)
    const res = await this.fetchFn(`${this.url}/xrpc/${nsid}?${qs}`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`${nsid} failed: ${res.status}`)
    return (await res.json()) as T
  }

  /** Profiles by DID; accounts the AppView hides are left out */
  async profiles(dids: string[]): Promise<Map<string, Profile>> {
    const out = new Map<string, Profile>()
    const unique = [...new Set(dids)]
    for (let i = 0; i < unique.length; i += 25) {
      const { profiles } = await this.get<{ profiles: Profile[] }>(
        'app.bsky.actor.getProfiles',
        unique.slice(i, i + 25).map((d) => ['actors', d]),
      )
      for (const p of profiles) out.set(p.did, p)
    }
    return out
  }

  /** Post text by URI */
  async postTexts(uris: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unique = [...new Set(uris)]
    for (let i = 0; i < unique.length; i += 25) {
      const { posts } = await this.get<{
        posts: { uri: string; record: { text?: string } }[]
      }>(
        'app.bsky.feed.getPosts',
        unique.slice(i, i + 25).map((u) => ['uris', u]),
      )
      for (const p of posts) out.set(p.uri, p.record?.text ?? '')
    }
    return out
  }
}

type NotificationRow = {
  id: number
  did: string
  recordUri: string
  author: string
  reason: string
  reasonSubject: string | null
  sortAt: string
}

/** Rows read again on each poll, for inserts that committed out of order */
const REREAD_WINDOW = 200
const BATCH = 500
/** Older notifications (backfills, a long outage) are not pushed */
const MAX_AGE_MS = 15 * 60 * 1000

/**
 * Turns the AppView's notifications into pushes. The AppView writes them to
 * its Postgres `notification` table as it indexes the firehose; this reads
 * that table by id, applies the recipient's push preferences, blocks and
 * mutes, and sends. Bluesky does this in its closed dataplane and courier.
 */
export class AppviewNotifications {
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private pool: pg.Pool,
    private push: PushService,
    private appview: AppviewClient,
    private pollMs = 1000,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), this.pollMs)
  }

  async destroy() {
    clearInterval(this.timer)
    await this.pool.end()
  }

  private async tick() {
    if (this.running) return
    this.running = true
    try {
      await this.poll()
    } catch (err) {
      console.error('krao-push: reading AppView notifications failed', err)
    } finally {
      this.running = false
    }
  }

  /** Reads and pushes new notifications; returns how many were pushed */
  async poll(now = Date.now()): Promise<number> {
    const stored = await getState(this.push.db, 'appview.maxId')
    if (stored === undefined) {
      // First run: start from now, not from the whole history
      const res = await this.pool.query<{ max: string | null }>(
        'select max(id) as max from notification',
      )
      await setState(
        this.push.db,
        'appview.maxId',
        String(Number(res.rows[0]?.max ?? 0)),
      )
      return 0
    }
    let maxId = Number(stored)
    let pushed = 0
    for (;;) {
      const res = await this.pool.query<NotificationRow>(
        `select id, did, "recordUri", author, reason, "reasonSubject", "sortAt"
         from notification where id > $1 order by id limit ${BATCH}`,
        [Math.max(0, maxId - REREAD_WINDOW)],
      )
      // Rows already pushed are skipped by claim()
      const rows = res.rows.map((r) => ({ ...r, id: Number(r.id) }))
      pushed += await this.handle(rows, now)
      const top = rows.reduce((m, r) => Math.max(m, r.id), maxId)
      if (top > maxId) {
        maxId = top
        await setState(this.push.db, 'appview.maxId', String(maxId))
      }
      if (rows.length < BATCH) return pushed
    }
  }

  private async handle(rows: NotificationRow[], now: number) {
    // Only recipients with a device, only recent, each row once
    const withDevices = await this.push.hasDevices(rows.map((r) => r.did))
    const todo: NotificationRow[] = []
    for (const r of rows) {
      if (!withDevices.has(r.did)) continue
      if (now - new Date(r.sortAt).getTime() > MAX_AGE_MS) continue
      if (r.did === r.author) continue
      if (!(await this.push.claim(`n:${r.id}`))) continue
      todo.push(r)
    }
    if (!todo.length) return 0
    const allowed = await this.filter(todo)
    const shown = allowed.filter((r) => socialTitle(r.reason, '') !== null)
    if (!shown.length) return 0
    const profiles = await this.appview.profiles(shown.map((r) => r.author))
    const texts = await this.appview.postTexts(
      shown.flatMap((r) =>
        SHOWS_SUBJECT.has(r.reason) && r.reasonSubject
          ? [r.reasonSubject]
          : SHOWS_RECORD.has(r.reason)
            ? [r.recordUri]
            : [],
      ),
    )
    let pushed = 0
    for (const r of shown) {
      const author = profiles.get(r.author)
      // Hidden by the AppView (taken down, deactivated): say nothing
      if (!author && !r.reason.endsWith('verified')) continue
      const title = socialTitle(r.reason, nameOf(author))
      if (!title) continue
      const text = SHOWS_SUBJECT.has(r.reason)
        ? texts.get(r.reasonSubject ?? '')
        : texts.get(r.recordUri)
      const sent = await this.push.deliver(r.did, {
        title,
        body: excerpt(text),
        data: {
          reason: r.reason,
          uri: r.recordUri,
          subject: r.reasonSubject ?? '',
        },
        // A burst of likes on one post replaces itself on the device
        collapseKey: SHOWS_SUBJECT.has(r.reason)
          ? `${r.reason}:${r.reasonSubject}`
          : undefined,
        threadId: r.reason,
      })
      if (sent) pushed++
    }
    return pushed
  }

  /** Drops rows the recipient turned off, or from accounts they block or mute */
  private async filter(rows: NotificationRow[]) {
    const recipients = [...new Set(rows.map((r) => r.did))]
    const authors = [...new Set(rows.map((r) => r.author))]
    const [prefs, blocks, mutes, follows] = await Promise.all([
      this.pool.query<{ actorDid: string; payload: string }>(
        `select "actorDid", payload from private_data
         where namespace = 'app.bsky.notification.defs#preferences'
           and key = 'self' and "actorDid" = any($1)`,
        [recipients],
      ),
      this.pool.query<{ a: string; b: string }>(
        `select creator as a, "subjectDid" as b from actor_block
           where (creator = any($1) and "subjectDid" = any($2))
              or (creator = any($2) and "subjectDid" = any($1))
         union
         select lb.creator as a, li."subjectDid" as b
           from list_block lb join list_item li on li."listUri" = lb."subjectUri"
           where (lb.creator = any($1) and li."subjectDid" = any($2))
              or (lb.creator = any($2) and li."subjectDid" = any($1))`,
        [recipients, authors],
      ),
      this.pool.query<{ a: string; b: string }>(
        `select "mutedByDid" as a, "subjectDid" as b from mute
           where "mutedByDid" = any($1) and "subjectDid" = any($2)
             and not "onlyReposts" and not "onlyQuoteposts"
         union
         select lm."mutedByDid" as a, li."subjectDid" as b
           from list_mute lm join list_item li on li."listUri" = lm."listUri"
           where lm."mutedByDid" = any($1) and li."subjectDid" = any($2)`,
        [recipients, authors],
      ),
      this.pool.query<{ a: string; b: string }>(
        `select creator as a, "subjectDid" as b from follow
           where creator = any($1) and "subjectDid" = any($2)`,
        [recipients, authors],
      ),
    ])
    const pair = (a: string, b: string) => `${a} ${b}`
    const blocked = new Set(blocks.rows.map((r) => pair(r.a, r.b)))
    const muted = new Set(mutes.rows.map((r) => pair(r.a, r.b)))
    const following = new Set(follows.rows.map((r) => pair(r.a, r.b)))
    const prefsByDid = new Map<string, Record<string, unknown>>()
    for (const row of prefs.rows) {
      try {
        prefsByDid.set(row.actorDid, JSON.parse(row.payload))
      } catch {
        // Unreadable preferences: defaults
      }
    }
    return rows.filter((r) => {
      if (
        blocked.has(pair(r.did, r.author)) ||
        blocked.has(pair(r.author, r.did)) ||
        muted.has(pair(r.did, r.author))
      ) {
        return false
      }
      const key = PREFERENCE_KEY[r.reason]
      const pref = key
        ? (prefsByDid.get(r.did)?.[key] as
            | { push?: boolean; include?: string }
            | undefined)
        : undefined
      if (pref?.push === false) return false
      if (pref?.include === 'follows' && !following.has(pair(r.did, r.author))) {
        return false
      }
      return true
    })
  }
}

export function createPool(url: string, schema?: string) {
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  if (schema) {
    if (!/^[a-z_]+$/i.test(schema)) throw new Error('Invalid schema name')
    pool.on('connect', (client) => {
      void client.query(`set search_path to "${schema}",public`)
    })
  }
  return pool
}
