import type { EvmRpc } from './chain.js'
import {
  type Database,
  type TokenQuote,
  type TokenTable,
  visibleDid,
} from './db.js'

/*
 * Krao's token catalog: a small list of Base tokens (a seed below, plus what
 * Krao's admins add) that people can mention as cashtags ($ETH). Prices come
 * from Uniswap v3 pools (slot0, the spot price) against USDC, or against
 * WETH and then the WETH/USDC pool, read every 5 minutes into a price
 * history. Posts by Krao accounts mentioning a catalog token are indexed
 * for the token's page. Information only: nothing here buys or sells.
 */

export const BASE_CHAIN = 'eip155:8453'
export const WETH = '0x4200000000000000000000000000000000000006'
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** Uniswap v3 factory on Base (KRAO_UNISWAP_V3_FACTORY overrides it) */
export const UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
/** Uniswap v3 fee tiers, searched for the pool with the most liquidity */
export const FEE_TIERS = [100, 500, 3000, 10000]
/** How often prices are read */
export const PRICE_SAMPLE_MS = 5 * 60 * 1000
/** Price samples are kept this long (the longest range is 30 days) */
export const PRICE_RETENTION_MS = 31 * 24 * 60 * 60 * 1000
/** Most cashtags indexed per post */
export const MAX_CASHTAGS_PER_POST = 10

const QUOTES: Record<
  Exclude<TokenQuote, 'usd'>,
  { address: string; decimals: number }
> = {
  USDC: { address: USDC, decimals: 6 },
  WETH: { address: WETH, decimals: 18 },
}

export type TokenSeed = {
  symbol: string
  name: string
  address: string
  decimals: number
  quote: TokenQuote
}

/**
 * Well-known Base tokens. ETH is priced as WETH (and its address is WETH's),
 * USDC is taken as one dollar.
 */
export const SEED_TOKENS: TokenSeed[] = [
  {
    symbol: 'ETH',
    name: 'Ethereum',
    address: WETH,
    decimals: 18,
    quote: 'USDC',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: USDC,
    decimals: 6,
    quote: 'usd',
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    decimals: 8,
    quote: 'USDC',
  },
  {
    symbol: 'DEGEN',
    name: 'Degen',
    address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
    decimals: 18,
    quote: 'WETH',
  },
]

/*
 * Price math
 */

const Q192 = 1n << 192n
/** Prices are fixed-point with 36 decimals, for tokens worth a tiny fraction of a cent */
export const PRICE_SCALE = 10n ** 36n

/**
 * The price of one whole `token` in whole quote tokens, times PRICE_SCALE,
 * from a Uniswap v3 pool's sqrtPriceX96: the square root of the raw amount
 * of token1 per raw token0, as a Q64.96 number. The pool sorts its tokens by
 * address, so the token is token0 when its address is the lower one.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  tokenIsToken0: boolean,
  tokenDecimals: number,
  quoteDecimals: number,
): bigint {
  if (sqrtPriceX96 <= 0n) throw new Error('Pool has no price')
  const squared = sqrtPriceX96 * sqrtPriceX96
  const tokenUnit = 10n ** BigInt(tokenDecimals)
  const quoteUnit = 10n ** BigInt(quoteDecimals)
  return tokenIsToken0
    ? (squared * tokenUnit * PRICE_SCALE) / (Q192 * quoteUnit)
    : (Q192 * tokenUnit * PRICE_SCALE) / (squared * quoteUnit)
}

/** Whether `token` is token0 of its pool with `other` (lower address first) */
export function isToken0(token: string, other: string): boolean {
  return BigInt(token) < BigInt(other)
}

/**
 * A fixed-point price (see PRICE_SCALE) as a plain decimal string, rounded
 * to `significant` digits: '3012.4567', '0.0000081234'.
 */
