import { type ExpressionBuilder, sql } from 'kysely'
import { AtUri } from '@atproto/syntax'
import type { EvmRpc } from './chain.js'
import {
  type CreatorMemberTable,
  type Database,
  type DatabaseSchema,
  type MembershipPaymentTable,
  type MembershipPlanTable,
  visibleDid,
} from './db.js'
import { BASE_CHAIN, USDC } from './token.js'
import { ownedEvmAddresses } from './wallets.js'

/*
 * Creator memberships. A creator offers plans (net.krao.membership.plan, in
 * their repo); a member pays a plan's price in USDC on Base straight to a
 * wallet the creator linked, then writes a net.krao.membership.payment
 * record naming the transaction. The indexer checks it like a tip: the
 * transfer must come from a wallet the member owns and go to one the creator
 * owns. Krao takes no fee and never holds the money.
 *
 * Each verified payment pays for 30 days: from its block time, or, when the
 * member was still active at that time, from the end of the paid periods.
 * Membership is judged against the chain's clock (see ChainClock), which on
 * Base is the wall clock, so that a dev chain moved forward expires it.
 */

export const PLAN_COLLECTION = 'net.krao.membership.plan'
export const PAYMENT_COLLECTION = 'net.krao.membership.payment'

const DAY_MS = 24 * 60 * 60 * 1000
/** What one payment pays for */
export const PERIOD_MS = 30 * DAY_MS
/** Active plans an account may have; further ones count as inactive */
export const MAX_ACTIVE_PLANS = 3
/** $1 and $1000 in USDC base units */
export const MIN_PRICE_USDC = 1_000_000n
export const MAX_PRICE_USDC = 1_000_000_000n
/** How much older than its record a payment's transaction may be */
export const MAX_TX_AGE_MS = DAY_MS
/** Pending payments are re-checked until they are this old, then refused */
const PENDING_TIMEOUT_MS = 60 * 60 * 1000

export type MembershipStatus = 'active' | 'expired' | 'pending' | 'invalid'

export type MembershipState = {
  creator: string
  member: string
  plan: string
  status: MembershipStatus
  since: string
  expiresAt?: string
  reason?: string
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** Turn a net.krao.membership.plan record into a row; null when malformed */
export function planRowFromRecord(
  uri: string,
  did: string,
  cid: string,
  record: unknown,
): MembershipPlanTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  const name = str(value.name)?.trim()
  const price = str(value.priceUsdc)
  if (!name || name.length > 640) return null
  if (!price || !/^[0-9]{1,13}$/.test(price)) return null
  if (BigInt(price) < MIN_PRICE_USDC || BigInt(price) > MAX_PRICE_USDC) {
    return null
  }
  const description = str(value.description)
  const perks = Array.isArray(value.perks)
    ? value.perks
        .filter((p): p is string => typeof p === 'string' && p.length <= 1000)
        .slice(0, 5)
    : []
  const now = new Date().toISOString()
  return {
    uri,
    did,
    cid,
    name,
    description: description && description.length <= 5000 ? description : null,
    priceUsdc: BigInt(price).toString(),
    perks: JSON.stringify(perks),
    active: value.active === true ? 1 : 0,
    createdAt: str(value.createdAt) ?? now,
    indexedAt: now,
  }
}

export async function upsertPlan(db: Database, row: MembershipPlanTable) {
  if (row.active) {
    const others = await db
      .selectFrom('membership_plan')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('did', '=', row.did)
      .where('active', '=', 1)
      .where('uri', '!=', row.uri)
      .executeTakeFirst()
    if (Number(others?.count ?? 0) >= MAX_ACTIVE_PLANS)
      row = { ...row, active: 0 }
  }
  const { indexedAt: _first, ...update } = row
  await db
    .insertInto('membership_plan')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(update))
    .execute()
}

export async function deletePlan(db: Database, uri: string) {
  await db.deleteFrom('membership_plan').where('uri', '=', uri).execute()
}

/**
 * Turn a net.krao.membership.payment record into a pending row. Null when it
 * names no plan or creator, which no check could ever pass.
 * `publishedAt` is when the record was published (the firehose event time).
 */
