import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import {
  APPROVAL_COLLECTION,
  BAN_COLLECTION,
  type CommunityChecks,
  HIDE_COLLECTION,
  MODERATOR_COLLECTION,
  actionRowFromRecord,
  communityRowFromRecord,
  deleteCommunityDataForDid,
  getCommunity,
  getCommunityFeed,
  getMembers,
  getPendingMembers,
  getViewerState,
  isCommunityMember,
  listAccountCommunities,
  listCommunities,
  membershipRowFromRecord,
  recheckMemberships,
  submissionRowFromRecord,
  upsertAction,
  upsertCommunity,
  upsertMembership,
  upsertSubmission,
} from './community.js'
import { type Database, createDb, migrateDb } from './db.js'
import { isEligible } from './gate.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const OWNER = 'did:plc:owner'
const MOD = 'did:plc:mod'
const ANA = 'did:plc:ana'
const BAO = 'did:plc:bao'
const now = () => new Date().toISOString()

let db: Database
let balances: Map<string, bigint>
let failRpc: boolean
let humans: Set<string>
const rpc = {
  getBalance: async (address: string) => {
    if (failRpc) throw new Error('RPC down')
    return balances.get(address.toLowerCase()) ?? 0n
  },
  blockNumber: async () => {
    if (failRpc) throw new Error('RPC down')
    return 100n
  },
} as unknown as EvmRpc
const checks = (): CommunityChecks => ({
  rpcs: new Map([[BASE, rpc]]),
  human: { isHuman: async (did) => humans.has(did) },
})

let n = 0
const rkey = () => `3k${String(++n).padStart(11, 'a')}`

async function community(slug: string, access: Record<string, unknown>) {
  const uri = `at://${OWNER}/net.krao.community.profile/${slug}`
  const row = communityRowFromRecord(uri, OWNER, 'bafycid', {
    name: `Community ${slug}`,
    access,
    rules: ['Be kind'],
    createdAt: now(),
  })
  if (!row) throw new Error('invalid community')
  await upsertCommunity(db, row)
  return uri
}

async function join(did: string, uri: string) {
  const row = membershipRowFromRecord(
    `at://${did}/net.krao.community.membership/${rkey()}`,
    did,
    { subject: uri, createdAt: now() },
  )
  await upsertMembership(db, row!)
}

async function act(
  collection: Parameters<typeof actionRowFromRecord>[0],
  by: string,
  record: Record<string, unknown>,
) {
  const uri = `at://${by}/${collection}/${rkey()}`
  const row = actionRowFromRecord(collection, uri, by, {
    ...record,
    createdAt: now(),
  })
  if (row) await upsertAction(db, collection, row)
  return row
}

async function submit(did: string, community: string) {
  const post = `at://${did}/app.bsky.feed.post/${rkey()}`
  const row = submissionRowFromRecord(
    `at://${did}/net.krao.community.submission/${rkey()}`,
    did,
    { community, post: { uri: post, cid: 'bafypost' }, createdAt: now() },
  )
  await upsertSubmission(db, row!)
  return post
}

const feedPosts = async (uri: string) =>
  (await getCommunityFeed(db, uri, 50)).feed.map((f) => f.post)

async function state(uri: string, did: string, live = false) {
  const row = await db
    .selectFrom('community')
    .selectAll()
    .where('uri', '=', uri)
    .executeTakeFirstOrThrow()
  return getViewerState(db, checks(), row, did, live)
}

