import { parseAccountId } from '@krao/wallet'
import { type EvmRpc, parseAssetId } from './chain.js'
import type { Database, TipTable } from './db.js'

export const TIP_COLLECTION = 'net.krao.feed.tip'

/** Pending tips are re-checked until they are this old, then given up on. */
const PENDING_TIMEOUT_MS = 60 * 60 * 1000

/** Turn an net.krao.feed.tip record into a pending row. */
export function tipRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): TipTable {
  const now = new Date().toISOString()
  const value = (record ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const subject = value.subject as { uri?: unknown } | undefined
  return {
    uri,
    did,
    recipient: str(value.recipient) ?? '',
    subject: str(subject?.uri),
    asset: str(value.asset) ?? '',
    amount: str(value.amount) ?? '0',
    txHash: (str(value.txHash) ?? '').toLowerCase(),
    fromAccount: str(value.from),
    toAccount: str(value.to),
    message: str(value.message),
    status: 'pending',
    reason: null,
    createdAt: str(value.createdAt) ?? now,
    indexedAt: now,
  }
}

export async function upsertTip(db: Database, row: TipTable) {
  await db
    .insertInto('tip')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(row))
    .execute()
}

export async function deleteTip(db: Database, uri: string) {
  await db.deleteFrom('tip').where('uri', '=', uri).execute()
}

export async function deleteTipsForDid(db: Database, did: string) {
  await db.deleteFrom('tip').where('did', '=', did).execute()
}

/**
 * Verify a tip on-chain and store the result. Returns the new status.
 */
export async function verifyTip(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  tip: TipTable,
): Promise<TipTable['status']> {
  const result = await checkTip(db, rpcs, tip)
  const status =
    result.status === 'pending' &&
    Date.now() - Date.parse(tip.indexedAt) > PENDING_TIMEOUT_MS
      ? 'invalid'
      : result.status
  const reason = 'reason' in result ? result.reason : null
  await db
    .updateTable('tip')
    .set({ status, reason })
    .where('uri', '=', tip.uri)
    .execute()
  return status
}

async function checkTip(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  tip: TipTable,
): Promise<
  { status: 'verified' } | { status: 'pending' | 'invalid'; reason: string }
> {
  const asset = parseAssetId(tip.asset)
  if (!asset) return { status: 'invalid', reason: 'Unsupported asset' }
  if (!/^[0-9]{1,78}$/.test(tip.amount) || BigInt(tip.amount) === 0n) {
    return { status: 'invalid', reason: 'Invalid amount' }
  }
  if (!tip.toAccount) {
    return { status: 'invalid', reason: 'Missing recipient wallet' }
  }

  let to: string
  let from: string | undefined
  try {
    const toAccount = parseAccountId(tip.toAccount)
    if (toAccount.chainId !== asset.chainId) {
      return {
        status: 'invalid',
        reason: 'Recipient wallet is on another chain',
      }
    }
    to = toAccount.address
    from = tip.fromAccount ? parseAccountId(tip.fromAccount).address : undefined
  } catch {
    return { status: 'invalid', reason: 'Invalid wallet account id' }
  }

  // The tip must go to a wallet the recipient has verifiably linked. EVM
  // addresses are the same on every EVM chain, so any eip155 link counts.
  const recipientWallets = await db
    .selectFrom('wallet')
    .select('account')
    .where('did', '=', tip.recipient)
    .where('status', '=', 'verified')
    .execute()
  const linked = recipientWallets.some(
    (w) =>
      w.account.startsWith('eip155:') &&
      w.account.split(':')[2] === to.toLowerCase(),
  )
  if (!linked) {
    return { status: 'invalid', reason: 'Recipient wallet is not linked' }
  }

  // One transaction can only back one tip
  const reused = await db
    .selectFrom('tip')
    .select('uri')
    .where('txHash', '=', tip.txHash)
    .where('uri', '!=', tip.uri)
    .where('status', '=', 'verified')
    .executeTakeFirst()
  if (reused) {
    return {
      status: 'invalid',
      reason: 'Transaction already used by another tip',
    }
  }

  const rpc = rpcs.get(asset.chainId)
  if (!rpc) return { status: 'pending', reason: `No RPC for ${asset.chainId}` }
  try {
    return await rpc.checkTransfer({
      asset,
      txHash: tip.txHash,
      from,
      to,
      amount: BigInt(tip.amount),
    })
  } catch (err) {
    return { status: 'pending', reason: `RPC error: ${(err as Error).message}` }
  }
}

