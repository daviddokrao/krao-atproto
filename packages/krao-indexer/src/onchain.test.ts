import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import {
  MAX_NFT_ITEMS,
  OnchainError,
  detectStandard,
  getOnchainProfile,
  getSupportHistory,
  listCollections,
  putCollection,
  readHoldings,
  removeCollection,
  supportSummary,
} from './onchain.js'
import { tipRowFromRecord, upsertTip } from './tips.js'
import { TokenCatalog, USDC } from './token.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const CAROL = 'did:plc:carol'
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const ENUM = addr(0xe1)
const PLAIN = addr(0xe2)
const MULTI = addr(0xe3)
const NOT_NFT = addr(0xe4)
const DAY = 24 * 60 * 60 * 1000

/*
 * A fake chain: three NFT contracts (an enumerable ERC-721, a plain one and
 * an ERC-1155), with tokens by owner
 */
let owned: Map<string, Map<string, bigint[]>>
let calls: number
let down: boolean
const sel = (data: string) => data.slice(0, 10)
const arg = (data: string, i: number) =>
  '0x' + data.slice(10 + 64 * i, 74 + 64 * i)
const out = (value: bigint) => '0x' + value.toString(16).padStart(64, '0')
const fakeRpc = {
  tryCall: async (to: string, data: string) => {
    calls++
    if (down) throw new Error('RPC down')
    const contract = to.toLowerCase()
    if (sel(data) === '0x01ffc9a7') {
      const iface = data.slice(10, 18)
      const yes =
        (contract === ENUM && ['80ac58cd', '780e9d63'].includes(iface)) ||
        (contract === PLAIN && iface === '80ac58cd') ||
        (contract === MULTI && iface === 'd9b67a26')
      return out(yes ? 1n : 0n)
    }
    if (contract === NOT_NFT) return null
    const tokens = owned.get(contract)
    const ownerOf = (i: number) => '0x' + arg(data, i).slice(-40).toLowerCase()
    if (sel(data) === '0x70a08231') {
      return out(BigInt(tokens?.get(ownerOf(0))?.length ?? 0))
    }
    if (sel(data) === '0x2f745c59') {
      const index = Number(BigInt(arg(data, 1)))
      const id = tokens?.get(ownerOf(0))?.[index]
      return id === undefined ? null : out(id)
    }
    return null
  },
  ethCall: async (to: string, data: string) => {
    if (sel(data) === '0x06fdde03' && to.toLowerCase() === PLAIN) {
      // abi.encode("Plain Cats")
      const name = Buffer.from('Plain Cats').toString('hex')
      return '0x' + out(32n).slice(2) + out(10n).slice(2) + name.padEnd(64, '0')
    }
    return null
  },
  getBalance: async () => 0n,
} as unknown as EvmRpc
const rpcs = new Map([[BASE, fakeRpc]])

let db: Database
let seq = 0

async function linkWallet(did: string, address: string, label?: string) {
  const now = new Date(Date.now() + ++seq).toISOString()
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${seq}`,
    did,
    account: `${BASE}:${address}`,
    accountRaw: `${BASE}:${address}`,
    evmAddress: address,
    label: label ?? null,
    status: 'verified',
    reason: null,
    showPrimaryName: 1,
    createdAt: now,
    indexedAt: now,
  })
}

async function tip(
  from: string,
  to: string,
  amount: string,
  opts: { asset?: string; anonymous?: boolean; createdAt?: string } = {},
) {
  const uri = `at://${from}/net.krao.feed.tip/${++seq}`
  const row = tipRowFromRecord(uri, from, {
    recipient: to,
    asset: opts.asset ?? `${BASE}/erc20:${USDC}`,
    amount,
    txHash: `0x${seq.toString(16).padStart(64, '0')}`,
    from: `${BASE}:${addr(1)}`,
    to: `${BASE}:${addr(2)}`,
    anonymous: opts.anonymous,
    createdAt:
      opts.createdAt ?? new Date(Date.now() - 1000 + seq).toISOString(),
  })
  await upsertTip(db, { ...row, status: 'verified' })
  return uri
}

async function payment(member: string, creator: string, amount: string) {
  const uri = `at://${member}/net.krao.membership.payment/${++seq}`
  const at = new Date(Date.now() - 1000 + seq).toISOString()
  await db
    .insertInto('membership_payment')
    .values({
      uri,
      did: member,
      creator,
      plan: `at://${creator}/net.krao.membership.plan/p`,
      chain: BASE,
      txHash: `0x${seq.toString(16).padStart(64, '0')}`,
      status: 'verified',
      reason: null,
      amount,
      blockTime: at,
      periodStart: at,
      periodEnd: new Date(Date.parse(at) + 30 * DAY).toISOString(),
      nextCheckAt: null,
      pendingSince: null,
      publishedAt: at,
      createdAt: at,
      indexedAt: at,
    })
    .execute()
  return uri
}