async function linkWallet(did: string, address: string) {
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${rkey()}`,
    did,
    account: `${BASE}:${address}`,
    accountRaw: `${BASE}:${address}`,
    evmAddress: address.toLowerCase(),
    label: null,
    status: 'verified',
    reason: null,
    createdAt: now(),
    indexedAt: now(),
  })
}

const ETH_CONDITION = {
  $type: 'net.krao.gate.defs#tokenBalance',
  asset: `${BASE}/slip44:60`,
  minAmount: '1000',
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  balances = new Map()
  failRpc = false
  humans = new Set()
})

afterEach(async () => {
  await db.destroy()
})

describe('community records', () => {
  it('validates profiles', () => {
    const at = (slug: string) =>
      `at://${OWNER}/net.krao.community.profile/${slug}`
    const record = { name: 'Krao', access: { mode: 'open' }, createdAt: now() }
    expect(
      communityRowFromRecord(at('krao-vn'), OWNER, 'c', record),
    ).toBeTruthy()
    // Slug rules, owner, access mode, name
    expect(communityRowFromRecord(at('Krao'), OWNER, 'c', record)).toBeNull()
    expect(communityRowFromRecord(at('k'), OWNER, 'c', record)).toBeNull()
    expect(communityRowFromRecord(at('krao-'), OWNER, 'c', record)).toBeNull()
    expect(communityRowFromRecord(at('krao'), ANA, 'c', record)).toBeNull()
    expect(
      communityRowFromRecord(at('krao'), OWNER, 'c', {
        ...record,
        access: { mode: 'paid' },
      }),
    ).toBeNull()
    expect(
      communityRowFromRecord(at('krao'), OWNER, 'c', { ...record, name: ' ' }),
    ).toBeNull()
    // A condition community needs conditions
    expect(
      communityRowFromRecord(at('krao'), OWNER, 'c', {
        ...record,
        access: { mode: 'condition', conditions: [] },
      }),
    ).toBeNull()
    const row = communityRowFromRecord(at('krao'), OWNER, 'c', {
      ...record,
      access: { mode: 'condition', conditions: [ETH_CONDITION], match: 'x' },
      chatJoinLink: 'javascript:alert(1)',
    })
    expect(JSON.parse(row!.access)).toEqual({
      mode: 'condition',
      conditions: [ETH_CONDITION],
      match: 'all',
    })
    expect(row!.chatJoinLink).toBeNull()
  })

  it('only takes moderators from the owner and submissions of own posts', async () => {
    const uri = await community('mods', { mode: 'open' })
    expect(
      await act(MODERATOR_COLLECTION, ANA, { community: uri, subject: BAO }),
    ).toBeNull()
    expect(
      submissionRowFromRecord(
        `at://${ANA}/net.krao.community.submission/1`,
        ANA,
        {
          community: uri,
          post: { uri: `at://${BAO}/app.bsky.feed.post/1`, cid: 'c' },
          createdAt: now(),
        },
      ),
    ).toBeNull()
  })
})

describe('open communities', () => {
  it('counts members and builds the feed without hidden posts or banned accounts', async () => {
    const uri = await community('open', { mode: 'open' })
    await act(MODERATOR_COLLECTION, OWNER, { community: uri, subject: MOD })
    await join(ANA, uri)
    await join(BAO, uri)
    expect((await getCommunity(db, uri))?.memberCount).toBe(4)
    expect((await state(uri, ANA)).state).toBe('member')
    expect((await state(uri, OWNER)).role).toBe('owner')
    expect((await state(uri, MOD)).role).toBe('moderator')

    const anaPost = await submit(ANA, uri)
    const baoPost = await submit(BAO, uri)
    const outsider = await submit('did:plc:outsider', uri)
    const posts = await feedPosts(uri)
    expect(posts).toContain(anaPost)
    expect(posts).toContain(baoPost)
    expect(posts).not.toContain(outsider)

    // A hide by a member does nothing; by a moderator it does
    await act(HIDE_COLLECTION, BAO, { community: uri, post: anaPost })
    expect(await feedPosts(uri)).toContain(anaPost)
    await act(HIDE_COLLECTION, MOD, { community: uri, post: anaPost })
    expect(await feedPosts(uri)).not.toContain(anaPost)

    // A ban by a moderator takes the member and their posts out
    await act(BAN_COLLECTION, MOD, { community: uri, subject: BAO })
    expect(await feedPosts(uri)).not.toContain(baoPost)
    expect((await state(uri, BAO)).state).toBe('banned')
    expect(await isCommunityMember(db, checks(), uri, BAO)).toBe(false)
    expect((await getCommunity(db, uri))?.memberCount).toBe(3)
    const members = (await getMembers(db, (await getCommunity(db, uri))!, 50))
      .members
    expect(members.map((m) => [m.did, m.role])).toEqual([
      [OWNER, 'owner'],
      [MOD, 'moderator'],
      [ANA, 'member'],
    ])
  })

  it('lets only the owner ban a moderator, and nobody ban the owner', async () => {
    const uri = await community('bans', { mode: 'open' })
    await act(MODERATOR_COLLECTION, OWNER, { community: uri, subject: MOD })
    await act(MODERATOR_COLLECTION, OWNER, { community: uri, subject: ANA })
    await act(BAN_COLLECTION, ANA, { community: uri, subject: MOD })
    await act(BAN_COLLECTION, MOD, { community: uri, subject: OWNER })
    expect((await state(uri, MOD)).state).toBe('member')
    expect((await state(uri, OWNER)).state).toBe('member')
    await act(BAN_COLLECTION, OWNER, { community: uri, subject: MOD })
    expect((await state(uri, MOD)).state).toBe('banned')
    expect((await getCommunity(db, uri))?.memberCount).toBe(2)
  })

  it('stops counting a moderator removed by the owner', async () => {
    const uri = await community('former', { mode: 'open' })
    const appointed = await act(MODERATOR_COLLECTION, OWNER, {
      community: uri,
      subject: MOD,
    })
    await join(ANA, uri)
    const post = await submit(ANA, uri)
    await act(HIDE_COLLECTION, MOD, { community: uri, post })
    expect(await feedPosts(uri)).not.toContain(post)
    await db
      .deleteFrom('community_moderator')
      .where('uri', '=', appointed!.uri)
      .execute()
    expect(await feedPosts(uri)).toContain(post)
  })

  it('hides communities of hidden owners and drops hidden members', async () => {
    const uri = await community('hidden', { mode: 'open' })
    await join(ANA, uri)
    const post = await submit(ANA, uri)
    await db
      .insertInto('hidden_actor')
      .values({ did: ANA, status: 'takendown', since: now() })
      .execute()
    expect(await feedPosts(uri)).not.toContain(post)
    expect((await getCommunity(db, uri))?.memberCount).toBe(1)
    await db
      .insertInto('hidden_actor')
      .values({ did: OWNER, status: 'takendown', since: now() })
      .execute()
    expect(await getCommunity(db, uri)).toBeUndefined()
    expect((await listCommunities(db, { limit: 10 })).communities).toEqual([])
  })
})