export function formatPrice(scaled: bigint, significant = 8): string {
  if (scaled <= 0n) return '0'
  const length = scaled.toString().length
  if (length > significant) {
    const unit = 10n ** BigInt(length - significant)
    scaled = ((scaled + unit / 2n) / unit) * unit
  }
  const digits = scaled.toString().padStart(37, '0')
  const whole = digits.slice(0, -36).replace(/^0+(?=\d)/, '')
  const fraction = digits.slice(-36).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** The change from `before` to `now` in percent, with 2 decimals */
export function percentChange(before: string, now: string): string | undefined {
  const a = Number(before)
  const b = Number(now)
  if (!isFinite(a) || !isFinite(b) || a <= 0) return undefined
  const fixed = (((b - a) / a) * 100).toFixed(2)
  return fixed === '-0.00' ? '0.00' : fixed
}

/*
 * Cashtags
 */

const SYMBOL_RE = /^[A-Za-z][A-Za-z0-9]{1,9}$/
const CASHTAG_RE =
  /(^|[^\p{L}\p{N}_$&])\$([A-Za-z][A-Za-z0-9]{1,9})(?![\p{L}\p{N}_])/gu

/** A symbol as given by a client ('$eth', 'ETH'), upper case; null when malformed */
export function symbolKey(input: string): string | null {
  const symbol = input.trim().replace(/^\$/, '')
  return SYMBOL_RE.test(symbol) ? symbol.toUpperCase() : null
}

/**
 * The cashtags of a post ($ETH in its text, '$ETH' tag facets and tags), as
 * upper-case symbols. Symbols start with a letter, so prices ($5) are not
 * cashtags.
 */
export function postCashtags(record: unknown): string[] {
  const value = (record ?? {}) as {
    text?: unknown
    facets?: { features?: { $type?: string; tag?: unknown }[] }[]
    tags?: unknown[]
  }
  const found = new Set<string>()
  if (typeof value.text === 'string') {
    for (const match of value.text.slice(0, 10_000).matchAll(CASHTAG_RE)) {
      found.add(match[2].toUpperCase())
    }
  }
  const tags: unknown[] = [...(value.tags ?? [])]
  for (const facet of value.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature.$type === 'app.bsky.richtext.facet#tag')
        tags.push(feature.tag)
    }
  }
  for (const tag of tags.slice(0, 1000)) {
    if (typeof tag === 'string' && tag.startsWith('$')) {
      const key = symbolKey(tag)
      if (key) found.add(key)
    }
  }
  return [...found].slice(0, MAX_CASHTAGS_PER_POST)
}

export async function setPostCashtags(
  db: Database,
  uri: string,
  did: string,
  keys: string[],
) {
  await db.deleteFrom('post_cashtag').where('uri', '=', uri).execute()
  if (!keys.length) return
  const indexedAt = new Date().toISOString()
  await db
    .insertInto('post_cashtag')
    .values(keys.map((key) => ({ uri, did, key, indexedAt })))
    .execute()
}

export async function deletePostCashtags(db: Database, uri: string) {
  await db.deleteFrom('post_cashtag').where('uri', '=', uri).execute()
}

export async function deleteCashtagsForDid(db: Database, did: string) {
  await db.deleteFrom('post_cashtag').where('did', '=', did).execute()
}

/*
 * Pool reads
 */

const pad = (hex: string) =>
  hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const word = (res: string | null, index = 0) =>
  res && res.length >= 2 + 64 * (index + 1)
    ? BigInt('0x' + res.slice(2 + 64 * index, 2 + 64 * (index + 1)))
    : null
const wordAddress = (res: string | null) => {
  const value = word(res)
  return value === null ? null : '0x' + value.toString(16).padStart(40, '0')
}
const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase()

/** The pool's sqrtPriceX96 (slot0), or null when it cannot be read */
export async function readSqrtPrice(rpc: EvmRpc, pool: string) {
  return word(await rpc.ethCall(pool, '0x3850c7bd'))
}

/**
 * The Uniswap v3 pool of the two tokens with the most liquidity, among the
 * fee tiers; null when there is none (or the chain does not answer).
 */
