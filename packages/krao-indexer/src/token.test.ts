import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import {
  PRICE_SCALE,
  SEED_TOKENS,
  TokenCatalog,
  USDC,
  UNISWAP_V3_FACTORY,
  WETH,
  findPool,
  formatPrice,
  isToken0,
  percentChange,
  postCashtags,
  priceFromSqrtX96,
  symbolKey,
} from './token.js'

const Q192 = 1n << 192n
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
const DEGEN = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'

function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

/**
 * The sqrtPriceX96 of a pool where one whole `token` costs `price` whole
 * quote tokens (price as a fraction num/den)
 */
function sqrtX96For(
  token: { address: string; decimals: number },
  quote: { address: string; decimals: number },
  num: bigint,
  den = 1n,
) {
  const tokenUnit = 10n ** BigInt(token.decimals)
  const quoteUnit = 10n ** BigInt(quote.decimals)
  // raw token1 per raw token0
  return isToken0(token.address, quote.address)
    ? isqrt((num * quoteUnit * Q192) / (den * tokenUnit))
    : isqrt((den * tokenUnit * Q192) / (num * quoteUnit))
}

describe('priceFromSqrtX96', () => {
  const weth = { address: WETH, decimals: 18 }
  const usdc = { address: USDC, decimals: 6 }
  const cbbtc = { address: CBBTC, decimals: 8 }

  it('prices token0 in token1 (WETH/USDC on Base: WETH is token0)', () => {
    expect(isToken0(WETH, USDC)).toBe(true)
    const sqrt = sqrtX96For(weth, usdc, 3000n)
    const price = priceFromSqrtX96(sqrt, true, 18, 6)
    expect(formatPrice(price)).toBe('3000')
  })

  it('prices token1 in token0 (cbBTC/USDC: cbBTC is token1)', () => {
    expect(isToken0(CBBTC, USDC)).toBe(false)
    const sqrt = sqrtX96For(cbbtc, usdc, 61234n)
    const price = priceFromSqrtX96(sqrt, false, 8, 6)
    expect(formatPrice(price)).toBe('61234')
  })

  it('handles cheap tokens with more decimals than the quote', () => {
    // DEGEN at 0.0000123 WETH: 0x4200… < 0x4ed4…, so DEGEN is token1
    const degen = { address: DEGEN, decimals: 18 }
    expect(isToken0(DEGEN, WETH)).toBe(false)
    const sqrt = sqrtX96For(degen, weth, 123n, 10_000_000n)
    expect(formatPrice(priceFromSqrtX96(sqrt, false, 18, 18))).toBe('0.0000123')
  })

  it('matches a known mainnet-style sqrtPriceX96', () => {
    // 2^96 means 1 raw token1 per raw token0: WETH (18) in USDC (6) is 1e12
    const price = priceFromSqrtX96(1n << 96n, true, 18, 6)
    expect(price).toBe(10n ** 12n * PRICE_SCALE)
    // And the other way round, 1e-12
    expect(formatPrice(priceFromSqrtX96(1n << 96n, false, 6, 18))).toBe(
      '0.000000000001',
    )
  })

  it('refuses a pool without a price', () => {
    expect(() => priceFromSqrtX96(0n, true, 18, 6)).toThrow()
  })
})

describe('formatPrice and percentChange', () => {
  it('rounds to 8 significant digits without exponents', () => {
    expect(formatPrice(3012456789n * 10n ** 30n)).toBe('3012.4568')
    expect(formatPrice((PRICE_SCALE * 3n) / 2n)).toBe('1.5')
    expect(formatPrice(1n)).toBe('0.' + '0'.repeat(35) + '1')
    expect(formatPrice(0n)).toBe('0')
    expect(formatPrice(99999999999n * 10n ** 26n)).toBe('10')
  })

  it('gives the change in percent with 2 decimals', () => {
    expect(percentChange('100', '102.5')).toBe('2.50')
    expect(percentChange('3000', '2900')).toBe('-3.33')
    expect(percentChange('1', '1.0000001')).toBe('0.00')
    expect(percentChange('1', '0.9999999')).toBe('0.00')
    expect(percentChange('0', '1')).toBeUndefined()
  })
})