export function paymentRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
  publishedAt: string,
): MembershipPaymentTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  const plan = str((value.plan as { uri?: unknown } | undefined)?.uri)
  const creator = str(value.creator)
  if (!plan || !creator?.startsWith('did:')) return null
  try {
    new AtUri(plan)
  } catch {
    return null
  }
  const now = new Date().toISOString()
  return {
    uri,
    did,
    creator,
    plan,
    chain: str(value.chain) ?? '',
    txHash: (str(value.txHash) ?? '').toLowerCase(),
    status: 'pending',
    reason: null,
    amount: null,
    blockTime: null,
    periodStart: null,
    periodEnd: null,
    nextCheckAt: null,
    pendingSince: now,
    publishedAt: Number.isNaN(Date.parse(publishedAt)) ? now : publishedAt,
    createdAt: str(value.createdAt) ?? now,
    indexedAt: now,
  }
}

/** Stores a payment as pending (again); an update takes back what it paid for */
export async function upsertPayment(db: Database, row: MembershipPaymentTable) {
  const old = await db
    .selectFrom('membership_payment')
    .select(['creator', 'did', 'status'])
    .where('uri', '=', row.uri)
    .executeTakeFirst()
  // indexedAt orders claims on one transaction; publishedAt starts the 24h
  // window: both stay the first time the record was seen
  const { indexedAt: _first, publishedAt: _published, ...update } = row
  await db
    .insertInto('membership_payment')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(update))
    .execute()
  if (old?.status === 'verified') {
    await refreshMembership(db, old.creator, old.did)
  }
}

export async function deletePayment(db: Database, uri: string) {
  const old = await db
    .selectFrom('membership_payment')
    .select(['creator', 'did', 'status'])
    .where('uri', '=', uri)
    .executeTakeFirst()
  await db.deleteFrom('membership_payment').where('uri', '=', uri).execute()
  if (old?.status === 'verified') {
    await refreshMembership(db, old.creator, old.did)
  }
}

export async function deleteMembershipDataForDid(db: Database, did: string) {
  await db.deleteFrom('membership_plan').where('did', '=', did).execute()
  await db
    .deleteFrom('membership_payment')
    .where((eb) => eb.or([eb('did', '=', did), eb('creator', '=', did)]))
    .execute()
  await db
    .deleteFrom('creator_member')
    .where((eb) => eb.or([eb('member', '=', did), eb('creator', '=', did)]))
    .execute()
}

/** Whether a verified membership payment already uses the transaction */
export async function txUsedByPayment(db: Database, txHash: string) {
  const row = await db
    .selectFrom('membership_payment')
    .select('uri')
    .where('txHash', '=', txHash.toLowerCase())
    .where('status', '=', 'verified')
    .executeTakeFirst()
  return !!row
}

/**
 * The 30-day periods paid for by verified payments (`time`: block time, ms).
 * A payment made while the member is still active starts where the paid
 * periods end; one made after they ran out starts a new run (`since`).
 */
export function membershipPeriods(payments: { uri: string; time: number }[]) {
  const sorted = [...payments].sort(
    (a, b) => a.time - b.time || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
  )
  const periods: { uri: string; start: number; end: number }[] = []
  let since: number | undefined
  let end: number | undefined
  for (const p of sorted) {
    const renewal = end !== undefined && p.time <= end
    const start = renewal ? (end as number) : p.time
    if (!renewal) since = start
    end = start + PERIOD_MS
    periods.push({ uri: p.uri, start, end })
  }
  if (!periods.length) return undefined
  return {
    periods,
    since: since as number,
    expiresAt: end as number,
    firstAt: periods[0].start,
  }
}

/** Recompute a member's periods and summary from their verified payments */
export async function refreshMembership(
  db: Database,
  creator: string,
  member: string,
) {
  const rows = await db
    .selectFrom('membership_payment')
    .select(['uri', 'blockTime', 'periodStart', 'periodEnd'])
    .where('creator', '=', creator)
    .where('did', '=', member)
    .where('status', '=', 'verified')
    .execute()
  const summary = membershipPeriods(
    rows
      .filter((r) => r.blockTime)
      .map((r) => ({ uri: r.uri, time: Date.parse(r.blockTime as string) })),
  )
  if (!summary) {
    await db
      .deleteFrom('creator_member')
      .where('creator', '=', creator)
      .where('member', '=', member)
      .execute()
    return
  }
  for (const period of summary.periods) {
    const start = new Date(period.start).toISOString()
    const end = new Date(period.end).toISOString()
    const row = rows.find((r) => r.uri === period.uri)
    if (row?.periodStart === start && row.periodEnd === end) continue
    await db
      .updateTable('membership_payment')
      .set({ periodStart: start, periodEnd: end })
      .where('uri', '=', period.uri)
      .execute()
  }
  const value: CreatorMemberTable = {
    creator,
    member,
    since: new Date(summary.since).toISOString(),
    expiresAt: new Date(summary.expiresAt).toISOString(),
    firstAt: new Date(summary.firstAt).toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await db
    .insertInto('creator_member')
    .values(value)
    .onConflict((oc) => oc.columns(['creator', 'member']).doUpdateSet(value))
    .execute()
}

/** Checks of a pending payment slow down as it ages: 5s, then up to 5 min */
function nextCheck(since: string, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(since))
  const delay = Math.min(5 * 60_000, Math.max(5_000, age / 10))
  return new Date(now + delay).toISOString()
}