export async function findPool(
  rpc: EvmRpc,
  factory: string,
  token: string,
  quote: string,
): Promise<string | null> {
  let best: { pool: string; liquidity: bigint } | null = null
  for (const fee of FEE_TIERS) {
    const pool = wordAddress(
      await rpc.ethCall(
        factory,
        '0x1698ee82' + pad(token) + pad(quote) + pad(fee.toString(16)),
      ),
    )
    if (!pool || BigInt(pool) === 0n) continue
    const liquidity = word(await rpc.ethCall(pool, '0x1a686502'))
    if (liquidity && (!best || liquidity > best.liquidity)) {
      best = { pool, liquidity }
    }
  }
  return best?.pool ?? null
}

/** Whether `pool` is a pool of exactly these two tokens */
export async function isPoolOf(
  rpc: EvmRpc,
  pool: string,
  token: string,
  quote: string,
): Promise<boolean> {
  const token0 = wordAddress(await rpc.ethCall(pool, '0x0dfe1681'))
  const token1 = wordAddress(await rpc.ethCall(pool, '0xd21220a7'))
  if (!token0 || !token1) return false
  return (
    (sameAddress(token0, token) && sameAddress(token1, quote)) ||
    (sameAddress(token0, quote) && sameAddress(token1, token))
  )
}

/*
 * The catalog
 */

export class TokenError extends Error {
  constructor(
    public code: 'InvalidToken' | 'NoPool',
    message: string,
  ) {
    super(message)
  }
}

export type TokenInput = {
  symbol: string
  name: string
  address: string
  quote?: string
  pool?: string
  logo?: string
}

export type TokenViewData = {
  id: string
  symbol: string
  name: string
  decimals: number
  chain: string
  address: string
  logo?: string
  priceUsd?: string
  change24h?: string
  updatedAt?: string
}

export type PriceRange = '1d' | '7d' | '30d'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** How far back each range goes, and the bucket that keeps one price (0: all) */
export const PRICE_RANGES: Record<
  PriceRange,
  { ms: number; bucketMs: number }
> = {
  '1d': { ms: DAY, bucketMs: 0 },
  '7d': { ms: 7 * DAY, bucketMs: 30 * 60 * 1000 },
  '30d': { ms: 30 * DAY, bucketMs: 2 * HOUR },
}

export class TokenCatalog {
  private keys = new Set<string>()
  private timer?: NodeJS.Timeout
  private sampling?: Promise<{ sampled: number; failed: number }>
  private wethUsdcPool?: string

  constructor(
    private db: Database,
    private opts: {
      /** Base JSON-RPC; without it the catalog has no prices */
      rpc?: EvmRpc
      factory?: string
      sampleIntervalMs?: number
      seed?: TokenSeed[]
    } = {},
  ) {}

  private get factory() {
    return this.opts.factory ?? UNISWAP_V3_FACTORY
  }

  /** Adds or refreshes the seed tokens (not those an admin changed or removed) */
  async init() {
    const now = new Date().toISOString()
    for (const seed of this.opts.seed ?? SEED_TOKENS) {
      const key = seed.symbol.toUpperCase()
      const row = await this.db
        .selectFrom('token')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirst()
      if (!row) {
        await this.db
          .insertInto('token')
          .values({
            key,
            symbol: seed.symbol,
            name: seed.name,
            chain: BASE_CHAIN,
            address: seed.address,
            decimals: seed.decimals,
            quote: seed.quote,
            pool: null,
            logo: null,
            source: 'seed',
            removed: 0,
            priceUsd: null,
            updatedAt: null,
            addedAt: now,
          })
          .execute()
      } else if (row.source === 'seed') {
        const moved =
          !sameAddress(row.address, seed.address) || row.quote !== seed.quote
        await this.db
          .updateTable('token')
          .set({
            symbol: seed.symbol,
            name: seed.name,
            address: seed.address,
            decimals: seed.decimals,
            quote: seed.quote,
            ...(moved ? { pool: null, priceUsd: null, updatedAt: null } : {}),
          })
          .where('key', '=', key)
          .execute()
        if (moved) {
          await this.db
            .deleteFrom('token_price')
            .where('key', '=', key)
            .execute()
        }
      }
    }
    await this.reload()
  }

  private async reload() {
    const rows = await this.db
      .selectFrom('token')
      .select('key')
      .where('removed', '=', 0)
      .execute()
    this.keys = new Set(rows.map((r) => r.key))
  }