describe('cashtags', () => {
  it('finds $SYMBOL in text, any case, upper-cased', () => {
    expect(
      postCashtags({ text: '$ETH lên 3k, còn $cbBTC thì sao? ($degen)' }),
    ).toEqual(['ETH', 'CBBTC', 'DEGEN'])
  })

  it('ignores prices, words with $ inside and long symbols', () => {
    expect(
      postCashtags({
        text: 'Giá $5, 10$ETH, US$ETH, a$b, $$ETH, $TOOLONGSYMBOL1, $E',
      }),
    ).toEqual([])
  })

  it('stops at punctuation, not at letters', () => {
    expect(postCashtags({ text: 'Mua $ETH. Bán $USDC, giữ $ETHX' })).toEqual([
      'ETH',
      'USDC',
      'ETHX',
    ])
    expect(postCashtags({ text: '$ETHé' })).toEqual([])
  })

  it('reads $ tag facets and tags, not hashtags', () => {
    expect(
      postCashtags({
        text: 'nothing here',
        facets: [
          {
            features: [
              { $type: 'app.bsky.richtext.facet#tag', tag: '$DEGEN' },
              { $type: 'app.bsky.richtext.facet#tag', tag: 'ETH' },
              { $type: 'app.bsky.richtext.facet#link', tag: '$USDC' },
            ],
          },
        ],
        tags: ['$usdc', '#ETH', 42],
      }),
    ).toEqual(['USDC', 'DEGEN'])
  })

  it('dedupes and caps per post', () => {
    const text = Array.from({ length: 20 }, (_, i) => `$TK${i} $TK${i}`).join(
      ' ',
    )
    expect(postCashtags({ text })).toHaveLength(10)
    expect(postCashtags(null)).toEqual([])
  })

  it('normalizes symbols from clients', () => {
    expect(symbolKey('$eth')).toBe('ETH')
    expect(symbolKey(' cbBTC ')).toBe('CBBTC')
    expect(symbolKey('5X')).toBeNull()
    expect(symbolKey('E')).toBeNull()
  })
})

/*
 * The catalog against a fake chain
 */

const POOLS = {
  wethUsdc500: '0x00000000000000000000000000000000000000a1',
  wethUsdc3000: '0x00000000000000000000000000000000000000a2',
  cbbtcUsdc: '0x00000000000000000000000000000000000000b1',
  degenWeth: '0x00000000000000000000000000000000000000c1',
  newUsdc: '0x00000000000000000000000000000000000000d1',
}
const NEW_TOKEN = '0x00000000000000000000000000000000000000e1'

const word = (n: bigint | number | string) =>
  BigInt(n).toString(16).padStart(64, '0')

class FakeChain {
  calls: string[] = []
  down = false
  ethUsd = 3000n
  pools = new Map<
    string,
    { token0: string; token1: string; liquidity: bigint; fee: number }
  >()
  decimals = new Map<string, number>([
    [WETH.toLowerCase(), 18],
    [USDC.toLowerCase(), 6],
    [CBBTC.toLowerCase(), 8],
    [DEGEN.toLowerCase(), 18],
    [NEW_TOKEN, 18],
  ])

  constructor() {
    const pool = (
      address: string,
      a: string,
      b: string,
      fee: number,
      liquidity: bigint,
    ) => {
      const [token0, token1] = isToken0(a, b) ? [a, b] : [b, a]
      this.pools.set(address, {
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        liquidity,
        fee,
      })
    }
    pool(POOLS.wethUsdc500, WETH, USDC, 500, 10n ** 20n)
    pool(POOLS.wethUsdc3000, WETH, USDC, 3000, 10n ** 18n)
    pool(POOLS.cbbtcUsdc, CBBTC, USDC, 500, 10n ** 15n)
    pool(POOLS.degenWeth, DEGEN, WETH, 3000, 10n ** 22n)
    pool(POOLS.newUsdc, NEW_TOKEN, USDC, 10000, 10n ** 10n)
  }

  price(pool: string): bigint {
    const usdc = { address: USDC, decimals: 6 }
    const weth = { address: WETH, decimals: 18 }
    if (pool === POOLS.wethUsdc500 || pool === POOLS.wethUsdc3000) {
      return sqrtX96For(weth, usdc, this.ethUsd)
    }
    if (pool === POOLS.cbbtcUsdc) {
      return sqrtX96For({ address: CBBTC, decimals: 8 }, usdc, 60000n)
    }
    if (pool === POOLS.degenWeth) {
      // 0.00001 WETH
      return sqrtX96For({ address: DEGEN, decimals: 18 }, weth, 1n, 100000n)
    }
    return sqrtX96For({ address: NEW_TOKEN, decimals: 18 }, usdc, 2n)
  }

