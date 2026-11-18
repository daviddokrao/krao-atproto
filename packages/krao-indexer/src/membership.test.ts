import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import {
  creatorStats,
  formatUsd,
  scaleDecimal,
  topSupporters,
} from './creator.js'
import { type Database, createDb, migrateDb } from './db.js'
import { gateRuleRowFromRecord, isEligible } from './gate.js'
import {
  ChainClock,
  MAX_TX_AGE_MS,
  PERIOD_MS,
  getMembership,
  getPlans,
  isActiveMember,
  listCreatorMembers,
  membershipPeriods,
  paymentRowFromRecord,
  planMemberCounts,
  planRowFromRecord,
  upsertPayment,
  upsertPlan,
  verifyPayment,
} from './membership.js'
import { tipRowFromRecord, upsertTip, verifyTip } from './tips.js'
import { USDC } from './token.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const USDC_ASSET = `${BASE}/erc20:${USDC}`
const DAY = 24 * 60 * 60 * 1000
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const CREATOR = 'did:plc:creator'
const MEMBER = 'did:plc:member'
const OTHER = 'did:plc:other'
const CREATOR_WALLET = addr(1)
const MEMBER_WALLET = addr(2)
const OTHER_WALLET = addr(3)

/** USDC transfers on the fake chain, by transaction */
let transfers: Map<
  string,
  { from: string; to: string; amount: bigint; time: number }
>
let chainTime: number

const chain = {
  tokenTransfers: async ({
    contract,
    txHash,
    from,
    to,
  }: {
    contract: string
    txHash: string
    from: Set<string>
    to: Set<string>
  }) => {
    const t = transfers.get(txHash)
    if (!t) return { status: 'pending' as const, reason: 'not mined' }
    if (
      contract.toLowerCase() !== USDC.toLowerCase() ||
      !from.has(t.from) ||
      !to.has(t.to)
    ) {
      return { status: 'invalid' as const, reason: 'no matching transfer' }
    }
    return {
      status: 'found' as const,
      amount: t.amount,
      blockTime: Math.floor(t.time / 1000),
    }
  },
  blockTime: async () => Math.floor(chainTime / 1000),
} as unknown as EvmRpc
const rpcs = new Map([[BASE, chain]])

let db: Database
let seq = 0

async function linkWallet(did: string, address: string) {
  const now = new Date().toISOString()
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${++seq}`,
    did,
    account: `${BASE}:${address}`,
    accountRaw: `${BASE}:${address}`,
    evmAddress: address,
    label: null,
    status: 'verified',
    reason: null,
    showPrimaryName: 1,
    createdAt: now,
    indexedAt: now,
  })
}

async function plan(record: Record<string, unknown> = {}, did = CREATOR) {
  const uri = `at://${did}/net.krao.membership.plan/p${++seq}`
  const row = planRowFromRecord(uri, did, 'bafyplan', {
    name: 'Fan',
    priceUsdc: '5000000',
    active: true,
    createdAt: new Date(Date.now() + seq).toISOString(),
    ...record,
  })
  if (row) await upsertPlan(db, row)
  return uri
}

/** A USDC transfer of `amount` at `time`, from the member to the creator */
function send(amount: bigint, time = Date.now(), from = MEMBER_WALLET) {
  const hash = tx(++seq)
  transfers.set(hash, { from, to: CREATOR_WALLET, amount, time })
  return hash
}

/** Index a payment record by `did` and verify it, like the indexer does */
async function pay(
  planUri: string,
  txHash: string,
  opts: { did?: string; publishedAt?: number; record?: object } = {},
) {
  const row = paymentRowFromRecord(
    `at://${opts.did ?? MEMBER}/net.krao.membership.payment/${++seq}`,
    opts.did ?? MEMBER,
    {
      plan: { uri: planUri, cid: 'bafyplan' },
      creator: CREATOR,
      chain: BASE,
      txHash,
      createdAt: new Date().toISOString(),
      ...opts.record,
    },
    new Date(opts.publishedAt ?? Date.now()).toISOString(),
  )
  if (!row) throw new Error('payment not indexed')
  row.indexedAt = new Date(Date.now() + seq).toISOString()
  await upsertPayment(db, row)
  return verifyPayment(db, rpcs, row)
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  transfers = new Map()
  chainTime = Date.now()
  await linkWallet(CREATOR, CREATOR_WALLET)
  await linkWallet(MEMBER, MEMBER_WALLET)
  await linkWallet(OTHER, OTHER_WALLET)
})

