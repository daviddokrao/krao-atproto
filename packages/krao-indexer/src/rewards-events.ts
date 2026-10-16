import type { Kysely } from 'kysely'
import type { Database, DatabaseSchema } from './db.js'

/*
 * Account events the rewards service rewards (M32): an account's first
 * verified wallet and its first post; and (M33) its first accepted
 * membership of a community it does not own (with 3 other members), its
 * first verified tip, and each day it was active. Queued in `rewards_outbox`
 * (once per account and event: the row stays, sent, so unlinking and
 * relinking or deleting and posting again queues nothing new; activity once
 * per account and day) and delivered to the rewards service's
 * /internal/events with retries. The rewards service is idempotent too
 * (event id `<type>:<did>`, activity days kept once).
 */

export type AccountEvent =
  'wallet.linked' | 'post.first' | 'community.joined' | 'tip.first'
export type OutboxEvent = AccountEvent | 'activity.day'

/** Asia/Ho_Chi_Minh is UTC+7 all year */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000

/** The day (YYYY-MM-DD, Vietnam time) holding `at` */
export function vnDay(at: number | string | Date): string {
  const ms = typeof at === 'number' ? at : +new Date(at)
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10)
}

/** Sent activity days are dropped from the outbox after this long */
const ACTIVITY_RETENTION_MS = 40 * 24 * 60 * 60 * 1000

/** Retry delays grow from 5 seconds to at most an hour */
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60 * 60 * 1000

export interface RewardsEventSender {
  /** Throws when the event was not taken; `day` for activity.day */
  send(type: OutboxEvent, did: string, day?: string): Promise<void>
}

export class RewardsEventsClient implements RewardsEventSender {
  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(type: OutboxEvent, did: string, day?: string) {
    const res = await this.fetchFn(new URL('/internal/events', this.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(day ? { type, did, day } : { type, did }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`rewards events: HTTP ${res.status}`)
  }
}

/** Queues the event unless it was queued before; true when queued now */
export async function queueAccountEvent(
  db: Kysely<DatabaseSchema>,
  type: AccountEvent,
  did: string,
): Promise<boolean> {
  const at = new Date().toISOString()
  const result = await db
    .insertInto('rewards_outbox')
    .values({
      id: `${type}:${did}`,
      type,
      did,
      day: null,
      createdAt: at,
      sentAt: null,
      attempts: 0,
      nextAttemptAt: at,
      error: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .executeTakeFirst()
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0
}

/**
 * Queues the day (Vietnam time) of `at` as a day `did` was active, unless
 * queued before; true when queued now
 */
export async function queueActivityDay(
  db: Kysely<DatabaseSchema>,
  did: string,
  at: number | string,
): Promise<boolean> {
  const day = vnDay(at)
  const now = new Date().toISOString()
  const result = await db
    .insertInto('rewards_outbox')
    .values({
      id: `activity.day:${did}:${day}`,
      type: 'activity.day',
      did,
      day,
      createdAt: now,
      sentAt: null,
      attempts: 0,
      nextAttemptAt: now,
      error: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .executeTakeFirst()
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0
}

/**
 * Drops activity days sent long ago: unlike the once-per-account events,
 * they pile up daily, and the rewards service keeps its own copy
 */
export async function pruneSentActivityDays(db: Database, now = Date.now()) {
  await db
    .deleteFrom('rewards_outbox')
    .where('type', '=', 'activity.day')
    .where('sentAt', 'is not', null)
    .where('sentAt', '<', new Date(now - ACTIVITY_RETENTION_MS).toISOString())
    .execute()
}

/**
 * Queues `did`'s wallet.linked event for `wallet` (its EVM address, or its
 * account id on other chains), unless the account was rewarded before or
 * the wallet already earned an account its reward (it was unlinked and
 * linked again elsewhere). True when queued now.
 */
export async function queueWalletLinked(
  db: Database,
  did: string,
  wallet: string,
): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    const used = await tx
      .selectFrom('rewarded_wallet')
      .select('wallet')
      .where('wallet', '=', wallet)
      .executeTakeFirst()
    if (used) return false
    if (!(await queueAccountEvent(tx, 'wallet.linked', did))) return false
    await tx
      .insertInto('rewarded_wallet')
      .values({ wallet, createdAt: new Date().toISOString() })
      .onConflict((oc) => oc.column('wallet').doNothing())
      .execute()
    return true
  })
}

/** Sends the queued events that are due; failures wait longer each time */
export async function deliverAccountEvents(
  db: Database,
  sender: RewardsEventSender,
  now = Date.now(),
  limit = 100,
) {
  const rows = await db
    .selectFrom('rewards_outbox')
    .selectAll()
    .where('sentAt', 'is', null)
    .where('nextAttemptAt', '<=', new Date(now).toISOString())
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .execute()
  for (const row of rows) {
    try {
      await sender.send(row.type, row.did, row.day ?? undefined)
      await db
        .updateTable('rewards_outbox')
        .set({ sentAt: new Date().toISOString(), error: null })
        .where('id', '=', row.id)
        .execute()
    } catch (err) {
      const delay = Math.min(RETRY_BASE_MS * 2 ** row.attempts, RETRY_MAX_MS)
      await db
        .updateTable('rewards_outbox')
        .set({
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(now + delay).toISOString(),
          error: String((err as Error)?.message ?? err).slice(0, 500),
        })
        .where('id', '=', row.id)
        .execute()
    }
  }
}

export async function deleteAccountEventsForDid(db: Database, did: string) {
  await db.deleteFrom('rewards_outbox').where('did', '=', did).execute()
}