  /** Whether `key` (an upper-case symbol) is in the catalog */
  has(key: string) {
    return this.keys.has(key)
  }

  /** Indexes the post's cashtags of catalog tokens (and clears others) */
  async indexPost(uri: string, did: string, record: unknown) {
    const keys = postCashtags(record).filter((key) => this.keys.has(key))
    await setPostCashtags(this.db, uri, did, keys)
  }

  start() {
    if (!this.opts.rpc) return
    const run = () =>
      void this.sample().catch((err: unknown) =>
        console.error('Krao indexer: token price round failed', err),
      )
    run()
    const ms = this.opts.sampleIntervalMs
    // At most one round every 10 seconds, whatever the setting says
    this.timer = setInterval(
      run,
      ms !== undefined && Number.isFinite(ms)
        ? Math.max(ms, 10_000)
        : PRICE_SAMPLE_MS,
    )
    this.timer.unref?.()
  }

  async destroy() {
    clearInterval(this.timer)
    await this.sampling?.catch(() => undefined)
  }

  /** Reads every catalog price once and adds it to the history */
  sample(): Promise<{ sampled: number; failed: number }> {
    // One round at a time: the timer and the admin method share it
    this.sampling ??= this.sampleRound().finally(() => {
      this.sampling = undefined
    })
    return this.sampling
  }

  private async sampleRound() {
    const tokens = await this.db
      .selectFrom('token')
      .selectAll()
      .where('removed', '=', 0)
      .execute()
    let sampled = 0
    let failed = 0
    const now = new Date().toISOString()
    let wethUsd: bigint | null | undefined
    for (const token of tokens) {
      try {
        let price: bigint | null
        if (token.quote === 'WETH') {
          wethUsd ??= await this.wethUsd()
          const inWeth = await this.priceInQuote(token)
          price =
            inWeth !== null && wethUsd !== null
              ? (inWeth * wethUsd) / PRICE_SCALE
              : null
        } else {
          price = await this.priceInQuote(token)
        }
        if (price === null || price <= 0n) {
          failed++
          continue
        }
        const priceUsd = formatPrice(price)
        await this.db
          .insertInto('token_price')
          .values({ key: token.key, t: now, priceUsd })
          .onConflict((oc) => oc.columns(['key', 't']).doNothing())
          .execute()
        await this.db
          .updateTable('token')
          .set({ priceUsd, updatedAt: now })
          .where('key', '=', token.key)
          .execute()
        sampled++
      } catch (err) {
        failed++
        console.error(`Krao indexer: price of ${token.symbol} failed`, err)
      }
    }
    await this.db
      .deleteFrom('token_price')
      .where('t', '<', new Date(Date.now() - PRICE_RETENTION_MS).toISOString())
      .execute()
    return { sampled, failed }
  }

  /** The token's price in its quote token (USD for 'usd'), or null */
  private async priceInQuote(token: TokenTable): Promise<bigint | null> {
    if (token.quote === 'usd') return PRICE_SCALE
    const rpc = this.opts.rpc
    if (!rpc) return null
    const quote = QUOTES[token.quote]
    let pool = token.pool
    if (!pool) {
      pool = await findPool(rpc, this.factory, token.address, quote.address)
      if (!pool) return null
      await this.db
        .updateTable('token')
        .set({ pool })
        .where('key', '=', token.key)
        .execute()
    }
    const sqrtPrice = await readSqrtPrice(rpc, pool)
    if (!sqrtPrice) return null
    return priceFromSqrtX96(
      sqrtPrice,
      isToken0(token.address, quote.address),
      token.decimals,
      quote.decimals,
    )
  }

  /** WETH in USD (through USDC), for tokens priced against WETH */
  private async wethUsd(): Promise<bigint | null> {
    const rpc = this.opts.rpc
    if (!rpc) return null
    this.wethUsdcPool ??=
      (await findPool(rpc, this.factory, WETH, USDC)) ?? undefined
    if (!this.wethUsdcPool) return null
    const sqrtPrice = await readSqrtPrice(rpc, this.wethUsdcPool)
    return sqrtPrice
      ? priceFromSqrtX96(sqrtPrice, isToken0(WETH, USDC), 18, 6)
      : null
  }