afterEach(async () => {
  await db.destroy()
})

describe('membershipPeriods', () => {
  const t0 = Date.parse('2026-10-01T00:00:00Z')

  it('pays for 30 days from the block time', () => {
    const s = membershipPeriods([{ uri: 'a', time: t0 }])
    expect(s).toMatchObject({ since: t0, expiresAt: t0 + PERIOD_MS })
  })

  it('extends from the current expiry when renewed while active', () => {
    const s = membershipPeriods([
      { uri: 'b', time: t0 + 10 * DAY },
      { uri: 'a', time: t0 },
    ])
    expect(s?.periods).toEqual([
      { uri: 'a', start: t0, end: t0 + PERIOD_MS },
      { uri: 'b', start: t0 + PERIOD_MS, end: t0 + 2 * PERIOD_MS },
    ])
    expect(s).toMatchObject({ since: t0, expiresAt: t0 + 2 * PERIOD_MS })
  })

  it('starts a new run after a lapse', () => {
    const late = t0 + 45 * DAY
    const s = membershipPeriods([
      { uri: 'a', time: t0 },
      { uri: 'b', time: late },
    ])
    expect(s).toMatchObject({
      since: late,
      firstAt: t0,
      expiresAt: late + PERIOD_MS,
    })
  })

  it('has nothing without payments', () => {
    expect(membershipPeriods([])).toBeUndefined()
  })
})

describe('plans', () => {
  it('accepts prices from $1 to $1000 only', () => {
    const row = (priceUsdc: string) =>
      planRowFromRecord('at://x/p/1', CREATOR, 'c', {
        name: 'n',
        priceUsdc,
        active: true,
      })
    expect(row('1000000')).not.toBeNull()
    expect(row('1000000000')).not.toBeNull()
    expect(row('999999')).toBeNull()
    expect(row('1000000001')).toBeNull()
    expect(row('1.5')).toBeNull()
  })

  it('counts at most 3 plans as active', async () => {
    for (let i = 0; i < 4; i++) await plan()
    const plans = await getPlans(db, CREATOR, true)
    expect(plans.map((p) => p.active)).toEqual([1, 1, 1, 0])
    expect(await getPlans(db, CREATOR, false)).toHaveLength(3)
  })
})

