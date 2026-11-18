import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import { type Database, type GateRuleTable, createDb, migrateDb } from './db.js'
import {
  deleteContentWithoutRule,
  deleteGateRule,
  getGatedContent,
  isEligible,
  putGatedContent,
  upsertGateRule,
} from './gate.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const AUTHOR = 'did:plc:author'
const POST = `at://${AUTHOR}/app.bsky.feed.post/1`
const now = () => new Date().toISOString()

let db: Database
let balances: Map<string, bigint>
let balanceCalls = 0
let failRpc = false
const rpc = {
  getBalance: async (address: string) => {
    balanceCalls++
    if (failRpc) throw new Error('RPC down')
    return balances.get(address.toLowerCase()) ?? 0n
  },
} as unknown as EvmRpc
const rpcs = new Map([[BASE, rpc]])

let n = 0
async function linkWallet(did: string, address: string) {
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${++n}`,
    did,
    account: `${BASE}:${address}`,
    accountRaw: `${BASE}:${address}`,
    label: null,
    status: 'verified',
    reason: null,
    createdAt: now(),
    indexedAt: now(),
  })
}

function rule(
  minWei: string,
  uri = `at://${AUTHOR}/net.krao.gate.rule/${++n}`,
) {
  return {
    uri,
    did: AUTHOR,
    subject: POST,
    conditions: JSON.stringify([
      {
        $type: 'net.krao.gate.defs#tokenBalance',
        asset: `${BASE}/slip44:60`,
        minAmount: minWei,
      },
    ]),
    match: 'all',
    service: 'did:web:gate.test',
    createdAt: now(),
    indexedAt: now(),
  } satisfies GateRuleTable
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  balances = new Map()
  balanceCalls = 0
  failRpc = false
})

afterEach(async () => {
  await db.destroy()
})

describe('isEligible', () => {
  it('lets the author in without asking the chain', async () => {
    expect(await isEligible(db, rpcs, rule('1'), AUTHOR)).toBe(true)
    expect(balanceCalls).toBe(0)
  })

  it('refuses a viewer without a linked wallet', async () => {
    expect(await isEligible(db, rpcs, rule('1'), 'did:plc:nobody')).toBe(false)
  })

  it('sums balances across the viewer wallets', async () => {
    const viewer = 'did:plc:sum'
    await linkWallet(viewer, '0x' + '1'.repeat(40))
    await linkWallet(viewer, '0x' + '2'.repeat(40))
    balances.set('0x' + '1'.repeat(40), 6n)
    balances.set('0x' + '2'.repeat(40), 5n)
    expect(await isEligible(db, rpcs, rule('10'), viewer)).toBe(true)
  })

  it('caches a yes but never a no', async () => {
    const viewer = 'did:plc:cache'
    const wallet = '0x' + '3'.repeat(40)
    await linkWallet(viewer, wallet)
    const gate = rule('10')

    // No: checked again every time, so a top-up counts right away
    expect(await isEligible(db, rpcs, gate, viewer)).toBe(false)
    balances.set(wallet, 10n)
    expect(await isEligible(db, rpcs, gate, viewer)).toBe(true)
    expect(balanceCalls).toBe(2)

    // Yes: reused without asking the chain again
    expect(await isEligible(db, rpcs, gate, viewer)).toBe(true)
    expect(balanceCalls).toBe(2)

    // A changed rule is a different question
    expect(
      await isEligible(
        db,
        rpcs,
        { ...gate, conditions: rule('20').conditions },
        viewer,
      ),
    ).toBe(false)
  })

  it('treats an RPC failure as a no and does not remember it', async () => {
    const viewer = 'did:plc:rpcfail'
    const wallet = '0x' + '4'.repeat(40)
    await linkWallet(viewer, wallet)
    balances.set(wallet, 100n)
    const gate = rule('10')
    failRpc = true
    expect(await isEligible(db, rpcs, gate, viewer)).toBe(false)
    failRpc = false
    expect(await isEligible(db, rpcs, gate, viewer)).toBe(true)
  })
})

describe('gate lifecycle', () => {
  it('deletes the content with the last rule of a post', async () => {
    // The app stores the content first, then publishes the rule
    await putGatedContent(db, {
      subject: POST,
      did: AUTHOR,
      text: 'secret',
      facets: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const r1 = rule('1')
    const r2 = rule('2')
    await upsertGateRule(db, r1)
    await upsertGateRule(db, r2)
    await deleteGateRule(db, r1.uri)
    expect(await getGatedContent(db, POST)).toBeTruthy()
    await deleteGateRule(db, r2.uri)
    expect(await getGatedContent(db, POST)).toBeUndefined()
  })

  it('keeps content stored after the removed rule, for a gate added again', async () => {
    const old = rule('1')
    await upsertGateRule(db, old)
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Remove then add again: the new content lands before the old rule's
    // delete is indexed
    await putGatedContent(db, {
      subject: POST,
      did: AUTHOR,
      text: 'new gate',
      facets: null,
    })
    await deleteGateRule(db, old.uri)
    expect((await getGatedContent(db, POST))?.text).toBe('new gate')
  })

  it('drops content that never got a rule after a day', async () => {
    await putGatedContent(db, {
      subject: POST,
      did: AUTHOR,
      text: 'orphan',
      facets: null,
    })
    expect(await deleteContentWithoutRule(db)).toBe(0)
    expect(await deleteContentWithoutRule(db, Date.now() + 25 * 3600_000)).toBe(
      1,
    )
    expect(await getGatedContent(db, POST)).toBeUndefined()
  })

  it('keeps content that has a rule, however old', async () => {
    await upsertGateRule(db, rule('1'))
    await putGatedContent(db, {
      subject: POST,
      did: AUTHOR,
      text: 'kept',
      facets: null,
    })
    expect(await deleteContentWithoutRule(db, Date.now() + 48 * 3600_000)).toBe(
      0,
    )
  })
})
