import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import { getLatestPosts, upsertFeedGenerator, upsertFeedPost } from './feed.js'
import {
  HolderFeeds,
  communityFeedSlug,
  communityFeedUri,
  holderFeedKey,
  holderFeedUri,
} from './holders.js'
import { TokenCatalog, USDC } from './token.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const CAROL = 'did:plc:carol'

let db: Database
let usdc: Map<string, bigint>
let eth: Map<string, bigint>
let reads: number
let down: boolean
const rpc = {
  getBalance: async (address: string) => {
    reads++
    if (down) throw new Error('RPC down')
    return eth.get(address) ?? 0n
  },
  tryCall: async (to: string, data: string) => {
    reads++
    if (down) throw new Error('RPC down')
    if (to.toLowerCase() !== USDC.toLowerCase()) return null
    const owner = '0x' + data.slice(-40)
    return '0x' + (usdc.get(owner) ?? 0n).toString(16).padStart(64, '0')
  },
} as unknown as EvmRpc

let seq = 0
async function linkWallet(did: string, address: string) {
  const now = new Date(Date.now() + ++seq).toISOString()
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${seq}`,
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

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  await new TokenCatalog(db).init()
  // ETH at 3000 USD
  await db
    .updateTable('token')
    .set({ priceUsd: '3000' })
    .where('key', '=', 'ETH')
    .execute()
  usdc = new Map()
  eth = new Map()
  reads = 0
  down = false
})

afterEach(async () => {
  await db.destroy()
})

describe('holder feeds', () => {
  it('lists accounts holding at least the minimum value', async () => {
    await linkWallet(ALICE, addr(1))
    await linkWallet(ALICE, addr(2))
    await linkWallet(BOB, addr(3))
    await linkWallet(CAROL, addr(4))
    // Alice: 0.6 + 0.6 USDC across two wallets; Bob 0.99; Carol none
    usdc.set(addr(1), 600_000n)
    usdc.set(addr(2), 600_000n)
    usdc.set(addr(3), 990_000n)
    const feeds = new HolderFeeds(db, { rpc, cacheMs: 0 })
    expect(await feeds.holders('USDC')).toEqual([ALICE])
    // ETH is the native balance: 0.001 ETH is 3 USD
    eth.set(addr(4), 10n ** 15n)
    expect(await feeds.holders('ETH')).toEqual([CAROL])
    const strict = new HolderFeeds(db, { rpc, cacheMs: 0, minUsd: 5 })
    expect(await strict.holders('ETH')).toEqual([])
  })

  it('counts a wallet for the account that linked it first', async () => {
    await linkWallet(BOB, addr(1))
    await linkWallet(ALICE, addr(1))
    usdc.set(addr(1), 5_000_000n)
    const feeds = new HolderFeeds(db, { rpc, cacheMs: 0 })
    expect(await feeds.holders('USDC')).toEqual([BOB])
  })

  it('leaves out hidden accounts, unknown tokens and tokens without a price', async () => {
    await linkWallet(ALICE, addr(1))
    usdc.set(addr(1), 5_000_000n)
    eth.set(addr(1), 10n ** 18n)
    const feeds = new HolderFeeds(db, { rpc, cacheMs: 0 })
    expect(await feeds.holders('NOPE')).toEqual([])
    await db
      .updateTable('token')
      .set({ priceUsd: null })
      .where('key', '=', 'ETH')
      .execute()
    expect(await feeds.holders('ETH')).toEqual([])
    await db
      .insertInto('hidden_actor')
      .values({ did: ALICE, status: 'takendown', since: 'x' })
      .execute()
    expect(await feeds.holders('USDC')).toEqual([])
    expect(await new HolderFeeds(db, {}).holders('USDC')).toEqual([])
  })

  it('reuses balances, and the last one when the chain fails', async () => {
    await linkWallet(ALICE, addr(1))
    usdc.set(addr(1), 5_000_000n)
    const feeds = new HolderFeeds(db, { rpc })
    expect(await feeds.holders('USDC')).toEqual([ALICE])
    const before = reads
    usdc.set(addr(1), 0n)
    expect(await feeds.holders('USDC')).toEqual([ALICE])
    expect(reads).toBe(before)
    // Expired: read again, but the chain is down, so the last balance holds
    down = true
    expect(await feeds.holders('USDC', Date.now() + 16 * 60_000)).toEqual([
      ALICE,
    ])
  })

  it('serves the newest top-level posts of the holders, without unsafe ones', async () => {
    const post = async (did: string, n: number) => {
      const uri = `at://${did}/app.bsky.feed.post/${n}`
      await upsertFeedPost(db, {
        uri,
        cid: `bafy${n}`,
        did,
        indexedAt: new Date(Date.now() + n).toISOString(),
        createdAt: null,
        vi: 0,
      })
      return uri
    }
    const a1 = await post(ALICE, 1)
    await post(BOB, 2)
    const a3 = await post(ALICE, 3)
    await db
      .insertInto('unsafe_post')
      .values({ uri: a3, did: ALICE, domain: 'drainer.test', flaggedAt: 'x' })
      .execute()
    expect(
      (await getLatestPosts(db, 10, undefined, { dids: [ALICE] })).posts,
    ).toEqual([a1])
    expect(
      (await getLatestPosts(db, 10, undefined, { dids: [] })).posts,
    ).toEqual([])
  })

  it('reads the feed rkeys', () => {
    expect(holderFeedKey('holders-usdc')).toBe('USDC')
    expect(holderFeedKey('holders-cbbtc')).toBe('CBBTC')
    expect(holderFeedKey('holders-')).toBeNull()
    expect(holderFeedKey('holders-$eth')).toBeNull()
    expect(holderFeedKey('latest')).toBeNull()
    expect(communityFeedSlug('community-krao-vn')).toBe('krao-vn')
    expect(communityFeedSlug('community-x')).toBeNull()
    expect(communityFeedSlug('holders-usdc')).toBeNull()
  })

  it('finds the published generators', async () => {
    const official = `at://${ALICE}/app.bsky.feed.generator/holders-usdc`
    await upsertFeedGenerator(db, { uri: official, did: ALICE })
    await upsertFeedGenerator(db, {
      uri: `at://${BOB}/app.bsky.feed.generator/holders-usdc`,
      did: BOB,
    })
    // The first one indexed, not a later copy
    expect(await holderFeedUri(db, 'USDC')).toBe(official)
    expect(await holderFeedUri(db, 'ETH')).toBeUndefined()
    const community = `at://${BOB}/app.bsky.feed.generator/community-krao`
    await upsertFeedGenerator(db, { uri: community, did: BOB })
    expect(await communityFeedUri(db, { did: BOB, slug: 'krao' })).toBe(
      community,
    )
    expect(
      await communityFeedUri(db, { did: ALICE, slug: 'krao' }),
    ).toBeUndefined()
  })
})