  rpc = {
    ethCall: async (to: string, data: string): Promise<string | null> => {
      if (this.down) return null
      to = to.toLowerCase()
      const selector = data.slice(0, 10)
      this.calls.push(`${to}:${selector}`)
      if (selector === '0x313ce567') {
        const d = this.decimals.get(to)
        return d === undefined ? null : '0x' + word(d)
      }
      if (
        to === UNISWAP_V3_FACTORY.toLowerCase() &&
        selector === '0x1698ee82'
      ) {
        const a = '0x' + data.slice(10 + 24, 10 + 64)
        const b = '0x' + data.slice(10 + 64 + 24, 10 + 128)
        const fee = Number(BigInt('0x' + data.slice(10 + 128, 10 + 192)))
        for (const [address, p] of this.pools) {
          const pair = [p.token0, p.token1]
          if (pair.includes(a) && pair.includes(b) && p.fee === fee) {
            return '0x' + word(address)
          }
        }
        return '0x' + word(0)
      }
      const pool = this.pools.get(to)
      if (!pool) return null
      if (selector === '0x1a686502') return '0x' + word(pool.liquidity)
      if (selector === '0x0dfe1681') return '0x' + word(pool.token0)
      if (selector === '0xd21220a7') return '0x' + word(pool.token1)
      if (selector === '0x3850c7bd') {
        return '0x' + word(this.price(to)) + word(0).repeat(6)
      }
      return null
    },
  }
}