function isUniqueViolation(err: unknown) {
  return String((err as { code?: unknown })?.code).startsWith(
    'SQLITE_CONSTRAINT',
  )
}

type PaymentCheck =
  | { status: 'verified'; amount: bigint; blockTime: number }
  | { status: 'pending' | 'invalid'; reason: string }

/** Verify a payment on chain and store the result. Returns the new status. */
export async function verifyPayment(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  payment: MembershipPaymentTable,
  now = Date.now(),
): Promise<MembershipPaymentTable['status']> {
  const result = await checkPayment(db, rpcs, payment)
  const pendingFor = now - Date.parse(payment.pendingSince ?? payment.indexedAt)
  const status =
    result.status === 'pending' && pendingFor > PENDING_TIMEOUT_MS
      ? 'invalid'
      : result.status
  const verified = result.status === 'verified' ? result : undefined
  /*
   * Only the record that was checked: the firehose may have rewritten it
   * (another transaction, plan or creator) during the RPC calls. A result
   * stored on the new record would free the checked transaction for reuse;
   * the rewrite is pending again and gets its own check.
   */
  const unchanged = (
    eb: ExpressionBuilder<DatabaseSchema, 'membership_payment'>,
  ) =>
    eb.and([
      eb('uri', '=', payment.uri),
      eb('txHash', '=', payment.txHash),
      eb('plan', '=', payment.plan),
      eb('creator', '=', payment.creator),
      eb('chain', '=', payment.chain),
      eb('status', '=', 'pending'),
    ])
  try {
    const res = await db
      .updateTable('membership_payment')
      .set({
        status,
        reason: 'reason' in result ? result.reason : null,
        amount: verified ? verified.amount.toString() : null,
        blockTime: verified
          ? new Date(verified.blockTime * 1000).toISOString()
          : null,
        periodStart: null,
        periodEnd: null,
        nextCheckAt:
          status === 'pending'
            ? nextCheck(payment.pendingSince ?? payment.indexedAt, now)
            : null,
      })
      .where(unchanged)
      .executeTakeFirst()
    if (!Number(res.numUpdatedRows)) return 'pending'
  } catch (err) {
    // membership_payment_tx_verified_idx: verified for another payment meanwhile
    if (status !== 'verified' || !isUniqueViolation(err)) throw err
    await db
      .updateTable('membership_payment')
      .set({
        status: 'invalid',
        reason: 'Transaction already used by another payment',
        nextCheckAt: null,
      })
      .where(unchanged)
      .execute()
    return 'invalid'
  }
  if (status === 'verified' || payment.status === 'verified') {
    await refreshMembership(db, payment.creator, payment.did)
  }
  return status
}

