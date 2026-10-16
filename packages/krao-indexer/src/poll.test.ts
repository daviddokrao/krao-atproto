import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import {
  type PollChecks,
  deletePollDataForDid,
  deleteVote,
  getPoll,
  getPollsForPosts,
  indexPoll,
  indexVote,
  pollRowFromRecord,
  pollViews,
} from './poll.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const USDC = `${BASE}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
const AUTHOR = 'did:plc:author'
const ANA = 'did:plc:ana'
const BAO = 'did:plc:bao'
const CUONG = 'did:plc:cuong'
const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

let db: Database
let balances: Map<string, bigint>
let balanceBlocks: bigint[]
let humans: Set<string>
let humanDown: boolean
const rpc = {
  blockNumber: async () => 1234n,
  balanceAt: async (_asset: unknown, address: string, block: bigint) => {
    balanceBlocks.push(block)
    return balances.get(address) ?? 0n
  },
} as unknown as EvmRpc
const rpcs = new Map([[BASE, rpc]])
const checks = (): PollChecks => ({
  rpcs,
  human: {
    isHuman: async (did) => {
      if (humanDown) throw new Error('rewards down')
      return humans.has(did)
    },
  },
})

let n = 0
const rkey = () => `3k${String(++n).padStart(11, 'a')}`

async function poll(record: Record<string, unknown> = {}, start = Date.now()) {
  const key = rkey()
  const uri = `at://${AUTHOR}/net.krao.poll.poll/${key}`
  const row = pollRowFromRecord(
    uri,
    AUTHOR,
    {
      post: { uri: `at://${AUTHOR}/app.bsky.feed.post/${key}`, cid: 'c' },
      options: ['Có', 'Không', 'Chưa biết'],
      endsAt: iso(start + 24 * HOUR),
      mode: 'account',
      createdAt: iso(start),
      ...record,
    },
    iso(start),
    rpcs,
  )
  if (!row) throw new Error('invalid poll')
  await indexPoll(db, rpcs, row)
  return uri
}

async function vote(
  did: string,
  pollUri: string,
  option: number,
  at = Date.now(),
) {
  const uri = `at://${did}/net.krao.poll.vote/${rkey()}`
  await indexVote(
    db,
    checks(),
    uri,
    did,
    { poll: { uri: pollUri, cid: 'c' }, option, createdAt: iso(at) },
    iso(at),
  )
  return uri
}

async function view(uri: string, viewer?: string, now?: number) {
  const row = await getPoll(db, uri)
  const [v] = await pollViews(db, [row!], viewer, now)
  return v
}

async function linkWallet(did: string, address: string, at = '1') {
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${rkey()}`,
    did,
    account: `${BASE}:${address}`,
    accountRaw: `${BASE}:${address}`,
    evmAddress: address,
    label: null,
    status: 'verified',
    reason: null,
    createdAt: at,
    indexedAt: at,
  })
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  balances = new Map()
  balanceBlocks = []
  humans = new Set()
  humanDown = false
})

afterEach(async () => {
  await db.destroy()
})

describe('poll records', () => {
  const valid = {
    post: { uri: `at://${AUTHOR}/app.bsky.feed.post/1`, cid: 'c' },
    options: ['a', 'b'],
    endsAt: iso(Date.now() + HOUR),
    mode: 'account',
    createdAt: iso(Date.now()),
  }
  const row = (record: Record<string, unknown>, did = AUTHOR) =>
    pollRowFromRecord(
      `at://${did}/net.krao.poll.poll/1`,
      did,
      { ...valid, ...record },
      iso(Date.now()),
      rpcs,
    )

  it('takes 2 to 4 short options and at most 30 days', () => {
    expect(row({})).toBeTruthy()
    expect(row({ options: ['a'] })).toBeNull()
    expect(row({ options: ['a', 'b', 'c', 'd', 'e'] })).toBeNull()
    expect(row({ options: ['a', ' '] })).toBeNull()
    expect(row({ options: ['a', 'x'.repeat(81)] })).toBeNull()
    expect(row({ endsAt: iso(Date.now() - 1000) })).toBeNull()
    expect(row({ endsAt: iso(Date.now() + 31 * 24 * HOUR) })).toBeNull()
    expect(row({ mode: 'weighted' })).toBeNull()
    // Only the author's own post
    expect(row({}, ANA)).toBeNull()
  })

  it('needs an asset on an indexed chain for token polls', () => {
    expect(row({ mode: 'token' })).toBeNull()
    expect(row({ mode: 'token', asset: 'eip155:1/slip44:60' })).toBeNull()
    expect(row({ mode: 'token', asset: USDC })?.asset).toBe(USDC)
  })

  it('cannot be backdated to stretch past 30 days', () => {
    // createdAt in the past: the poll opens then, so it ends within 30 days
    expect(
      row({
        createdAt: iso(Date.now() - 10 * 24 * HOUR),
        endsAt: iso(Date.now() + 25 * 24 * HOUR),
      }),
    ).toBeNull()
  })
})

