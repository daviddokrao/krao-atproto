// Token pages (M30): the curated catalog, prices read from Uniswap v3 pools
// on the Anvil Base fork, the price history, and posts mentioning a token as
// a cashtag. Needs the dev-env (rewards-admin.test is a safety admin, which
// also runs the token admin methods). Nothing here buys or sells.
import {
  ACCOUNTS,
  GATE_DID,
  INDEXER,
  USDC,
  checker,
  createRecord,
  deleteRecord,
  login,
  pad32,
  rpc,
  serviceAuth,
  sleep,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)
const WETH = '0x4200000000000000000000000000000000000006'
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'

const token = (method, query) =>
  xrpc(INDEXER, `net.krao.token.${method}`, { query })

/** A token admin method on the indexer, called as `session` */
async function admin(session, method, body = {}) {
  const lxm = `net.krao.token.admin.${method}`
  const auth = await serviceAuth(session, lxm, GATE_DID)
  return xrpc(INDEXER, lxm, { token: auth, body })
}

/** WETH in USDC from the deepest WETH/USDC Uniswap v3 pool, read here */
async function wethUsdFromChain() {
  let best = null
  for (const fee of [100, 500, 3000, 10000]) {
    const res = await rpc('eth_call', [
      {
        to: FACTORY,
        data:
          '0x1698ee82' + pad32(WETH) + pad32(USDC) + pad32(fee.toString(16)),
      },
      'latest',
    ])
    const pool = '0x' + res.slice(-40)
    if (BigInt(pool) === 0n) continue
    const liquidity = BigInt(
      await rpc('eth_call', [{ to: pool, data: '0x1a686502' }, 'latest']),
    )
    if (!best || liquidity > best.liquidity) best = { pool, liquidity }
  }
  const slot0 = await rpc('eth_call', [
    { to: best.pool, data: '0x3850c7bd' },
    'latest',
  ])
  // WETH is token0: token1 (USDC) per token0, raw, then 18 - 6 decimals
  const sqrt = Number(BigInt(slot0.slice(0, 66))) / 2 ** 96
  return sqrt * sqrt * 1e12
}

const safetyAdmin = await login(ACCOUNTS.rewardsAdmin, { phone: false })
const krao = await login(ACCOUNTS.krao)

/*
 * Catalog and prices
 */

const list = await token('listTokens')
const symbols = list.data.tokens?.map((t) => t.symbol) ?? []
check(
  'listTokens has the seed tokens',
  ['ETH', 'USDC', 'cbBTC', 'DEGEN'].every((s) => symbols.includes(s)),
  JSON.stringify(symbols),
)

const denied = await admin(krao, 'samplePrices')
check(
  'only token admins read prices on demand',
  denied.status === 403,
  denied.status,
)
const sampled = await admin(safetyAdmin, 'samplePrices')
check(
  'samplePrices reads every catalog price from the fork',
  sampled.ok && sampled.data.sampled >= 4 && sampled.data.failed === 0,
  JSON.stringify(sampled.data),
)

const eth = await token('getToken', { symbol: 'eth' })
const view = eth.data.token
check(
  'getToken ETH (any case) is WETH on Base',
  eth.ok &&
    view.symbol === 'ETH' &&
    view.chain === 'eip155:8453' &&
    view.address.toLowerCase() === WETH &&
    view.id === `eip155:8453/erc20:${view.address}` &&
    view.decimals === 18,
  JSON.stringify(eth.data),
)
const onChain = await wethUsdFromChain()
const price = Number(view?.priceUsd)
check(
  'its price is the pool price on the fork',
  price > 0 && Math.abs(price - onChain) / onChain < 0.001,
  `${view?.priceUsd} vs ${onChain}`,
)
check(
  'with the time it was read',
  !!view?.updatedAt && Date.now() - Date.parse(view.updatedAt) < 60_000,
  view?.updatedAt,
)
check(
  'and no 24h change yet on a fresh dev-env (or a decimal string)',
  view?.change24h === undefined || /^-?\d+\.\d{2}$/.test(view.change24h),
  view?.change24h,
)
const usdc = await token('getToken', { symbol: '$USDC' })
check(
  'USDC is one dollar',
  usdc.data.token?.priceUsd === '1',
  JSON.stringify(usdc.data),
)
const degen = await token('getToken', { symbol: 'DEGEN' })
check(
  'DEGEN is priced through WETH',
  Number(degen.data.token?.priceUsd) > 0 &&
    Number(degen.data.token?.priceUsd) < 1,
  degen.data.token?.priceUsd,
)

const missing = await token('getToken', { symbol: 'NOTATOKEN' })
check(
  'an unknown symbol is NotFound',
  missing.status === 400 && missing.data.error === 'NotFound',
  JSON.stringify(missing.data),
)

/*
 * Price history
 */