describe('approval communities', () => {
  it('needs an approval by the owner or a moderator', async () => {
    const uri = await community('approve', { mode: 'approval' })
    await act(MODERATOR_COLLECTION, OWNER, { community: uri, subject: MOD })
    await join(ANA, uri)
    const post = await submit(ANA, uri)
    expect((await state(uri, ANA)).state).toBe('pending')
    expect(await feedPosts(uri)).not.toContain(post)
    const row = (await getCommunity(db, uri))!
    expect(
      (await getPendingMembers(db, row, 10)).members.map((m) => m.did),
    ).toEqual([ANA])

    await act(APPROVAL_COLLECTION, BAO, { community: uri, subject: ANA })
    expect((await state(uri, ANA)).state).toBe('pending')
    await act(APPROVAL_COLLECTION, MOD, { community: uri, subject: ANA })
    expect((await state(uri, ANA)).state).toBe('member')
    expect(await feedPosts(uri)).toContain(post)
    expect((await getPendingMembers(db, row, 10)).members).toEqual([])
  })

  it('does not admit an account approved without a membership', async () => {
    const uri = await community('noapply', { mode: 'approval' })
    await act(APPROVAL_COLLECTION, OWNER, { community: uri, subject: ANA })
    expect((await state(uri, ANA)).state).toBe('none')
    expect(await isCommunityMember(db, checks(), uri, ANA)).toBe(false)
  })
})

describe('condition communities', () => {
  it('admits members whose wallets meet the conditions', async () => {
    const uri = await community('holders', {
      mode: 'condition',
      conditions: [ETH_CONDITION],
    })
    const rich = '0x' + 'a'.repeat(40)
    const poor = '0x' + 'b'.repeat(40)
    balances.set(rich, 5000n)
    balances.set(poor, 10n)
    await linkWallet(ANA, rich)
    await linkWallet(BAO, poor)
    await join(ANA, uri)
    await join(BAO, uri)
    const anaPost = await submit(ANA, uri)
    const baoPost = await submit(BAO, uri)
    // Not checked yet: nobody's posts show
    expect((await state(uri, ANA)).state).toBe('pending')
    expect(await feedPosts(uri)).toEqual([])

    expect(
      await recheckMemberships(db, checks(), new Date(0).toISOString()),
    ).toBe(2)
    expect((await state(uri, ANA)).state).toBe('member')
    const bao = await state(uri, BAO)
    expect(bao).toMatchObject({ state: 'ineligible', eligible: false })
    expect(await feedPosts(uri)).toEqual([anaPost])
    expect(await feedPosts(uri)).not.toContain(baoPost)
    expect((await getCommunity(db, uri))?.memberCount).toBe(2)

    // An outage keeps the last good answer
    balances.set(rich, 0n)
    failRpc = true
    await recheckMemberships(
      db,
      checks(),
      new Date(Date.now() + 1).toISOString(),
    )
    expect(await feedPosts(uri)).toEqual([anaPost])
    // Once the chain answers again, the member who sold drops out, also
    // for live checks (gates)
    failRpc = false
    await recheckMemberships(
      db,
      checks(),
      new Date(Date.now() + 1).toISOString(),
    )
    expect(await feedPosts(uri)).toEqual([])
    expect(await isCommunityMember(db, checks(), uri, ANA)).toBe(false)

    // A live check of someone who qualifies again updates the membership
    balances.set(poor, 2000n)
    expect(await isCommunityMember(db, checks(), uri, BAO)).toBe(true)
    expect(await feedPosts(uri)).toEqual([baoPost])
  })

  it('tells an outsider whether they qualify without joining', async () => {
    const uri = await community('peek', {
      mode: 'condition',
      conditions: [ETH_CONDITION],
    })
    expect(await state(uri, ANA, true)).toMatchObject({
      state: 'none',
      eligible: false,
      reason: 'NoWallet',
    })
  })
})

