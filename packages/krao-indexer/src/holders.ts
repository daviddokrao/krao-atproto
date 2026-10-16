import { sql } from 'kysely'
import type { EvmRpc } from './chain.js'
import { scaleDecimal } from './creator.js'
import { type Database, visibleDid } from './db.js'
import { FEED_GENERATOR_COLLECTION } from './feed.js'

/*
 * Topic feeds (M33), served as feed generators like "latest":
 *   holders-<symbol>   newest top-level posts by Krao accounts whose owned,
 *                      verified wallets hold at least `minUsd` of a catalog
 *                      token (ETH: the native balance), balances cached
 *   community-<slug>   in the community owner's repo: the community's feed,
 *                      public posts only (see getCommunityFeed)
 * The generator's rkey picks the feed; a token outside the catalog or a
 * community the repo does not own gives an empty feed.
 */

export const HOLDER_FEED_PREFIX = 'holders-'
export const COMMUNITY_FEED_PREFIX = 'community-'
/** Balances are read again after this long */
export const HOLDER_BALANCE_CACHE_MS = 15 * 60 * 1000
/** Default value a wallet set must hold, in US dollars */
export const HOLDER_FEED_MIN_USD = 1
/** Balance reads a holder list makes at the same time */
const BALANCE_READS_AT_ONCE = 8

type BalanceRpc = Pick<EvmRpc, 'getBalance' | 'tryCall'>

export type HolderFeedOptions = {
  /** Base JSON-RPC (catalog tokens are on Base); without it, no holders */
  rpc?: BalanceRpc
  minUsd?: number
  /** How long a wallet's balance is reused (default 15 minutes, 0: off) */
  cacheMs?: number
}

const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')

export class HolderFeeds {
  private balances = new Map<string, { at: number; value: bigint }>()

  constructor(
    private db: Database,
    private opts: HolderFeedOptions = {},
  ) {}

  private get cacheMs() {
    return this.opts.cacheMs ?? HOLDER_BALANCE_CACHE_MS
  }

  /** The balance of `address`; the last known one when the chain fails */
  private async balance(
    rpc: BalanceRpc,
    token: { key: string; address: string },
    address: string,
    now: number,
  ): Promise<bigint | undefined> {
    const cacheKey = `${token.key}|${address}`
    const cached = this.balances.get(cacheKey)
    if (cached && this.cacheMs > 0 && now - cached.at < this.cacheMs) {
      return cached.value
    }
    try {
      let value: bigint
      if (token.key === 'ETH') {
        value = await rpc.getBalance(address)
      } else {
        const res = await rpc.tryCall(
          token.address,
          '0x70a08231' + word(address),
        )
        value = res && res.length >= 66 ? BigInt(res.slice(0, 66)) : 0n
      }
      if (this.balances.size > 50_000) this.balances.clear()
      this.balances.set(cacheKey, { at: now, value })
      return value
    } catch (err) {
      console.error('Krao indexer: holder balance read failed', address, err)
      return cached?.value
    }
  }

  /** Holder lists by token, and the reads of them under way */
  private lists = new Map<string, { at: number; dids: string[] }>()
  private reading = new Map<string, Promise<string[]>>()

  /**
   * Accounts (not hidden) whose owned verified EVM wallets together hold at
   * least the minimum value of the catalog token `key` (upper case). Every
   * feed request asks, and a fresh list reads the balance of every linked
   * wallet, so the list itself is reused as long as balances are, a single
   * read runs at a time per token, and an expired list is served while the
   * next one is read.
   */
  async holders(key: string, now = Date.now()): Promise<string[]> {
    const cached = this.lists.get(key)
    if (cached && this.cacheMs > 0 && now - cached.at < this.cacheMs) {
      return cached.dids
    }
    let read = this.reading.get(key)
    if (!read) {
      read = this.readHolders(key, now)
        .then((dids) => {
          if (this.cacheMs > 0) this.lists.set(key, { at: now, dids })
          return dids
        })
        .finally(() => this.reading.delete(key))
      this.reading.set(key, read)
    }
    if (cached && this.cacheMs > 0) {
      read.catch((err: unknown) =>
        console.error('Krao indexer: holder list read failed', key, err),
      )
      return cached.dids
    }
    return read
  }