describe('verifyPayment', () => {
  it('makes the member active for 30 days from the transaction', async () => {
    const p = await plan()
    const time = Date.now() - 60_000
    expect(await pay(p, send(5_000_000n, time))).toBe('verified')
    const m = await getMembership(db, CREATOR, MEMBER, Date.now())
    expect(m).toMatchObject({
      status: 'active',
      plan: p,
      expiresAt: new Date(
        Math.floor(time / 1000) * 1000 + PERIOD_MS,
      ).toISOString(),
    })
    expect(await isActiveMember(db, CREATOR, MEMBER, Date.now())).toBe(true)
    expect(
      await isActiveMember(db, CREATOR, MEMBER, Date.now() + PERIOD_MS),
    ).toBe(false)
    const later = await getMembership(
      db,
      CREATOR,
      MEMBER,
      Date.now() + PERIOD_MS,
    )
    expect(later?.status).toBe('expired')
  })

  it('extends an active membership from its expiry', async () => {
    const p = await plan()
    const t0 = Math.floor((Date.now() - 2 * DAY) / 1000) * 1000
    await pay(p, send(5_000_000n, t0), { publishedAt: t0 })
    await pay(p, send(5_000_000n, t0 + DAY), { publishedAt: t0 + DAY })
    const m = await getMembership(db, CREATOR, MEMBER, Date.now())
    expect(m?.expiresAt).toBe(new Date(t0 + 2 * PERIOD_MS).toISOString())
    expect(m?.since).toBe(new Date(t0).toISOString())
  })

  it('accepts more than the price, refuses less', async () => {
    const p = await plan()
    expect(await pay(p, send(6_000_000n))).toBe('verified')
    expect(await pay(p, send(4_999_999n))).toBe('invalid')
  })

  it('refuses a transaction used twice, or used by a tip', async () => {
    const p = await plan()
    const hash = send(5_000_000n)
    expect(await pay(p, hash)).toBe('verified')
    expect(await pay(p, hash)).toBe('invalid')

    const tipped = send(5_000_000n)
    const tip = tipRowFromRecord(`at://${MEMBER}/net.krao.feed.tip/t`, MEMBER, {
      recipient: CREATOR,
      asset: USDC_ASSET,
      amount: '5000000',
      txHash: tipped,
      from: `${BASE}:${MEMBER_WALLET}`,
      to: `${BASE}:${CREATOR_WALLET}`,
    })
    await upsertTip(db, tip)
    await db
      .updateTable('tip')
      .set({ status: 'verified' })
      .where('uri', '=', tip.uri)
      .execute()
    expect(await pay(p, tipped)).toBe('invalid')
  })

  it('refuses a tip on a transaction a payment used', async () => {
    const p = await plan()
    const hash = send(5_000_000n)
    await pay(p, hash)
    const tip = tipRowFromRecord(`at://${MEMBER}/net.krao.feed.tip/t`, MEMBER, {
      recipient: CREATOR,
      asset: USDC_ASSET,
      amount: '5000000',
      txHash: hash,
      from: `${BASE}:${MEMBER_WALLET}`,
      to: `${BASE}:${CREATOR_WALLET}`,
    })
    await upsertTip(db, tip)
    expect(await verifyTip(db, new Map(), tip)).toBe('invalid')
  })

  it('refuses a transaction more than 24 hours older than the record', async () => {
    const p = await plan()
    const now = Date.now()
    expect(await pay(p, send(5_000_000n, now - MAX_TX_AGE_MS - 60_000))).toBe(
      'invalid',
    )
    expect(await pay(p, send(5_000_000n, now - MAX_TX_AGE_MS + 60_000))).toBe(
      'verified',
    )
  })

  it("refuses someone else's transfer", async () => {
    const p = await plan()
    // The member's transfer, claimed by another account
    expect(await pay(p, send(5_000_000n), { did: OTHER })).toBe('invalid')
    // A transfer from a wallet nobody linked
    expect(await pay(p, send(5_000_000n, Date.now(), addr(9)))).toBe('invalid')
  })

  it('refuses plans of another account, inactive plans and paying yourself', async () => {
    expect(await pay(await plan({}, OTHER), send(5_000_000n))).toBe('invalid')
    expect(await pay(await plan({ active: false }), send(5_000_000n))).toBe(
      'invalid',
    )
    expect(
      await pay(await plan(), send(5_000_000n), {
        did: CREATOR,
      }),
    ).toBe('invalid')
  })

  it('waits for a transaction that is not mined, or a plan not indexed', async () => {
    const p = await plan()
    expect(await pay(p, tx(999_999))).toBe('pending')
    expect(
      await pay(
        `at://${CREATOR}/net.krao.membership.plan/later`,
        send(5_000_000n),
      ),
    ).toBe('pending')
    const m = await getMembership(db, CREATOR, MEMBER, Date.now())
    expect(m?.status).toBe('pending')
  })

  it('opens plan gates only for members of that plan', async () => {
    const fan = await plan()
    const vip = await plan({ priceUsdc: '20000000' })
    await pay(fan, send(5_000_000n))
    const now = Date.now()
    expect(await isActiveMember(db, CREATOR, MEMBER, now, fan)).toBe(true)
    expect(await isActiveMember(db, CREATOR, MEMBER, now, vip)).toBe(false)
    expect((await planMemberCounts(db, [fan, vip], now)).get(fan)).toBe(1)
  })

  it('takes back what a deleted or rewritten payment paid for', async () => {
    const p = await plan()
    await pay(p, send(5_000_000n))
    const [row] = await db
      .selectFrom('membership_payment')
      .selectAll()
      .execute()
    await upsertPayment(db, { ...row, status: 'pending', txHash: tx(1) })
    expect(await isActiveMember(db, CREATOR, MEMBER, Date.now())).toBe(false)
  })

  it('agrees on an active member when the clock is behind the block', async () => {
    // A dev chain idle after evm_increaseTime mines ahead of ChainClock
    const p = await plan()
    const lag = 10 * 60_000
    const blockAt = Date.now() + 31 * DAY
    await pay(p, send(5_000_000n, blockAt))
    const clock = blockAt - lag
    expect(await isActiveMember(db, CREATOR, MEMBER, clock)).toBe(true)
    expect(await isActiveMember(db, CREATOR, MEMBER, clock, p)).toBe(true)
    expect((await planMemberCounts(db, [p], clock)).get(p)).toBe(1)
    expect(await getMembership(db, CREATOR, MEMBER, clock)).toMatchObject({
      status: 'active',
      plan: p,
    })
    const now = Date.now()
    const stats = await creatorStats(db, CREATOR, {
      now,
      chainNow: clock,
      follows: false,
    })
    expect(stats.members).toEqual({ active: 1, new30d: 1, expired30d: 0 })
    expect(stats.daily[29].newMembers).toBe(1)
  })

  it('counts a member under the plan of their current period only', async () => {
    const fan = await plan()
    const vip = await plan({ priceUsdc: '20000000' })
    const t0 = Date.now() - DAY
    await pay(fan, send(5_000_000n, t0), { publishedAt: t0 })
    // A renewal on another plan starts when the current period ends
    await pay(vip, send(20_000_000n))
    const counts = await planMemberCounts(db, [fan, vip], Date.now())
    expect(counts.get(fan)).toBe(1)
    expect(counts.get(vip)).toBeUndefined()
  })

  it('drops a check whose record was rewritten meanwhile', async () => {
    const p = await plan()
    const first = send(5_000_000n)
    const row = paymentRowFromRecord(
      `at://${MEMBER}/net.krao.membership.payment/rw`,
      MEMBER,
      {
        plan: { uri: p, cid: 'bafyplan' },
        creator: CREATOR,
        chain: BASE,
        txHash: first,
        createdAt: new Date().toISOString(),
      },
      new Date().toISOString(),
    )!
    await upsertPayment(db, row)
    // The record now names another transaction; the old check comes back
    await upsertPayment(db, { ...row, txHash: tx(424_242) })
    expect(await verifyPayment(db, rpcs, row)).toBe('pending')
    const stored = await db
      .selectFrom('membership_payment')
      .select(['status', 'txHash'])
      .where('uri', '=', row.uri)
      .executeTakeFirstOrThrow()
    expect(stored).toEqual({ status: 'pending', txHash: tx(424_242) })
    // The first transaction is still free for one payment
    expect(await pay(p, first)).toBe('verified')
  })

  it('lists active and expired members for the creator', async () => {
    const p = await plan()
    await pay(p, send(5_000_000n, Date.now() - 40 * DAY), {
      publishedAt: Date.now() - 40 * DAY,
    })
    await pay(p, send(5_000_000n), { did: OTHER, record: {} })
    const now = Date.now()
    const active = await listCreatorMembers(db, CREATOR, {
      status: 'active',
      now,
      limit: 10,
    })
    const expired = await listCreatorMembers(db, CREATOR, {
      status: 'expired',
      now,
      limit: 10,
    })
    // OTHER's transfer came from MEMBER_WALLET, so only MEMBER paid
    expect(active.items).toEqual([])
    expect(expired.items).toEqual([MEMBER])
  })
})