const before = await token('getPriceHistory', { symbol: 'ETH', range: '1d' })
await sleep(5)
await admin(safetyAdmin, 'samplePrices')
const after = await token('getPriceHistory', { symbol: 'ETH', range: '1d' })
const points = after.data.points ?? []
check(
  'the history grows with each round, oldest first',
  before.ok &&
    // +1, or more if the 5-minute round ran meanwhile
    points.length >= before.data.points.length + 1 &&
    points.every((p, i) => i === 0 || points[i - 1].t <= p.t) &&
    points.at(-1).priceUsd ===
      (await token('getToken', { symbol: 'ETH' })).data.token.priceUsd,
  `${before.data.points?.length} -> ${points.length}`,
)
const week = await token('getPriceHistory', { symbol: 'ETH', range: '30d' })
check('30d works too', week.ok && week.data.points.length >= 1)
const badRange = await token('getPriceHistory', { symbol: 'ETH', range: '1y' })
check('an unknown range is refused', badRange.status === 400)

/*
 * Cashtag feed
 */

const tagged = await createRecord(krao, 'app.bsky.feed.post', {
  text: `Giá $ETH hôm nay thế nào? ${stamp}`,
  createdAt: new Date().toISOString(),
})
const facet = await createRecord(krao, 'app.bsky.feed.post', {
  text: `Thử cashtag facet ${stamp}`,
  facets: [
    {
      index: { byteStart: 0, byteEnd: 3 },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: '$DEGEN' }],
    },
  ],
  createdAt: new Date().toISOString(),
})
const untagged = await createRecord(krao, 'app.bsky.feed.post', {
  text: `Không có cashtag, chỉ $5 và $NOTATOKEN ${stamp}`,
  createdAt: new Date().toISOString(),
})

let feed
for (let i = 0; i < 20; i++) {
  feed = await token('getFeed', { symbol: 'ETH', limit: 10 })
  if (feed.data.feed?.some((f) => f.post === tagged.data.uri)) break
  await sleep(500)
}
check(
  'a post with $ETH is in getFeed ETH, newest first',
  feed.data.feed?.[0]?.post === tagged.data.uri,
  JSON.stringify(feed.data.feed?.slice(0, 3)),
)
const degenFeed = await token('getFeed', { symbol: 'degen' })
check(
  'a $DEGEN tag facet counts',
  degenFeed.data.feed?.some((f) => f.post === facet.data.uri),
)
const ethUris = feed.data.feed?.map((f) => f.post) ?? []
check(
  'posts without catalog cashtags are left out',
  !ethUris.includes(untagged.data.uri),
)
const unknownFeed = await token('getFeed', { symbol: 'NOTATOKEN' })
check(
  'getFeed of an unknown symbol is NotFound',
  unknownFeed.data.error === 'NotFound',
)
const page = await token('getFeed', { symbol: 'ETH', limit: 1 })
const next = page.data.cursor
  ? await token('getFeed', {
      symbol: 'ETH',
      limit: 1,
      cursor: page.data.cursor,
    })
  : null
check(
  'getFeed pages',
  page.data.feed?.length === 1 &&
    (!next || next.data.feed?.[0]?.post !== page.data.feed[0].post),
)

await deleteRecord(krao, tagged.data.uri)
let gone = false
for (let i = 0; i < 20 && !gone; i++) {
  const res = await token('getFeed', { symbol: 'ETH', limit: 10 })
  gone = !res.data.feed?.some((f) => f.post === tagged.data.uri)
  if (!gone) await sleep(500)
}
check('a deleted post leaves the feed', gone)
await deleteRecord(krao, facet.data.uri)
await deleteRecord(krao, untagged.data.uri)

/*
 * Admin: take a token out and put it back
 */

const removed = await admin(safetyAdmin, 'removeToken', { symbol: 'DEGEN' })
check('removeToken DEGEN', removed.ok && removed.data.removed === true)
check(
  'then it is NotFound',
  (await token('getToken', { symbol: 'DEGEN' })).data.error === 'NotFound',
)
const noPool = await admin(safetyAdmin, 'putToken', {
  symbol: 'DEGEN',
  name: 'Degen',
  address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  pool: '0x0000000000000000000000000000000000000001',
})
check(
  'putToken checks the pool on-chain',
  noPool.data.error === 'NoPool',
  JSON.stringify(noPool.data),
)
const put = await admin(safetyAdmin, 'putToken', {
  symbol: 'DEGEN',
  name: 'Degen',
  address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  quote: 'WETH',
})
check(
  'putToken brings it back, decimals read on-chain',
  put.ok &&
    put.data.token?.symbol === 'DEGEN' &&
    put.data.token?.decimals === 18,
  JSON.stringify(put.data),
)
await admin(safetyAdmin, 'samplePrices')
check(
  'and its price comes with the next round',
  Number((await token('getToken', { symbol: 'DEGEN' })).data.token?.priceUsd) >
    0,
)
const forbidden = await admin(krao, 'putToken', {
  symbol: 'NOPE',
  name: 'Nope',
  address: WETH,
})
check(
  'only token admins change the catalog',
  forbidden.status === 403,
  forbidden.status,
)

done()
