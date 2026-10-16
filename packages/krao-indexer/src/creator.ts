import { parseAssetId } from './chain.js'
import { type Database, visibleDid } from './db.js'
import { BASE_CHAIN, USDC, WETH } from './token.js'

/*
 * Creator numbers: top supporters on a profile and the creator's own
 * dashboard. Amounts are summed in micro-dollars (USDC base units): USDC
 * counts as a dollar, other assets at the token catalog's current price, and
 * assets the catalog has no price for count as nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const SUPPORTER_WINDOW_MS = 90 * DAY_MS
export const STATS_DAYS = 30

const USDC_KEY = `${BASE_CHAIN}/erc20:${USDC.toLowerCase()}`
const WETH_KEY = `${BASE_CHAIN}/erc20:${WETH.toLowerCase()}`

/** A decimal string as an integer scaled by 10^scale (rounded down) */
export function scaleDecimal(value: string, scale: number): bigint | null {
  const match = /^([0-9]+)(?:\.([0-9]*))?$/.exec(value.trim())
  if (!match) return null
  const fraction = (match[2] ?? '').slice(0, scale).padEnd(scale, '0')
  return BigInt(match[1] + fraction)
}

/** Micro-dollars as dollars with 2 decimals (rounded down): 12500000n → '12.50' */
export function formatUsd(micro: bigint): string {
  const cents = micro / 10_000n
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
}

/** Turns asset amounts into micro-dollars at the catalog's current prices */
export async function usdPricer(db: Database) {
  const tokens = await db
    .selectFrom('token')
    .select(['chain', 'address', 'decimals', 'priceUsd'])
    .where('removed', '=', 0)
    .execute()
  const prices = new Map<string, { decimals: number; price: bigint }>()
  for (const t of tokens) {
    // Prices with 18 decimals, so tiny prices still count
    const price = t.priceUsd ? scaleDecimal(t.priceUsd, 18) : null
    if (price) {
      prices.set(`${t.chain}/erc20:${t.address.toLowerCase()}`, {
        decimals: t.decimals,
        price,
      })
    }
  }
  return (asset: string, amount: string): bigint => {
    const parsed = parseAssetId(asset)
    if (!parsed || !/^[0-9]{1,78}$/.test(amount)) return 0n
    const key =
      parsed.kind === 'native'
        ? parsed.chainId === BASE_CHAIN
          ? WETH_KEY
          : undefined
        : `${parsed.chainId}/erc20:${parsed.contract}`
    if (key === USDC_KEY) return BigInt(amount)
    const token = key ? prices.get(key) : undefined
    if (!token) return 0n
    // amount / 10^decimals tokens × price / 10^18 dollars × 10^6
    return (BigInt(amount) * token.price) / 10n ** BigInt(token.decimals + 12)
  }
}

export type Supporter = {
  did?: string
  anonymous: boolean
  totalUsd: string
  tipCount: number
}

/**
 * Who gave the most to `actor` since `since` through verified tips (time:
 * the record's createdAt) and membership payments (time: block time, which
 * `chainSince` bounds). An anonymous tip counts towards an entry without a
 * DID, apart from the same account's public support.
 */
export async function topSupporters(
  db: Database,
  actor: string,
  opts: { since: number; chainSince: number; limit: number },
): Promise<Supporter[]> {
  const [tips, payments, usd] = await Promise.all([
    db
      .selectFrom('tip')
      .select(['did', 'asset', 'amount', 'anonymous'])
      .where('recipient', '=', actor)
      .where('status', '=', 'verified')
      .where('createdAt', '>=', new Date(opts.since).toISOString())
      // createdAt is the tipper's own claim: one dated ahead would stay listed
      .where('createdAt', '<=', new Date().toISOString())
      .where('did', '!=', actor)
      .where(visibleDid('did'))
      .execute(),
    db
      .selectFrom('membership_payment')
      .select(['did', 'amount'])
      .where('creator', '=', actor)
      .where('status', '=', 'verified')
      .where('blockTime', '>=', new Date(opts.chainSince).toISOString())
      .where(visibleDid('did'))
      .execute(),
    usdPricer(db),
  ])
  const totals = new Map<
    string,
    { did: string; anonymous: boolean; micro: bigint; count: number }
  >()
  const add = (did: string, anonymous: boolean, micro: bigint) => {
    const key = `${anonymous ? 'anon' : 'public'} ${did}`
    const entry = totals.get(key) ?? { did, anonymous, micro: 0n, count: 0 }
    entry.micro += micro
    entry.count += 1
    totals.set(key, entry)
  }
  for (const tip of tips) {
    add(tip.did, tip.anonymous === 1, usd(tip.asset, tip.amount))
  }
  for (const payment of payments) {
    add(payment.did, false, BigInt(payment.amount ?? '0'))
  }
  return [...totals.values()]
    .sort((a, b) =>
      a.micro !== b.micro ? (b.micro > a.micro ? 1 : -1) : b.count - a.count,
    )
    .slice(0, opts.limit)
    .map((e) => ({
      // Never the DID of an anonymous supporter
      ...(e.anonymous ? {} : { did: e.did }),
      anonymous: e.anonymous,
      totalUsd: formatUsd(e.micro),
      tipCount: e.count,
    }))
}