describe('membership gate condition', () => {
  const rule = (condition: Record<string, unknown>) =>
    gateRuleRowFromRecord(`at://${CREATOR}/net.krao.gate.rule/r`, CREATOR, {
      subject: { uri: `at://${CREATOR}/app.bsky.feed.post/1`, cid: 'c' },
      conditions: [{ $type: 'net.krao.gate.defs#membership', ...condition }],
      service: 'did:web:gate.krao.test',
    })

  it("accepts a creator, or a plan of the creator's", () => {
    expect(rule({ creator: CREATOR })).not.toBeNull()
    expect(
      rule({
        creator: CREATOR,
        plan: `at://${CREATOR}/net.krao.membership.plan/p`,
      }),
    ).not.toBeNull()
    expect(
      rule({
        creator: CREATOR,
        plan: `at://${OTHER}/net.krao.membership.plan/p`,
      }),
    ).toBeNull()
    expect(rule({ creator: 'nobody' })).toBeNull()
  })

  it('opens for active members only, checked on every read', async () => {
    const r = rule({ creator: CREATOR })!
    const p = await plan()
    await pay(p, send(5_000_000n))
    let now = Date.now()
    const ctx = {
      isCreatorMember: (
        creator: string,
        plan: string | undefined,
        did: string,
      ) => isActiveMember(db, creator, did, now, plan),
    }
    expect(await isEligible(db, rpcs, r, MEMBER, ctx)).toBe(true)
    expect(await isEligible(db, rpcs, r, OTHER, ctx)).toBe(false)
    now += PERIOD_MS + 1000
    expect(await isEligible(db, rpcs, r, MEMBER, ctx)).toBe(false)
    // Without the check the condition is never met
    expect(await isEligible(db, rpcs, r, MEMBER)).toBe(false)
  })
})