export async function getPendingTips(db: Database) {
  return db
    .selectFrom('tip')
    .selectAll()
    .where('status', '=', 'pending')
    .orderBy('indexedAt', 'asc')
    .limit(100)
    .execute()
}

export async function listTips(
  db: Database,
  where: { subject: string } | { recipient: string },
  limit: number,
  cursor?: string,
) {
  let qb = db
    .selectFrom('tip')
    .selectAll()
    .where('status', '!=', 'invalid')
    .orderBy('createdAt', 'desc')
    .orderBy('uri', 'desc')
    .limit(limit)
  qb =
    'subject' in where
      ? qb.where('subject', '=', where.subject)
      : qb.where('recipient', '=', where.recipient)
  if (cursor) qb = qb.where('createdAt', '<', cursor)
  return qb.execute()
}

/** Sums of verified tips per asset */
export async function tipTotals(
  db: Database,
  where: { subject: string } | { recipient: string },
) {
  let qb = db
    .selectFrom('tip')
    .select(['asset', 'amount'])
    .where('status', '=', 'verified')
  qb =
    'subject' in where
      ? qb.where('subject', '=', where.subject)
      : qb.where('recipient', '=', where.recipient)
  const rows = await qb.execute()
  const totals = new Map<string, { amount: bigint; count: number }>()
  for (const row of rows) {
    const t = totals.get(row.asset) ?? { amount: 0n, count: 0 }
    t.amount += BigInt(row.amount)
    t.count += 1
    totals.set(row.asset, t)
  }
  return [...totals].map(([asset, t]) => ({
    asset,
    amount: t.amount.toString(),
    count: t.count,
  }))
}

/** Sums of verified tips per asset for each post that has any */
export async function tipTotalsForSubjects(db: Database, subjects: string[]) {
  if (!subjects.length) return []
  const rows = await db
    .selectFrom('tip')
    .select(['subject', 'asset', 'amount'])
    .where('subject', 'in', subjects)
    .where('status', '=', 'verified')
    .execute()
  const bySubject = new Map<
    string,
    Map<string, { amount: bigint; count: number }>
  >()
  for (const row of rows) {
    if (!row.subject) continue
    const totals = bySubject.get(row.subject) ?? new Map()
    const t = totals.get(row.asset) ?? { amount: 0n, count: 0 }
    t.amount += BigInt(row.amount)
    t.count += 1
    totals.set(row.asset, t)
    bySubject.set(row.subject, totals)
  }
  return [...bySubject].map(([subject, totals]) => ({
    subject,
    totals: [...totals].map(([asset, t]) => ({
      asset,
      amount: t.amount.toString(),
      count: t.count,
    })),
  }))
}

export async function verifiedTipCounts(db: Database, dids: string[]) {
  if (!dids.length) return new Map<string, number>()
  const rows = await db
    .selectFrom('tip')
    .select(['recipient'])
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('recipient', 'in', dids)
    .where('status', '=', 'verified')
    .groupBy('recipient')
    .execute()
  return new Map(rows.map((r) => [r.recipient, Number(r.count)]))
}

export async function verifiedTipsSentCounts(db: Database, dids: string[]) {
  if (!dids.length) return new Map<string, number>()
  const rows = await db
    .selectFrom('tip')
    .select(['did'])
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('did', 'in', dids)
    .where('status', '=', 'verified')
    .groupBy('did')
    .execute()
  return new Map(rows.map((r) => [r.did, Number(r.count)]))
}