  async getToken(symbol: string): Promise<TokenTable | undefined> {
    const key = symbolKey(symbol)
    if (!key) return undefined
    return this.db
      .selectFrom('token')
      .selectAll()
      .where('key', '=', key)
      .where('removed', '=', 0)
      .executeTakeFirst()
  }

  async listTokens(): Promise<TokenTable[]> {
    return this.db
      .selectFrom('token')
      .selectAll()
      .where('removed', '=', 0)
      .orderBy('key')
      .execute()
  }

  /** The token as the API shows it, with its 24 hour change */
  async view(token: TokenTable, now = Date.now()): Promise<TokenViewData> {
    let change24h: string | undefined
    if (token.priceUsd) {
      // The last price from 24 hours ago, if one was read within the hour before
      const before = await this.db
        .selectFrom('token_price')
        .select('priceUsd')
        .where('key', '=', token.key)
        .where('t', '<=', new Date(now - DAY).toISOString())
        .where('t', '>=', new Date(now - DAY - HOUR).toISOString())
        .orderBy('t', 'desc')
        .limit(1)
        .executeTakeFirst()
      if (before) change24h = percentChange(before.priceUsd, token.priceUsd)
    }
    return {
      id: `${token.chain}/erc20:${token.address}`,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      chain: token.chain,
      address: token.address,
      ...(token.logo ? { logo: token.logo } : {}),
      ...(token.priceUsd ? { priceUsd: token.priceUsd } : {}),
      ...(change24h !== undefined ? { change24h } : {}),
      ...(token.updatedAt ? { updatedAt: token.updatedAt } : {}),
    }
  }

  /** Prices over the range, oldest first, one per bucket (the last) */
  async priceHistory(
    key: string,
    range: PriceRange,
    now = Date.now(),
  ): Promise<{ t: string; priceUsd: string }[]> {
    const { ms, bucketMs } = PRICE_RANGES[range]
    const rows = await this.db
      .selectFrom('token_price')
      .select(['t', 'priceUsd'])
      .where('key', '=', key)
      .where('t', '>=', new Date(now - ms).toISOString())
      .orderBy('t')
      .execute()
    if (!bucketMs) return rows
    const points: { t: string; priceUsd: string }[] = []
    let lastBucket: number | undefined
    for (const row of rows) {
      const bucket = Math.floor(Date.parse(row.t) / bucketMs)
      if (bucket === lastBucket) points[points.length - 1] = row
      else points.push(row)
      lastBucket = bucket
    }
    return points
  }

  /** Posts mentioning the token, newest first. The cursor is `<indexedAt>::<uri>`. */
  async feed(key: string, limit: number, cursor?: string) {
    let qb = this.db
      .selectFrom('post_cashtag')
      .select(['uri', 'indexedAt'])
      .where('key', '=', key)
      .where(visibleDid('did'))
      .orderBy('indexedAt', 'desc')
      .orderBy('uri', 'desc')
      .limit(limit)
    if (cursor) {
      const [indexedAt, uri] = cursor.split('::')
      if (!indexedAt || !uri) throw new Error('Malformed cursor')
      qb = qb.where((eb) =>
        eb.or([
          eb('indexedAt', '<', indexedAt),
          eb.and([eb('indexedAt', '=', indexedAt), eb('uri', '<', uri)]),
        ]),
      )
    }
    const rows = await qb.execute()
    const last = rows.at(-1)
    return {
      uris: rows.map((r) => r.uri),
      cursor:
        rows.length === limit && last
          ? `${last.indexedAt}::${last.uri}`
          : undefined,
    }
  }