describe('verified communities', () => {
  it('admits accounts Krao verified', async () => {
    const uri = await community('people', { mode: 'verified' })
    humans.add(ANA)
    await join(ANA, uri)
    await join(BAO, uri)
    await recheckMemberships(db, checks(), new Date(0).toISOString())
    expect((await state(uri, ANA)).state).toBe('member')
    expect(await state(uri, BAO)).toMatchObject({
      state: 'ineligible',
      reason: 'NotVerified',
    })
    // Without the rewards service nobody is verified
    const row = (await getCommunity(db, uri))!
    expect(
      await getViewerState(db, { rpcs: new Map() }, row, 'did:plc:x', true),
    ).toMatchObject({ eligible: false, reason: 'VerificationUnavailable' })
  })
})

describe('gates for community members', () => {
  it('opens member-only posts to members in good standing only', async () => {
    const uri = await community('gated', { mode: 'approval' })
    await join(ANA, uri)
    await join(BAO, uri)
    await act(APPROVAL_COLLECTION, OWNER, { community: uri, subject: ANA })
    await act(APPROVAL_COLLECTION, OWNER, { community: uri, subject: BAO })
    await act(BAN_COLLECTION, OWNER, { community: uri, subject: BAO })
    const rule = {
      uri: `at://${OWNER}/net.krao.gate.rule/1`,
      did: OWNER,
      subject: `at://${OWNER}/app.bsky.feed.post/1`,
      conditions: JSON.stringify([
        { $type: 'net.krao.gate.defs#communityMember', community: uri },
      ]),
      match: 'all' as const,
      service: 'did:web:gate.test',
      createdAt: now(),
      indexedAt: now(),
    }
    const ctx = {
      isCommunityMember: (c: string, did: string) =>
        isCommunityMember(db, checks(), c, did),
    }
    const rpcs = checks().rpcs
    expect(await isEligible(db, rpcs, rule, ANA, ctx)).toBe(true)
    expect(await isEligible(db, rpcs, rule, BAO, ctx)).toBe(false)
    expect(await isEligible(db, rpcs, rule, 'did:plc:other', ctx)).toBe(false)
    // Without a way to ask, community conditions are never met
    expect(await isEligible(db, rpcs, rule, ANA)).toBe(false)
    // A ban closes the gate right away (no cache)
    await act(BAN_COLLECTION, OWNER, { community: uri, subject: ANA })
    expect(await isEligible(db, rpcs, rule, ANA, ctx)).toBe(false)
  })
})

describe('lists and deletion', () => {
  it('lists an account’s communities and forgets a deleted account', async () => {
    const a = await community('alpha', { mode: 'open' })
    const b = await community('beta', { mode: 'open' })
    await join(ANA, a)
    await act(MODERATOR_COLLECTION, OWNER, { community: b, subject: ANA })
    expect((await listAccountCommunities(db, ANA, 10)).uris.sort()).toEqual(
      [a, b].sort(),
    )
    const found = await listCommunities(db, { query: 'ALPHA', limit: 10 })
    expect(found.communities.map((c) => c.uri)).toEqual([a])
    await expect(
      listCommunities(db, { limit: 10, cursor: 'x' }),
    ).rejects.toThrow()

    await submit(ANA, a)
    await deleteCommunityDataForDid(db, ANA)
    // Gone from what Ana wrote; still a moderator in the owner's records
    expect((await listAccountCommunities(db, ANA, 10)).uris).toEqual([b])
    await deleteCommunityDataForDid(db, OWNER)
    expect(await getCommunity(db, a)).toBeUndefined()
    expect(
      await db.selectFrom('community_moderator').selectAll().execute(),
    ).toEqual([])
  })
})