describe('ChainClock', () => {
  it('follows the chain when it is ahead of the wall clock', async () => {
    chainTime = Date.now() + 31 * DAY
    const now = await new ChainClock(chain).now()
    expect(now).toBeGreaterThanOrEqual(Math.floor(chainTime / 1000) * 1000)
    chainTime = Date.now() - DAY
    expect(await new ChainClock(chain).now()).toBeGreaterThanOrEqual(
      Date.now() - 1000,
    )
    expect(await new ChainClock(chain).now()).toBeLessThan(Date.now() + 1000)
  })

  it('asks a failing chain once per interval, keeping the last offset', async () => {
    let calls = 0
    let fail = false
    const flaky = {
      blockTime: async () => {
        calls += 1
        if (fail) throw new Error('down')
        return Math.floor((Date.now() + 31 * DAY) / 1000)
      },
    } as unknown as EvmRpc
    // Every call is due for a read; concurrent ones share it
    const clock = new ChainClock(flaky, -1)
    expect(await clock.now()).toBeGreaterThan(Date.now() + 30 * DAY)
    fail = true
    const [a, b] = await Promise.all([clock.now(), clock.now()])
    expect(calls).toBe(2)
    expect(Math.min(a, b)).toBeGreaterThan(Date.now() + 30 * DAY)
  })
})

describe('creator numbers', () => {
  async function verifiedTip(
    did: string,
    amount: string,
    extra: Record<string, unknown> = {},
  ) {
    const row = tipRowFromRecord(
      `at://${did}/net.krao.feed.tip/${++seq}`,
      did,
      {
        recipient: CREATOR,
        asset: USDC_ASSET,
        amount,
        txHash: tx(++seq),
        createdAt: new Date().toISOString(),
        ...extra,
      },
    )
    await upsertTip(db, { ...row, status: 'verified' })
  }

  it('formats micro-dollars and parses prices', () => {
    expect(formatUsd(12_500_000n)).toBe('12.50')
    expect(formatUsd(999n)).toBe('0.00')
    expect(scaleDecimal('3012.4567', 2)).toBe(301245n)
    expect(scaleDecimal('nope', 2)).toBeNull()
  })

  it('ranks supporters and never shows an anonymous DID', async () => {
    await verifiedTip(MEMBER, '2000000')
    await verifiedTip(OTHER, '9000000', { anonymous: true })
    const p = await plan()
    await pay(p, send(5_000_000n))
    const now = Date.now()
    const list = await topSupporters(db, CREATOR, {
      since: now - 90 * DAY,
      chainSince: now - 90 * DAY,
      limit: 10,
    })
    expect(list).toEqual([
      { anonymous: true, totalUsd: '9.00', tipCount: 1 },
      { did: MEMBER, anonymous: false, totalUsd: '7.00', tipCount: 2 },
    ])
    expect(JSON.stringify(list)).not.toContain(OTHER)
  })

  it('leaves out tips dated in the future', async () => {
    await verifiedTip(OTHER, '9000000', {
      createdAt: new Date(Date.now() + 365 * DAY).toISOString(),
    })
    const now = Date.now()
    const list = await topSupporters(db, CREATOR, {
      since: now - 90 * DAY,
      chainSince: now - 90 * DAY,
      limit: 10,
    })
    expect(list).toEqual([])
  })

  it('sums tips and members over 30 days', async () => {
    await verifiedTip(MEMBER, '2000000')
    await verifiedTip(OTHER, '3000000')
    await verifiedTip(OTHER, '1000000', {
      createdAt: new Date(Date.now() - 40 * DAY).toISOString(),
    })
    const p = await plan()
    await pay(p, send(5_000_000n))
    const now = Date.now()
    const stats = await creatorStats(db, CREATOR, {
      now,
      chainNow: now,
      follows: true,
    })
    expect(stats.tips30d).toEqual({ count: 2, totalUsd: '5.00' })
    expect(stats.members).toEqual({ active: 1, new30d: 1, expired30d: 0 })
    expect(stats.followers).toEqual({ now: 0, change30d: 0 })
    expect(stats.daily).toHaveLength(30)
    expect(stats.daily[29]).toMatchObject({
      date: new Date(now).toISOString().slice(0, 10),
      tipsUsd: '5.00',
      newMembers: 1,
    })
    // A month later on the chain's clock the member has expired
    const later = await creatorStats(db, CREATOR, {
      now,
      chainNow: now + 31 * DAY,
      follows: false,
    })
    expect(later.members).toEqual({ active: 0, new30d: 0, expired30d: 1 })
    expect(later.followers).toEqual({ now: 0 })
  })
})