  private async readHolders(key: string, now: number): Promise<string[]> {
    const rpc = this.opts.rpc
    if (!rpc) return []
    const token = await this.db
      .selectFrom('token')
      .selectAll()
      .where('key', '=', key)
      .where('removed', '=', 0)
      .executeTakeFirst()
    if (!token) return []
    // Dollars per whole token, with 18 decimals (as usdPricer)
    const price =
      token.quote === 'usd'
        ? 10n ** 18n
        : token.priceUsd
          ? scaleDecimal(token.priceUsd, 18)
          : null
    if (!price) return []
    const minMicro = BigInt(
      Math.round((this.opts.minUsd ?? HOLDER_FEED_MIN_USD) * 1_000_000),
    )
    // Each address counts for the account that linked it first
    const links = await this.db
      .selectFrom('wallet')
      .select(['did', 'evmAddress'])
      .where('status', '=', 'verified')
      .where('evmAddress', 'is not', null)
      .orderBy('indexedAt', 'asc')
      .orderBy('uri', 'asc')
      .execute()
    const owner = new Map<string, string>()
    for (const link of links) {
      if (!owner.has(link.evmAddress!)) owner.set(link.evmAddress!, link.did)
    }
    const hidden = new Set(
      (await this.db.selectFrom('hidden_actor').select('did').execute()).map(
        (r) => r.did,
      ),
    )
    const totals = new Map<string, bigint>()
    const queue = [...owner].filter(([, did]) => !hidden.has(did))
    // A few reads at a time: one at a time takes minutes with many wallets
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [address, did] = next
        const value = await this.balance(rpc, token, address, now)
        if (value) totals.set(did, (totals.get(did) ?? 0n) + value)
      }
    }
    await Promise.all(Array.from({ length: BALANCE_READS_AT_ONCE }, worker))
    // amount / 10^decimals tokens x price / 10^18 dollars x 10^6
    const unit = 10n ** BigInt(token.decimals + 12)
    return [...totals]
      .filter(([, value]) => (value * price) / unit >= minMicro)
      .map(([did]) => did)
      .sort()
  }
}

/** The symbol of a holders-<symbol> rkey, upper case; null for other rkeys */
export function holderFeedKey(rkey: string): string | null {
  if (!rkey.startsWith(HOLDER_FEED_PREFIX)) return null
  const symbol = rkey.slice(HOLDER_FEED_PREFIX.length)
  return /^[a-z][a-z0-9]{1,9}$/.test(symbol) ? symbol.toUpperCase() : null
}

/** The slug of a community-<slug> rkey; null for other rkeys */
export function communityFeedSlug(rkey: string): string | null {
  if (!rkey.startsWith(COMMUNITY_FEED_PREFIX)) return null
  const slug = rkey.slice(COMMUNITY_FEED_PREFIX.length)
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug) ? slug : null
}

/**
 * The holders feed of the token, when a generator for it names this
 * service: the first one indexed, so a later copy cannot take its place
 */
export async function holderFeedUri(
  db: Database,
  key: string,
): Promise<string | undefined> {
  const rkey = `${HOLDER_FEED_PREFIX}${key.toLowerCase()}`
  const row = await db
    .selectFrom('feed_generator')
    .select('uri')
    .where('uri', 'like', `at://%/${FEED_GENERATOR_COLLECTION}/${rkey}`)
    .where(visibleDid('did'))
    .orderBy(sql`rowid`)
    .executeTakeFirst()
  return row?.uri
}

/** The community's feed generator in its owner's repo, when it names this service */
export async function communityFeedUri(
  db: Database,
  community: { did: string; slug: string },
): Promise<string | undefined> {
  const uri = `at://${community.did}/${FEED_GENERATOR_COLLECTION}/${COMMUNITY_FEED_PREFIX}${community.slug}`
  const row = await db
    .selectFrom('feed_generator')
    .select('uri')
    .where('uri', '=', uri)
    .executeTakeFirst()
  return row?.uri
}