async function checkPayment(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  payment: MembershipPaymentTable,
): Promise<PaymentCheck> {
  if (payment.chain !== BASE_CHAIN) {
    return { status: 'invalid', reason: 'Unsupported chain' }
  }
  if (!/^0x[0-9a-f]{64}$/.test(payment.txHash)) {
    return { status: 'invalid', reason: 'Malformed transaction hash' }
  }
  if (payment.creator === payment.did) {
    return { status: 'invalid', reason: 'Cannot join your own membership' }
  }
  let planUri: AtUri
  try {
    planUri = new AtUri(payment.plan)
  } catch {
    return { status: 'invalid', reason: 'Invalid plan' }
  }
  if (
    planUri.host !== payment.creator ||
    planUri.collection !== PLAN_COLLECTION
  ) {
    return { status: 'invalid', reason: "Plan is not the creator's" }
  }
  const plan = await db
    .selectFrom('membership_plan')
    .select(['priceUsdc', 'active'])
    .where('uri', '=', payment.plan)
    .executeTakeFirst()
  if (!plan) return { status: 'pending', reason: 'Plan not indexed yet' }
  if (!plan.active) return { status: 'invalid', reason: 'Plan is not active' }

  // One transaction backs one tip or payment. Among payments the earliest
  // claim goes first; only the member's own claims count, since a claim by
  // anyone else names wallets that did not send it and cannot verify.
  const tipped = await db
    .selectFrom('tip')
    .select('uri')
    .where('txHash', '=', payment.txHash)
    .where('status', '=', 'verified')
    .executeTakeFirst()
  if (tipped) {
    return { status: 'invalid', reason: 'Transaction already used by a tip' }
  }
  const claims = await db
    .selectFrom('membership_payment')
    .select(['uri', 'did', 'status', 'indexedAt'])
    .where('txHash', '=', payment.txHash)
    .where('uri', '!=', payment.uri)
    .where('status', '!=', 'invalid')
    .execute()
  if (claims.some((c) => c.status === 'verified')) {
    return {
      status: 'invalid',
      reason: 'Transaction already used by another payment',
    }
  }
  if (
    claims.some(
      (c) =>
        c.did === payment.did &&
        (c.indexedAt < payment.indexedAt ||
          (c.indexedAt === payment.indexedAt && c.uri < payment.uri)),
    )
  ) {
    return {
      status: 'pending',
      reason: 'Another payment claims this transaction',
    }
  }

  const from = await ownedEvmAddresses(db, payment.did)
  if (!from.size) {
    return { status: 'invalid', reason: 'Member has no linked wallet' }
  }
  const to = await ownedEvmAddresses(db, payment.creator)
  if (!to.size) {
    return { status: 'invalid', reason: 'Creator has no linked wallet' }
  }
  const rpc = rpcs.get(BASE_CHAIN)
  if (!rpc) return { status: 'pending', reason: `No RPC for ${BASE_CHAIN}` }
  let transfer: Awaited<ReturnType<EvmRpc['tokenTransfers']>>
  try {
    transfer = await rpc.tokenTransfers({
      contract: USDC,
      txHash: payment.txHash,
      from,
      to,
    })
  } catch (err) {
    return { status: 'pending', reason: `RPC error: ${(err as Error).message}` }
  }
  if (transfer.status !== 'found') return transfer
  if (transfer.amount < BigInt(plan.priceUsdc)) {
    return { status: 'invalid', reason: 'Amount is below the plan price' }
  }
  if (
    transfer.blockTime * 1000 <
    Date.parse(payment.publishedAt) - MAX_TX_AGE_MS
  ) {
    return {
      status: 'invalid',
      reason: 'Transaction is more than 24 hours older than the payment',
    }
  }
  return {
    status: 'verified',
    amount: transfer.amount,
    blockTime: transfer.blockTime,
  }
}

/** Pending payments among `uris` */
export async function getPaymentsByUri(db: Database, uris: string[]) {
  if (!uris.length) return []
  return db
    .selectFrom('membership_payment')
    .selectAll()
    .where('uri', 'in', uris)
    .where('status', '=', 'pending')
    .execute()
}