const hide = (did: string) =>
  db
    .insertInto('hidden_actor')
    .values({ did, status: 'takendown', since: new Date().toISOString() })
    .execute()

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  owned = new Map()
  calls = 0
  down = false
})

afterEach(async () => {
  await db.destroy()
})

describe('approved NFT collections', () => {
  it('detects the standard by ERC-165', async () => {
    expect(await detectStandard(fakeRpc, ENUM)).toBe('erc721-enumerable')
    expect(await detectStandard(fakeRpc, PLAIN)).toBe('erc721')
    expect(await detectStandard(fakeRpc, MULTI)).toBe('erc1155')
    expect(await detectStandard(fakeRpc, NOT_NFT)).toBeNull()
  })

  it('adds, renames and removes collections', async () => {
    const plain = await putCollection(db, rpcs, ALICE, {
      chain: BASE,
      contract: PLAIN.toUpperCase().replace('0X', '0x'),
    })
    // The on-chain name when none is given; lowercase contract
    expect(plain).toMatchObject({
      contract: PLAIN,
      name: 'Plain Cats',
      standard: 'erc721',
      addedBy: ALICE,
    })
    const renamed = await putCollection(db, rpcs, BOB, {
      chain: BASE,
      contract: PLAIN,
      name: 'Mèo',
    })
    expect(renamed).toMatchObject({ name: 'Mèo', addedAt: plain.addedAt })
    await expect(
      putCollection(db, rpcs, ALICE, { chain: BASE, contract: NOT_NFT }),
    ).rejects.toThrow(OnchainError)
    await expect(
      putCollection(db, rpcs, ALICE, { chain: 'eip155:1', contract: PLAIN }),
    ).rejects.toMatchObject({ code: 'UnsupportedChain' })
    await expect(
      putCollection(db, rpcs, ALICE, { chain: BASE, contract: '0x12' }),
    ).rejects.toMatchObject({ code: 'InvalidCollection' })
    expect((await listCollections(db)).map((c) => c.contract)).toEqual([PLAIN])
    expect(await removeCollection(db, BASE, PLAIN)).toBe(true)
    expect(await removeCollection(db, BASE, PLAIN)).toBe(false)
  })

  it('lists enumerable tokens, a balance otherwise, nothing for ERC-1155', async () => {
    owned.set(
      ENUM,
      new Map([
        [addr(1), [7n, 9n]],
        [addr(2), [11n]],
      ]),
    )
    owned.set(PLAIN, new Map([[addr(1), [1n, 2n, 3n]]]))
    const owners = [addr(1), addr(2)]
    expect(
      await readHoldings(
        fakeRpc,
        { chain: BASE, contract: ENUM, standard: 'erc721-enumerable' },
        owners,
        50,
      ),
    ).toEqual([
      { tokenId: 7n, balance: 1n },
      { tokenId: 9n, balance: 1n },
      { tokenId: 11n, balance: 1n },
    ])
    expect(
      await readHoldings(
        fakeRpc,
        { chain: BASE, contract: ENUM, standard: 'erc721-enumerable' },
        owners,
        2,
      ),
    ).toHaveLength(2)
    expect(
      await readHoldings(
        fakeRpc,
        { chain: BASE, contract: PLAIN, standard: 'erc721' },
        owners,
        50,
      ),
    ).toEqual([{ balance: 3n }])
    expect(
      await readHoldings(
        fakeRpc,
        { chain: BASE, contract: MULTI, standard: 'erc1155' },
        owners,
        50,
      ),
    ).toEqual([])
  })
})