describe('account polls', () => {
  it('counts one vote per account and tallies results', async () => {
    const uri = await poll()
    const first = await vote(ANA, uri, 0)
    await vote(ANA, uri, 1)
    await vote(BAO, uri, 1)
    await vote(CUONG, uri, 7)
    const v = await view(uri, ANA)
    expect(v.options.map((o) => o.votes)).toEqual([1, 1, 0])
    expect(v.totalVotes).toBe(2)
    expect(v.viewer).toMatchObject({ uri: first, option: 0, status: 'counted' })
    expect((await view(uri, CUONG)).viewer).toMatchObject({
      status: 'ignored',
      reason: 'InvalidOption',
    })
    const again = await db
      .selectFrom('poll_vote')
      .select('reason')
      .where('did', '=', ANA)
      .where('status', '=', 'ignored')
      .executeTakeFirst()
    expect(again?.reason).toBe('AlreadyVoted')
  })

  it('ignores votes after the end and keeps the place of deleted votes', async () => {
    const start = Date.now() - 2 * HOUR
    const uri = await poll({ endsAt: iso(start + HOUR) }, start)
    await vote(ANA, uri, 0, start + 10 * 60_000)
    await vote(BAO, uri, 0, start + 2 * HOUR)
    expect((await view(uri, BAO)).viewer?.reason).toBe('AfterEnd')
    const v = await view(uri)
    expect(v.ended).toBe(true)
    expect(v.totalVotes).toBe(1)

    const open = await poll()
    const counted = await vote(ANA, open, 0)
    await deleteVote(db, counted)
    expect((await view(open)).totalVotes).toBe(0)
    // Deleting a vote does not free a new one
    await vote(ANA, open, 1)
    expect((await view(open)).totalVotes).toBe(0)
    expect((await view(open, ANA)).viewer).toMatchObject({
      status: 'ignored',
      reason: 'Deleted',
    })
  })

  it('hides counts of afterEnd polls until they end', async () => {
    const uri = await poll({ resultsVisibility: 'afterEnd' })
    await vote(ANA, uri, 2)
    const open = await view(uri, ANA)
    expect(open.resultsVisible).toBe(false)
    expect(open.totalVotes).toBeUndefined()
    expect(open.options.every((o) => o.votes === undefined)).toBe(true)
    // The voter still sees their own vote
    expect(open.viewer?.option).toBe(2)
    const ended = await view(uri, undefined, Date.now() + 25 * HOUR)
    expect(ended.resultsVisible).toBe(true)
    expect(ended.options[2].votes).toBe(1)
  })

  it('leaves out votes of hidden accounts', async () => {
    const uri = await poll()
    await vote(ANA, uri, 0)
    await vote(BAO, uri, 0)
    await db
      .insertInto('hidden_actor')
      .values({ did: BAO, status: 'takendown', since: iso(Date.now()) })
      .execute()
    expect((await view(uri)).totalVotes).toBe(1)
  })
})

describe('verified polls', () => {
  it('counts only accounts Krao verified', async () => {
    const uri = await poll({ mode: 'verified' })
    humans.add(ANA)
    await vote(ANA, uri, 0)
    await vote(BAO, uri, 1)
    expect((await view(uri)).options.map((o) => o.votes)).toEqual([1, 0, 0])
    expect((await view(uri, BAO)).viewer?.reason).toBe('NotVerified')
    // The rewards service down: the event fails and is retried later
    humanDown = true
    await expect(vote(CUONG, uri, 0)).rejects.toThrow()
    humanDown = false
    humans.add(CUONG)
    await vote(CUONG, uri, 0)
    expect((await view(uri)).totalVotes).toBe(2)
  })
})

describe('token polls', () => {
  it('weighs votes by the snapshot balance, each wallet once', async () => {
    const uri = await poll({ mode: 'token', asset: USDC })
    expect((await getPoll(db, uri))?.snapshotBlock).toBe('1234')
    const a1 = '0x' + '1'.repeat(40)
    const a2 = '0x' + '2'.repeat(40)
    const b1 = '0x' + '3'.repeat(40)
    balances.set(a1, 30_000_000n)
    balances.set(a2, 20_000_000n)
    balances.set(b1, 5_000_000n)
    await linkWallet(ANA, a1)
    await linkWallet(ANA, a2)
    await linkWallet(BAO, b1)
    await vote(ANA, uri, 0)
    await vote(BAO, uri, 1)
    expect(balanceBlocks.every((b) => b === 1234n)).toBe(true)
    const v = await view(uri, ANA)
    expect(v.options.map((o) => o.weight)).toEqual(['50000000', '5000000', '0'])
    expect(v.totalWeight).toBe('55000000')
    expect(v.viewer?.weight).toBe('50000000')

    // Ana's wallet moves to Cuong's account (Ana unlinks it): it already
    // weighed a vote, so it adds nothing to Cuong's
    await db.deleteFrom('wallet').where('evmAddress', '=', a2).execute()
    await linkWallet(CUONG, a2)
    await vote(CUONG, uri, 2)
    expect((await view(uri, CUONG)).viewer).toMatchObject({
      status: 'counted',
      weight: '0',
    })
    expect((await view(uri)).totalWeight).toBe('55000000')
  })
})

describe('polls of posts and deletion', () => {
  it('finds polls by post and forgets a deleted account', async () => {
    const uri = await poll()
    const post = (await getPoll(db, uri))!.post
    expect(
      (await getPollsForPosts(db, [post, 'at://x/app.bsky.feed.post/1'])).map(
        (p) => p.uri,
      ),
    ).toEqual([uri])
    await vote(ANA, uri, 0)
    await deletePollDataForDid(db, ANA)
    expect((await view(uri)).totalVotes).toBe(0)
    await deletePollDataForDid(db, AUTHOR)
    expect(await getPoll(db, uri)).toBeUndefined()
  })
})