/** A follow is going away: remember when it started, for follower changes */
export async function recordFollowerLoss(db: Database, followUri: string) {
  const follow = await db
    .selectFrom('feed_follow')
    .select(['subject', 'indexedAt'])
    .where('uri', '=', followUri)
    .executeTakeFirst()
  if (!follow) return
  await db
    .insertInto('follower_loss')
    .values({
      subject: follow.subject,
      followedAt: follow.indexedAt,
      lostAt: new Date().toISOString(),
    })
    .execute()
}

export async function deleteFollowerLossesForDid(db: Database, did: string) {
  await db.deleteFrom('follower_loss').where('subject', '=', did).execute()
}

export async function pruneFollowerLosses(db: Database, now = Date.now()) {
  await db
    .deleteFrom('follower_loss')
    .where(
      'lostAt',
      '<',
      new Date(now - (STATS_DAYS + 1) * DAY_MS).toISOString(),
    )
    .execute()
}

export type CreatorStats = {
  tips30d: { count: number; totalUsd: string }
  members: { active: number; new30d: number; expired30d: number }
  followers: { now: number; change30d?: number }
  daily: { date: string; tipsUsd: string; newMembers: number }[]
}

/**
 * The dashboard of `creator` over the last 30 UTC days (today included).
 * Tips are counted by their createdAt on the wall clock (`now`); memberships
 * by their block times on the chain's clock (`chainNow`, see ChainClock).
 * `followersNow` comes from the AppView when it answers; `follows` says
 * whether this indexer indexes follows at all.
 */
export async function creatorStats(
  db: Database,
  creator: string,
  opts: {
    now: number
    chainNow: number
    followersNow?: number
    follows: boolean
  },
): Promise<CreatorStats> {
  const { now, chainNow } = opts
  // The last 30 UTC days, today included; memberships are on the chain's
  // clock, which runs `offset` ahead of the wall clock
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const windowStart = today - (STATS_DAYS - 1) * DAY_MS
  const offset = chainNow - now
  const chainWindowStart = windowStart + offset
  const iso = (ms: number) => new Date(ms).toISOString()
  const [tips, members, usd] = await Promise.all([
    db
      .selectFrom('tip')
      .select(['asset', 'amount', 'createdAt'])
      .where('recipient', '=', creator)
      .where('status', '=', 'verified')
      .where('createdAt', '>=', iso(windowStart))
      .where(visibleDid('did'))
      .execute(),
    db
      .selectFrom('creator_member')
      .select(['expiresAt', 'firstAt'])
      .where('creator', '=', creator)
      .where(visibleDid('member'))
      .execute(),
    usdPricer(db),
  ])

  const daily = Array.from({ length: STATS_DAYS }, (_, i) => ({
    date: iso(windowStart + i * DAY_MS).slice(0, 10),
    micro: 0n,
    newMembers: 0,
  }))
  /** Index of the day a wall clock time falls on */
  const dayOf = (ms: number) => {
    const i = Math.floor((ms - windowStart) / DAY_MS)
    return i >= 0 && i < STATS_DAYS ? i : undefined
  }

  let tipsMicro = 0n
  let tipCount = 0
  for (const tip of tips) {
    const time = Date.parse(tip.createdAt)
    if (Number.isNaN(time) || time > now) continue
    const micro = usd(tip.asset, tip.amount)
    tipsMicro += micro
    tipCount += 1
    const day = dayOf(time)
    if (day !== undefined) daily[day].micro += micro
  }

  let active = 0
  let new30d = 0
  let expired30d = 0
  for (const m of members) {
    const expires = Date.parse(m.expiresAt)
    const first = Date.parse(m.firstAt)
    if (expires > chainNow) active += 1
    else if (expires > chainWindowStart) expired30d += 1
    if (first > chainWindowStart && first <= chainNow) {
      new30d += 1
      const day = dayOf(first - offset)
      if (day !== undefined) daily[day].newMembers += 1
    }
  }

  const followers: CreatorStats['followers'] = { now: 0 }
  let indexedFollowers = 0
  if (opts.follows) {
    const [count, gained, lost] = await Promise.all([
      db
        .selectFrom('feed_follow')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('subject', '=', creator)
        .where(visibleDid('did'))
        .executeTakeFirst(),
      db
        .selectFrom('feed_follow')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('subject', '=', creator)
        .where('indexedAt', '>=', iso(windowStart))
        .where(visibleDid('did'))
        .executeTakeFirst(),
      // Follows from before the window that went away within it (one that
      // came and went inside the window is no change)
      db
        .selectFrom('follower_loss')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('subject', '=', creator)
        .where('lostAt', '>=', iso(windowStart))
        .where('followedAt', '<', iso(windowStart))
        .executeTakeFirst(),
    ])
    indexedFollowers = Number(count?.count ?? 0)
    followers.change30d = Number(gained?.count ?? 0) - Number(lost?.count ?? 0)
  }
  followers.now = opts.followersNow ?? indexedFollowers

  return {
    tips30d: { count: tipCount, totalUsd: formatUsd(tipsMicro) },
    members: { active, new30d, expired30d },
    followers,
    daily: daily.map((d) => ({
      date: d.date,
      tipsUsd: formatUsd(d.micro),
      newMembers: d.newMembers,
    })),
  }
}