describe('getOnchainProfile', () => {
  const opts = (extra: Record<string, unknown> = {}) => ({
    rpcs,
    baseUrl: 'https://idx.krao.test',
    now: Date.now(),
    ...extra,
  })

  it('shows owned wallets, NFTs of approved collections and the avatar', async () => {
    await linkWallet(BOB, addr(2))
    await linkWallet(ALICE, addr(1), 'Ví chính')
    // Bob linked addr(2) first: it is not Alice's
    await linkWallet(ALICE, addr(2))
    await putCollection(db, rpcs, CAROL, { chain: BASE, contract: ENUM })
    await putCollection(db, rpcs, CAROL, { chain: BASE, contract: PLAIN })
    owned.set(
      ENUM,
      new Map([
        [addr(1), [7n]],
        [addr(2), [8n]],
      ]),
    )
    owned.set(PLAIN, new Map([[addr(1), [1n, 2n]]]))
    // The avatar: one of the plain collection's two tokens
    await db
      .insertInto('nft_avatar')
      .values({
        did: ALICE,
        uri: `at://${ALICE}/net.krao.actor.nftAvatar/self`,
        chain: BASE,
        contract: PLAIN,
        tokenId: '2',
        standard: 'erc721',
        wallet: `${BASE}:${addr(1)}`,
        status: 'verified',
        reason: null,
        collectionName: 'Plain Cats',
        image: 'https://example.com/cat.png',
        checkedAt: new Date().toISOString(),
        indexedAt: new Date().toISOString(),
      })
      .execute()
    const profile = await getOnchainProfile(db, ALICE, opts())
    expect(profile?.wallets).toEqual([
      { chain: BASE, address: addr(1), label: 'Ví chính' },
    ])
    const image = (contract: string, tokenId: string) =>
      `https://idx.krao.test/nft-image?chain=${encodeURIComponent(BASE)}&contract=${contract}&tokenId=${tokenId}`
    // The avatar first; collections in the order they were approved
    expect(profile?.nfts[0].isAvatar).toBe(true)
    expect(profile?.nfts).toHaveLength(3)
    expect(profile?.nfts).toEqual(
      expect.arrayContaining([
        {
          chain: BASE,
          contract: PLAIN,
          tokenId: '2',
          balance: '1',
          collectionName: 'Plain Cats',
          image: image(PLAIN, '2'),
          isAvatar: true,
        },
        {
          chain: BASE,
          contract: PLAIN,
          balance: '1',
          collectionName: 'Plain Cats',
          isAvatar: false,
        },
        {
          chain: BASE,
          contract: ENUM,
          tokenId: '7',
          balance: '1',
          image: image(ENUM, '7'),
          isAvatar: false,
        },
      ]),
    )
    // Never the avatar's own image URL
    expect(JSON.stringify(profile)).not.toContain('example.com')
  })

  it('marks an enumerable token that is the avatar, without a second item', async () => {
    await linkWallet(ALICE, addr(1))
    await putCollection(db, rpcs, CAROL, { chain: BASE, contract: ENUM })
    owned.set(ENUM, new Map([[addr(1), [7n, 9n]]]))
    await db
      .insertInto('nft_avatar')
      .values({
        did: ALICE,
        uri: `at://${ALICE}/net.krao.actor.nftAvatar/self`,
        chain: BASE,
        contract: ENUM,
        tokenId: '9',
        standard: 'erc721',
        wallet: `${BASE}:${addr(1)}`,
        status: 'verified',
        reason: null,
        collectionName: null,
        image: null,
        checkedAt: null,
        indexedAt: new Date().toISOString(),
      })
      .execute()
    const profile = await getOnchainProfile(db, ALICE, opts())
    expect(profile?.nfts.map((n) => [n.tokenId, n.isAvatar])).toEqual([
      ['7', false],
      ['9', true],
    ])
  })

  it('caches holdings, and keeps going when the chain fails', async () => {
    await linkWallet(ALICE, addr(1))
    await putCollection(db, rpcs, CAROL, { chain: BASE, contract: PLAIN })
    owned.set(PLAIN, new Map([[addr(1), [1n]]]))
    const cache = new Map()
    const first = await getOnchainProfile(db, ALICE, opts({ cache }))
    expect(first?.nfts).toHaveLength(1)
    const before = calls
    owned.set(PLAIN, new Map())
    const cached = await getOnchainProfile(db, ALICE, opts({ cache }))
    expect(calls).toBe(before)
    expect(cached?.nfts).toHaveLength(1)
    const fresh = await getOnchainProfile(
      db,
      ALICE,
      opts({ cache, cacheMs: 0 }),
    )
    expect(fresh?.nfts).toEqual([])
    down = true
    const failing = await getOnchainProfile(db, ALICE, opts({ cacheMs: 0 }))
    expect(failing?.nfts).toEqual([])
    expect(MAX_NFT_ITEMS).toBe(50)
  })

  it('is not found for hidden accounts', async () => {
    await linkWallet(ALICE, addr(1))
    await hide(ALICE)
    expect(await getOnchainProfile(db, ALICE, opts())).toBeUndefined()
  })

  it('shows a verified primary name only while its wallet is owned and shown', async () => {
    await linkWallet(ALICE, addr(1))
    await db
      .insertInto('primary_name')
      .values({
        did: ALICE,
        name: 'alice.base.eth',
        source: 'basename',
        address: addr(1),
        checkedAt: new Date().toISOString(),
        attemptedAt: new Date().toISOString(),
        stale: 0,
      })
      .execute()
    expect((await getOnchainProfile(db, ALICE, opts()))?.primaryName).toEqual({
      name: 'alice.base.eth',
      source: 'basename',
      address: addr(1),
    })
    await db
      .updateTable('wallet')
      .set({ showPrimaryName: 0 })
      .where('did', '=', ALICE)
      .execute()
    expect(
      (await getOnchainProfile(db, ALICE, opts()))?.primaryName,
    ).toBeUndefined()
  })
})