describe('TokenCatalog', () => {
  let db: Database
  let chain: FakeChain
  let catalog: TokenCatalog

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    chain = new FakeChain()
    catalog = new TokenCatalog(db, { rpc: chain.rpc as unknown as EvmRpc })
    await catalog.init()
  })

  afterEach(async () => {
    await catalog.destroy()
    await db.destroy()
  })

  it('seeds the catalog once', async () => {
    const tokens = await catalog.listTokens()
    expect(tokens.map((t) => t.symbol).sort()).toEqual(
      SEED_TOKENS.map((t) => t.symbol).sort(),
    )
    await catalog.init()
    expect(await catalog.listTokens()).toHaveLength(SEED_TOKENS.length)
    const eth = await catalog.getToken('$eth')
    expect(eth?.address).toBe(WETH)
    expect(await catalog.getToken('NOPE')).toBeUndefined()
  })

  it('finds the pool with the most liquidity', async () => {
    const pool = await findPool(
      chain.rpc as unknown as EvmRpc,
      UNISWAP_V3_FACTORY,
      WETH,
      USDC,
    )
    expect(pool).toBe(POOLS.wethUsdc500)
  })

  it('reads prices in USDC, in WETH through WETH/USDC, and USDC as 1', async () => {
    expect(await catalog.sample()).toEqual({ sampled: 4, failed: 0 })
    const price = async (s: string) => (await catalog.getToken(s))?.priceUsd
    expect(await price('ETH')).toBe('3000')
    expect(await price('cbBTC')).toBe('60000')
    expect(await price('DEGEN')).toBe('0.03')
    expect(await price('USDC')).toBe('1')
    const view = await catalog.view((await catalog.getToken('ETH'))!)
    expect(view).toMatchObject({
      id: `eip155:8453/erc20:${WETH}`,
      symbol: 'ETH',
      chain: 'eip155:8453',
      decimals: 18,
      priceUsd: '3000',
    })
    expect(view.updatedAt).toBeTruthy()
    expect(view.change24h).toBeUndefined()
    expect(view.logo).toBeUndefined()
    // Pools are found once
    const lookups = chain.calls.filter((c) => c.endsWith('0x1698ee82')).length
    await catalog.sample()
    expect(chain.calls.filter((c) => c.endsWith('0x1698ee82')).length).toBe(
      lookups,
    )
  })

  it('counts failures when the chain does not answer', async () => {
    chain.down = true
    expect(await catalog.sample()).toEqual({ sampled: 1, failed: 3 })
    expect((await catalog.getToken('ETH'))?.priceUsd).toBeNull()
  })

  it('keeps a history, bucketed for long ranges, with a 24h change', async () => {
    const now = Date.parse('2026-10-16T12:00:00.000Z')
    const rows = []
    // A price every 5 minutes for 2 days, going from 2000 up
    for (let i = 0; i <= 2 * 24 * 12; i++) {
      rows.push({
        key: 'ETH',
        t: new Date(now - i * 5 * 60 * 1000).toISOString(),
        priceUsd: String(2000 + (2 * 24 * 12 - i)),
      })
    }
    await db.insertInto('token_price').values(rows).execute()
    await db
      .updateTable('token')
      .set({ priceUsd: '2576', updatedAt: new Date(now).toISOString() })
      .where('key', '=', 'ETH')
      .execute()
    const day = await catalog.priceHistory('ETH', '1d', now)
    expect(day).toHaveLength(24 * 12 + 1)
    expect(day[0].t < day[day.length - 1].t).toBe(true)
    const week = await catalog.priceHistory('ETH', '7d', now)
    // 48 hours in 30-minute buckets, the last price of each
    expect(week.length).toBeGreaterThanOrEqual(96)
    expect(week.length).toBeLessThanOrEqual(98)
    expect(week[week.length - 1].priceUsd).toBe('2576')
    const view = await catalog.view((await catalog.getToken('ETH'))!, now)
    // 24h ago the price was 2576 - 288 = 2288
    expect(view.change24h).toBe(percentChange('2288', '2576'))
  })

  it('indexes cashtags of catalog tokens only, newest first', async () => {
    await catalog.indexPost('at://did:a/app.bsky.feed.post/1', 'did:a', {
      text: '$ETH và $PEPE',
    })
    await catalog.indexPost('at://did:b/app.bsky.feed.post/2', 'did:b', {
      text: 'gm $eth $degen',
    })
    const page = await catalog.feed('ETH', 1)
    expect(page.uris).toEqual(['at://did:b/app.bsky.feed.post/2'])
    const next = await catalog.feed('ETH', 1, page.cursor)
    expect(next.uris).toEqual(['at://did:a/app.bsky.feed.post/1'])
    expect((await catalog.feed('PEPE', 10)).uris).toEqual([])
    // Hidden accounts are not served
    await db
      .insertInto('hidden_actor')
      .values({ did: 'did:b', status: 'takendown', since: 'x' })
      .execute()
    expect((await catalog.feed('ETH', 10)).uris).toEqual([
      'at://did:a/app.bsky.feed.post/1',
    ])
    // An edit that drops the cashtag drops the post
    await catalog.indexPost('at://did:a/app.bsky.feed.post/1', 'did:a', {
      text: 'no tags',
    })
    expect((await catalog.feed('ETH', 10)).uris).toEqual([])
  })

  it('lets admins add tokens, checked on-chain', async () => {
    await expect(
      catalog.putToken({ symbol: '1BAD', name: 'x', address: NEW_TOKEN }),
    ).rejects.toMatchObject({ code: 'InvalidToken' })
    await expect(
      catalog.putToken({
        symbol: 'NOPE',
        name: 'Not a token',
        address: '0x00000000000000000000000000000000000000f1',
      }),
    ).rejects.toMatchObject({ code: 'InvalidToken' })
    await expect(
      catalog.putToken({
        symbol: 'NEW',
        name: 'New',
        address: NEW_TOKEN,
        quote: 'WETH',
      }),
    ).rejects.toMatchObject({ code: 'NoPool' })
    await expect(
      catalog.putToken({
        symbol: 'NEW',
        name: 'New',
        address: NEW_TOKEN,
        pool: POOLS.cbbtcUsdc,
      }),
    ).rejects.toMatchObject({ code: 'NoPool' })
    await expect(
      catalog.putToken({
        symbol: 'NEW',
        name: 'New',
        address: NEW_TOKEN,
        logo: 'http://example.com/a.png',
      }),
    ).rejects.toMatchObject({ code: 'InvalidToken' })

    const row = await catalog.putToken({
      symbol: 'New',
      name: 'New Token',
      address: NEW_TOKEN,
      logo: 'https://example.com/new.png',
    })
    expect(row).toMatchObject({ key: 'NEW', pool: POOLS.newUsdc, decimals: 18 })
    expect(catalog.has('NEW')).toBe(true)
    await catalog.sample()
    expect((await catalog.getToken('new'))?.priceUsd).toBe('2')
    await catalog.indexPost('at://did:a/app.bsky.feed.post/3', 'did:a', {
      text: '$NEW',
    })
    expect((await catalog.feed('NEW', 10)).uris).toHaveLength(1)
  })

  it('removes tokens, and seed tokens stay removed', async () => {
    await catalog.sample()
    await catalog.indexPost('at://did:a/app.bsky.feed.post/1', 'did:a', {
      text: '$DEGEN',
    })
    expect(await catalog.removeToken('degen')).toBe(true)
    expect(await catalog.removeToken('degen')).toBe(false)
    expect(await catalog.getToken('DEGEN')).toBeUndefined()
    expect(catalog.has('DEGEN')).toBe(false)
    expect((await catalog.feed('DEGEN', 10)).uris).toEqual([])
    expect(
      await db
        .selectFrom('token_price')
        .where('key', '=', 'DEGEN')
        .selectAll()
        .execute(),
    ).toEqual([])
    await catalog.init()
    expect(await catalog.getToken('DEGEN')).toBeUndefined()
    // An admin can bring it back
    await catalog.putToken({
      symbol: 'DEGEN',
      name: 'Degen',
      address: DEGEN,
      quote: 'WETH',
    })
    expect((await catalog.getToken('DEGEN'))?.pool).toBe(POOLS.degenWeth)
  })
})
