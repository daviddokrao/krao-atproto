import type { Database } from './db.js'

/*
 * Account events the rewards service rewards (M32): an account's first
 * verified wallet and its first post. Queued in `rewards_outbox` (once per
 * account and event: the row stays, sent, so unlinking and relinking or
 * deleting and posting again queues nothing new) and delivered to the
 * rewards service's /internal/events with retries. The rewards service is
 * idempotent too (event id `<type>:<did>`).
 */

export type AccountEvent = 'wallet.linked' | 'post.first'

/** Retry delays grow from 5 seconds to at most an hour */
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60 * 60 * 1000

export interface RewardsEventSender {
  /** Throws when the event was not taken */
  send(type: AccountEvent, did: string): Promise<void>
}

export class RewardsEventsClient implements RewardsEventSender {
  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(type: AccountEvent, did: string) {
    const res = await this.fetchFn(new URL('/internal/events', this.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ type, did }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`rewards events: HTTP ${res.status}`)
  }
}

/** Queues the event unless it was queued before; true when queued now */
export async function queueAccountEvent(
  db: Database,
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
      await sender.send(row.type, row.did)
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