  /** Adds a token or changes one (see net.krao.token.admin.putToken) */
  async putToken(input: TokenInput): Promise<TokenTable> {
    const key = symbolKey(input.symbol)
    if (!key || input.symbol.trim().startsWith('$')) {
      throw new TokenError(
        'InvalidToken',
        'Symbol must be a letter then letters or digits (2-10 characters)',
      )
    }
    const symbol = input.symbol.trim()
    const name = input.name.trim()
    if (!name) throw new TokenError('InvalidToken', 'Name is required')
    const address = input.address.trim()
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new TokenError('InvalidToken', 'Malformed token address')
    }
    if (input.logo !== undefined && !/^https:\/\/\S+$/.test(input.logo)) {
      throw new TokenError('InvalidToken', 'Logo must be an https URL')
    }
    const quote = (input.quote ?? 'USDC') as TokenQuote
    if (quote !== 'USDC' && quote !== 'WETH' && quote !== 'usd') {
      throw new TokenError('InvalidToken', 'Quote must be USDC, WETH or usd')
    }
    if (quote !== 'usd' && sameAddress(address, QUOTES[quote].address)) {
      throw new TokenError('InvalidToken', 'A token cannot be priced in itself')
    }
    const rpc = this.opts.rpc
    if (!rpc) throw new TokenError('InvalidToken', 'No Base RPC to check it')
    const decimals = word(await rpc.ethCall(address, '0x313ce567'))
    if (decimals === null || decimals > 36n) {
      throw new TokenError('InvalidToken', 'Not an ERC-20 token on Base')
    }
    let pool: string | null = null
    if (quote !== 'usd') {
      const quoteAddress = QUOTES[quote].address
      if (input.pool) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(input.pool)) {
          throw new TokenError('NoPool', 'Malformed pool address')
        }
        if (!(await isPoolOf(rpc, input.pool, address, quoteAddress))) {
          throw new TokenError('NoPool', `Not a pool of the token and ${quote}`)
        }
        pool = input.pool
      } else {
        pool = await findPool(rpc, this.factory, address, quoteAddress)
        if (!pool) {
          throw new TokenError('NoPool', `No Uniswap v3 pool with ${quote}`)
        }
      }
    }
    const old = await this.db
      .selectFrom('token')
      .selectAll()
      .where('key', '=', key)
      .executeTakeFirst()
    // Another token or pool: earlier prices are not its prices
    const samePrice =
      old &&
      !old.removed &&
      sameAddress(old.address, address) &&
      old.quote === quote &&
      (old.pool ?? '').toLowerCase() === (pool ?? '').toLowerCase()
    const row: TokenTable = {
      key,
      symbol,
      name,
      chain: BASE_CHAIN,
      address,
      decimals: Number(decimals),
      quote,
      pool,
      logo: input.logo ?? null,
      source: 'admin',
      removed: 0,
      priceUsd: samePrice ? old.priceUsd : null,
      updatedAt: samePrice ? old.updatedAt : null,
      addedAt: old?.addedAt ?? new Date().toISOString(),
    }
    if (!samePrice) {
      await this.db.deleteFrom('token_price').where('key', '=', key).execute()
    }
    await this.db
      .insertInto('token')
      .values(row)
      .onConflict((oc) => oc.column('key').doUpdateSet(row))
      .execute()
    await this.reload()
    return row
  }

  /** Takes a token out of the catalog; false when it was not in it */
  async removeToken(symbol: string): Promise<boolean> {
    const key = symbolKey(symbol)
    if (!key) return false
    const row = await this.db
      .selectFrom('token')
      .select(['source', 'removed'])
      .where('key', '=', key)
      .executeTakeFirst()
    if (!row || row.removed) return false
    const seeded = (this.opts.seed ?? SEED_TOKENS).some(
      (seed) => seed.symbol.toUpperCase() === key,
    )
    if (row.source === 'seed' || seeded) {
      // Kept as removed, or the next start would add it again
      await this.db
        .updateTable('token')
        .set({ removed: 1, priceUsd: null, updatedAt: null })
        .where('key', '=', key)
        .execute()
    } else {
      await this.db.deleteFrom('token').where('key', '=', key).execute()
    }
    await this.db.deleteFrom('token_price').where('key', '=', key).execute()
    await this.db.deleteFrom('post_cashtag').where('key', '=', key).execute()
    await this.reload()
    return true
  }
}