describe('support', () => {
  it('sums verified public tips and active memberships', async () => {
    await tip(ALICE, BOB, '5000000')
    await tip(ALICE, BOB, '2500000')
    // Anonymous: left out of the public tab
    await tip(ALICE, BOB, '100000000', { anonymous: true })
    await tip(BOB, ALICE, '1000000')
    // To a hidden account: left out
    await tip(ALICE, CAROL, '1000000')
    await hide(CAROL)
    const now = Date.now()
    await db
      .insertInto('creator_member')
      .values([
        {
          creator: BOB,
          member: ALICE,
          since: new Date(now - DAY).toISOString(),
          expiresAt: new Date(now + DAY).toISOString(),
          firstAt: new Date(now - DAY).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
        {
          creator: 'did:plc:gone',
          member: ALICE,
          since: new Date(now - 40 * DAY).toISOString(),
          expiresAt: new Date(now - 10 * DAY).toISOString(),
          firstAt: new Date(now - 40 * DAY).toISOString(),
          updatedAt: new Date(now).toISOString(),
        },
      ])
      .execute()
    expect(await supportSummary(db, ALICE, now)).toEqual({
      tipsSentUsd: '7.50',
      tipsReceivedUsd: '1.00',
      tipsSent: 2,
      tipsReceived: 1,
      membershipsActive: 1,
      membersActive: 0,
    })
    expect((await supportSummary(db, BOB, now)).membersActive).toBe(1)
  })

  it('lists tips and payments both ways, newest first, without anonymous tips', async () => {
    const catalog = new TokenCatalog(db)
    await catalog.init()
    const t1 = await tip(ALICE, BOB, '5000000')
    await tip(ALICE, BOB, '1', { anonymous: true })
    const p1 = await payment(ALICE, BOB, '5000000')
    const t2 = await tip(ALICE, BOB, '1000', {
      asset: `${BASE}/slip44:60`,
    })
    // A token outside the catalog: nothing to show it with
    await tip(ALICE, BOB, '1', { asset: `${BASE}/erc20:${addr(0x99)}` })
    // Dated ahead: not listed (yet)
    await tip(ALICE, BOB, '1', {
      createdAt: new Date(Date.now() + DAY).toISOString(),
    })

    const sent = await getSupportHistory(db, ALICE, {
      direction: 'sent',
      limit: 50,
    })
    expect(sent.items.map((i) => i.uri)).toEqual([t2, p1, t1])
    expect(sent.items[0]).toMatchObject({
      kind: 'tip',
      from: ALICE,
      to: BOB,
      amount: '1000',
      asset: { symbol: 'ETH', decimals: 18, chain: BASE },
    })
    expect(sent.items[0].asset.address).toBeUndefined()
    expect(sent.items[1]).toMatchObject({
      kind: 'membership',
      amount: '5000000',
      usd: '5.00',
      asset: { symbol: 'USDC', decimals: 6, address: USDC.toLowerCase() },
    })
    expect(sent.items[2]).toMatchObject({
      kind: 'tip',
      usd: '5.00',
      asset: { symbol: 'USDC', decimals: 6 },
    })
    const received = await getSupportHistory(db, BOB, {
      direction: 'received',
      limit: 50,
    })
    expect(received.items.map((i) => i.uri)).toEqual([t2, p1, t1])
    expect(
      (await getSupportHistory(db, BOB, { direction: 'sent', limit: 50 }))
        .items,
    ).toEqual([])

    // Pages of 2
    const page1 = await getSupportHistory(db, ALICE, {
      direction: 'sent',
      limit: 2,
    })
    expect(page1.cursor).toBeTruthy()
    const page2 = await getSupportHistory(db, ALICE, {
      direction: 'sent',
      limit: 2,
      cursor: page1.cursor,
    })
    const paged = [...page1.items, ...page2.items].map((i) => i.uri)
    expect(paged.filter((u) => [t1, t2, p1].includes(u))).toEqual([t2, p1, t1])
    await expect(
      getSupportHistory(db, ALICE, {
        direction: 'sent',
        limit: 2,
        cursor: 'nope',
      }),
    ).rejects.toThrow()
  })
})