/** Pending payments due for another check, the most overdue first */
export async function getPendingPayments(db: Database, now = Date.now()) {
  return db
    .selectFrom('membership_payment')
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

/**
 * The time memberships are judged by: the wall clock, or the chain's latest
 * block time when that is ahead (a dev chain moved forward). Block times are
 * read at most every `ttlMs`; without an answer the wall clock counts.
 */
export class ChainClock {
  private last?: { at: number; chainMs: number }
  /** The block time being read, shared by concurrent callers */
  private reading?: Promise<void>

  constructor(
    private rpc?: EvmRpc,
    private ttlMs = 5_000,
  ) {}

  async now(): Promise<number> {
    const wall = Date.now()
    if (!this.rpc) return wall
    if (!this.last || wall - this.last.at > this.ttlMs) {
      this.reading ??= this.read(this.rpc).finally(() => {
        this.reading = undefined
      })
      await this.reading
    }
    const now = Date.now()
    return this.last
      ? Math.max(now, this.last.chainMs + (now - this.last.at))
      : now
  }

  /*
   * A failed read is remembered like an answer (keeping the last known
   * offset), so that while the chain is unreachable each gated read does not
   * wait for its own RPC timeout.
   */
  private async read(rpc: EvmRpc) {
    const at = Date.now()
    try {
      this.last = { at, chainMs: (await rpc.blockTime()) * 1000 }
    } catch {
      const last = this.last
      this.last = {
        at,
        chainMs: last ? last.chainMs + (at - last.at) : at,
      }
    }
  }
}

/**
 * Whether `did` is an active member of `creator` at `now` (and, with
 * `plan`, has a paid period of that plan that has not ended)
 */
export async function isActiveMember(
  db: Database,
  creator: string,
  did: string,
  now: number,
  plan?: string,
): Promise<boolean> {
  const nowIso = new Date(now).toISOString()
  const member = await db
    .selectFrom('creator_member')
    .select('expiresAt')
    .where('creator', '=', creator)
    .where('member', '=', did)
    .where('expiresAt', '>', nowIso)
    .where(visibleDid('creator'))
    .executeTakeFirst()
  if (!member) return false
  if (!plan) return true
  const paid = await db
    .selectFrom('membership_payment')
    .select('uri')
    .where('creator', '=', creator)
    .where('did', '=', did)
    .where('plan', '=', plan)
    .where('status', '=', 'verified')
    .where('periodEnd', '>', nowIso)
    .executeTakeFirst()
  return !!paid
}

/** A creator's plans, the oldest first; inactive ones only with `all` */
export async function getPlans(db: Database, creator: string, all: boolean) {
  let qb = db
    .selectFrom('membership_plan')
    .selectAll()
    .where('did', '=', creator)
    .where(visibleDid('did'))
    .orderBy('createdAt', 'asc')
    .orderBy('uri', 'asc')
  if (!all) qb = qb.where('active', '=', 1)
  return qb.execute()
}

/** Members whose period covering `now` was paid for with each plan */
export async function planMemberCounts(
  db: Database,
  plans: string[],
  now: number,
): Promise<Map<string, number>> {
  if (!plans.length) return new Map()
  const nowIso = new Date(now).toISOString()
  const rows = await db
    .selectFrom('membership_payment')
    .select(['plan'])
    .select(sql<number>`count(distinct did)`.as('count'))
    .where('plan', 'in', plans)
    .where('status', '=', 'verified')
    .where('periodStart', '<=', nowIso)
    .where('periodEnd', '>', nowIso)
    .where(visibleDid('did'))
    .groupBy('plan')
    .execute()
  return new Map(rows.map((r) => [r.plan, Number(r.count)]))
}

/** The membership of `member` with `creator` at `now`; undefined if they never paid */
export async function getMembership(
  db: Database,
  creator: string,
  member: string,
  now: number,
): Promise<MembershipState | undefined> {
  const nowIso = new Date(now).toISOString()
  const [summary, payments] = await Promise.all([
    db
      .selectFrom('creator_member')
      .selectAll()
      .where('creator', '=', creator)
      .where('member', '=', member)
      .executeTakeFirst(),
    db
      .selectFrom('membership_payment')
      .select([
        'plan',
        'status',
        'reason',
        'periodStart',
        'periodEnd',
        'publishedAt',
        'indexedAt',
      ])
      .where('creator', '=', creator)
      .where('did', '=', member)
      .orderBy('indexedAt', 'desc')
      .orderBy('uri', 'desc')
      .execute(),
  ])
  if (!payments.length) return undefined
  const base = { creator, member }
  const reasonOf = (reason: string | null) =>
    reason ? { reason: reason.slice(0, 300) } : {}
  const verified = payments
    .filter((p) => p.status === 'verified' && p.periodStart && p.periodEnd)
    .sort((a, b) => (a.periodStart as string).localeCompare(b.periodStart!))
  if (summary && summary.expiresAt > nowIso && verified.length) {
    const current =
      verified.find(
        (p) => (p.periodStart as string) <= nowIso && nowIso < p.periodEnd!,
      ) ?? verified[verified.length - 1]
    return {
      ...base,
      plan: current.plan,
      status: 'active',
      since: summary.since,
      expiresAt: summary.expiresAt,
    }
  }
  const pending = payments.find((p) => p.status === 'pending')
  if (pending) {
    return {
      ...base,
      plan: pending.plan,
      status: 'pending',
      since: pending.publishedAt,
      ...reasonOf(pending.reason),
    }
  }
  const latest = payments[0]
  if (latest.status === 'invalid' || !summary || !verified.length) {
    return {
      ...base,
      plan: latest.plan,
      status: 'invalid',
      since: latest.publishedAt,
      ...reasonOf(latest.reason),
    }
  }
  return {
    ...base,
    plan: verified[verified.length - 1].plan,
    status: 'expired',
    since: summary.since,
    expiresAt: summary.expiresAt,
  }
}

type Page<T> = { items: T[]; cursor?: string }

const splitCursor = (cursor: string) => {
  const i = cursor.lastIndexOf('::')
  if (i < 0) throw new Error('Malformed cursor')
  return [cursor.slice(0, i), cursor.slice(i + 2)] as const
}

/** Creators `member` wrote payments to, the most recent payment first */
export async function listMemberCreators(
  db: Database,
  member: string,
  limit: number,
  cursor?: string,
): Promise<Page<string>> {
  let qb = db
    .selectFrom('membership_payment')
    .select(['creator'])
    .select((eb) => eb.fn.max('indexedAt').as('last'))
    .where('did', '=', member)
    .where(visibleDid('creator'))
    .groupBy('creator')
    .orderBy('last', 'desc')
    .orderBy('creator', 'desc')
    .limit(limit)
  if (cursor) {
    const [last, creator] = splitCursor(cursor)
    qb = qb.having(
      sql<boolean>`max(indexedAt) < ${last} or (max(indexedAt) = ${last} and creator < ${creator})`,
    )
  }
  const rows = await qb.execute()
  const tail = rows.at(-1)
  return {
    items: rows.map((r) => r.creator),
    cursor:
      rows.length === limit && tail
        ? `${tail.last}::${tail.creator}`
        : undefined,
  }
}

/** Members of `creator` (verified payments), the latest expiry first */
export async function listCreatorMembers(
  db: Database,
  creator: string,
  opts: {
    status?: 'active' | 'expired'
    now: number
    limit: number
    cursor?: string
  },
): Promise<Page<string>> {
  const nowIso = new Date(opts.now).toISOString()
  let qb = db
    .selectFrom('creator_member')
    .select(['member', 'expiresAt'])
    .where('creator', '=', creator)
    .where(visibleDid('member'))
    .orderBy('expiresAt', 'desc')
    .orderBy('member', 'desc')
    .limit(opts.limit)
  if (opts.status === 'active') qb = qb.where('expiresAt', '>', nowIso)
  if (opts.status === 'expired') qb = qb.where('expiresAt', '<=', nowIso)
  if (opts.cursor) {
    const [expiresAt, member] = splitCursor(opts.cursor)
    qb = qb.where((eb) =>
      eb.or([
        eb('expiresAt', '<', expiresAt),
        eb.and([eb('expiresAt', '=', expiresAt), eb('member', '<', member)]),
      ]),
    )
  }
  const rows = await qb.execute()
  const tail = rows.at(-1)
  return {
    items: rows.map((r) => r.member),
    cursor:
      rows.length === opts.limit && tail
        ? `${tail.expiresAt}::${tail.member}`
        : undefined,
  }
}

/** Membership plans of the account, its payments, and payments to it */
export async function exportMembershipData(db: Database, did: string) {
  const paymentColumns = [
    'uri',
    'did',
    'creator',
    'plan',
    'chain',
    'txHash',
    'status',
    'amount',
    'blockTime',
    'periodStart',
    'periodEnd',
    'createdAt',
  ] as const
  const [plans, paid, received] = await Promise.all([
    db
      .selectFrom('membership_plan')
      .select(['uri', 'name', 'description', 'priceUsdc', 'perks', 'active'])
      .select('createdAt')
      .where('did', '=', did)
      .execute(),
    db
      .selectFrom('membership_payment')
      .select(paymentColumns)
      .where('did', '=', did)
      .orderBy('indexedAt', 'desc')
      .limit(10_000)
      .execute(),
    db
      .selectFrom('membership_payment')
      .select(paymentColumns)
      .where('creator', '=', did)
      .orderBy('indexedAt', 'desc')
      .limit(10_000)
      .execute(),
  ])
  return {
    membershipPlans: plans.map((p) => ({
      ...p,
      perks: JSON.parse(p.perks) as string[],
      active: p.active === 1,
    })),
    membershipPaymentsMade: paid,
    membershipPaymentsReceived: received,
  }
}
