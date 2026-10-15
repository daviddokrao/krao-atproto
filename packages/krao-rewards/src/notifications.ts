import type { Database } from './db.js'
import type { PushClient } from './push-client.js'

/**
 * Tells people when their points are approved and when their KYC is decided.
 * Read from the tables after the fact, so pushes never wait on (or roll back
 * with) the transactions that make these changes. Returns the time to read
 * from next; the push service drops repeats, so overlap is harmless.
 */
export async function pushRewardChanges(
  db: Database,
  push: PushClient,
  since: string,
): Promise<string> {
  const now = new Date().toISOString()
  const entries = await db
    .selectFrom('points_entry')
    .select(['id', 'did', 'amount'])
    .where('status', '=', 'approved')
    .where('amount', '>', 0)
    .where('decidedAt', '>=', since)
    .where('decidedAt', '<', now)
    .orderBy('id')
    .execute()
  // One push per person, however many entries vested at once
  const byDid = new Map<string, { points: number; ids: string[] }>()
  for (const e of entries) {
    const sum = byDid.get(e.did) ?? { points: 0, ids: [] }
    sum.points += e.amount
    sum.ids.push(e.id)
    byDid.set(e.did, sum)
  }
  for (const [did, { points, ids }] of byDid) {
    push.notify({
      kind: 'points',
      // Short and unique however many entries vested together
      id: `${did}:${ids[0]}:${ids[ids.length - 1]}:${ids.length}`,
      recipientDid: did,
      points,
    })
  }
  const decided = await db
    .selectFrom('kyc_record')
    .select(['did', 'status', 'updatedAt'])
    .where('status', 'in', ['approved', 'rejected'])
    .where('updatedAt', '>=', since)
    .where('updatedAt', '<', now)
    .execute()
  for (const k of decided) {
    push.notify({
      kind: 'kyc',
      id: `${k.did}:${k.status}:${k.updatedAt}`,
      recipientDid: k.did,
      status: k.status,
    })
  }
  return now
}
