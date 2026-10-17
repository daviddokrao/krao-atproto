import { parseAccountId } from '@krao/wallet'
import { type EvmRpc, parseAssetId } from './chain.js'
import { type Database, type TipTable, visibleDid } from './db.js'
import { txUsedByPayment } from './membership.js'
import { ownedEvmAddresses } from './wallets.js'

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
    anonymous: value.anonymous === true ? 1 : 0,
    status: 'pending',
    nextCheckAt: null,
    pendingSince: now,
    reason: null,
    createdAt: str(value.createdAt) ?? now,
    indexedAt: now,
  }
}

export async function upsertTip(db: Database, row: TipTable) {
  // indexedAt stays the first time the tip was seen: it orders claims on one
  // transaction. The pending timeout runs from pendingSince, the last write
  const { indexedAt: _first, ...update } = row
  await db
    .insertInto('tip')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(update))
    .execute()
}

/** Checks of a pending tip slow down as it ages: 5s, then up to 5 min */
function nextCheck(indexedAt: string, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(indexedAt))
  const delay = Math.min(5 * 60_000, Math.max(5_000, age / 10))
  return new Date(now + delay).toISOString()
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
    Date.now() - Date.parse(tip.pendingSince ?? tip.indexedAt) >
      PENDING_TIMEOUT_MS
      ? 'invalid'
      : result.status
  const reason = 'reason' in result ? result.reason : null
  try {
    await db
      .updateTable('tip')
      .set({
        status,
        reason,
        nextCheckAt:
          status === 'pending'
            ? nextCheck(tip.pendingSince ?? tip.indexedAt)
            : null,
      })
      .where('uri', '=', tip.uri)
      .execute()
  } catch (err) {
    // tip_tx_verified_idx: another tip was verified for this tx meanwhile
    if (status !== 'verified' || !isUniqueViolation(err)) throw err
    await db
      .updateTable('tip')
      .set({
        status: 'invalid',
        reason: 'Transaction already used by another tip',
      })
      .where('uri', '=', tip.uri)
      .execute()
    return 'invalid'
  }
  return status
}

function isUniqueViolation(err: unknown) {
  return String((err as { code?: unknown })?.code).startsWith(
    'SQLITE_CONSTRAINT',
  )
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
  // Without the sender wallet anyone could claim someone else's transfer
  if (!tip.fromAccount) {
    return { status: 'invalid', reason: 'Missing sender wallet' }
  }

  let to: string
  let from: string
  try {
    const toAccount = parseAccountId(tip.toAccount)
    const fromAccount = parseAccountId(tip.fromAccount)
    if (
      toAccount.chainId !== asset.chainId ||
      fromAccount.chainId !== asset.chainId
    ) {
      return { status: 'invalid', reason: 'Wallet is on another chain' }
    }
    to = toAccount.address
    from = fromAccount.address
  } catch {
    return { status: 'invalid', reason: 'Invalid wallet account id' }
  }

  // The tip must go from a wallet the sender has verifiably linked to one the
  // recipient has. EVM addresses are the same on every EVM chain, so any
  // eip155 link counts.
  if (!(await hasLinkedEvmWallet(db, tip.recipient, to))) {
    return { status: 'invalid', reason: 'Recipient wallet is not linked' }
  }
  // The app only tips from a linked wallet, so this is someone else's transfer
  if (!(await hasLinkedEvmWallet(db, tip.did, from))) {
    return { status: 'invalid', reason: 'Sender wallet is not linked' }
  }

  // One transaction can only back one tip, and the earliest claim goes first:
  // a later record waits until an earlier pending one is settled. Only claims
  // naming the same sender on the same chain count, since no other claim can
  // ever verify; otherwise anyone could hold a tip back with a bogus claim.
  const claims = await db
    .selectFrom('tip')
    .select(['uri', 'status', 'indexedAt', 'fromAccount'])
    .where('txHash', '=', tip.txHash)
    .where('uri', '!=', tip.uri)
    .where('status', '!=', 'invalid')
    .execute()
  if (claims.some((c) => c.status === 'verified')) {
    return {
      status: 'invalid',
      reason: 'Transaction already used by another tip',
    }
  }
  // Nor can it back a tip and a membership payment (see membership.ts)
  if (await txUsedByPayment(db, tip.txHash)) {
    return {
      status: 'invalid',
      reason: 'Transaction already used by a membership payment',
    }
  }
  const earlier = claims.some(
    (c) =>
      sameSender(c.fromAccount, asset.chainId, from) &&
      (c.indexedAt < tip.indexedAt ||
        (c.indexedAt === tip.indexedAt && c.uri < tip.uri)),
  )
  if (earlier) {
    return { status: 'pending', reason: 'Another tip claims this transaction' }
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

function sameSender(
  fromAccount: string | null,
  chainId: string,
  address: string,
) {
  if (!fromAccount) return false
  try {
    const account = parseAccountId(fromAccount)
    return (
      account.chainId === chainId &&
      account.address.toLowerCase() === address.toLowerCase()
    )
  } catch {
    return false
  }
}

async function hasLinkedEvmWallet(db: Database, did: string, address: string) {
  return (await ownedEvmAddresses(db, did)).has(address.toLowerCase())
}

/** Pending tips among `uris` */
export async function getTipsByUri(db: Database, uris: string[]) {
  if (!uris.length) return []
  return db
    .selectFrom('tip')
    .selectAll()
    .where('uri', 'in', uris)
    .where('status', '=', 'pending')
    .execute()
}

/** Pending tips due for another check, the most overdue first */
export async function getPendingTips(db: Database, now = Date.now()) {
  return db
    .selectFrom('tip')
    .selectAll()
    .where('status', '=', 'pending')
    .where((eb) =>
      eb.or([
        eb('nextCheckAt', 'is', null),
        eb('nextCheckAt', '<=', new Date(now).toISOString()),
      ]),
    )
    .orderBy('nextCheckAt', 'asc')
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
    .where(visibleDid('did'))
    .where(visibleDid('recipient'))
    .selectAll()
    // Only verified tips are public: a pending one may never confirm, and its
    // message would be free spam
    .where('status', '=', 'verified')
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
    .where(visibleDid('did'))
    .where(visibleDid('recipient'))
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
    .where(visibleDid('did'))
    .where(visibleDid('recipient'))
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
    .where(visibleDid('did'))
    .where(visibleDid('recipient'))
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
    .where(visibleDid('did'))
    .where(visibleDid('recipient'))
    .select(['did'])
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('did', 'in', dids)
    .where('status', '=', 'verified')
    .groupBy('did')
    .execute()
  return new Map(rows.map((r) => [r.did, Number(r.count)]))
}
