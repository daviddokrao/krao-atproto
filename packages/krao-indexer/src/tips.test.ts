import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EvmRpc } from './chain.js'
import { type Database, type TipTable, createDb, migrateDb } from './db.js'
import {
  getPendingTips,
  listTips,
  tipRowFromRecord,
  upsertTip,
  verifyTip,
} from './tips.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const ETH = `${BASE}/slip44:60`
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const SENDER = 'did:plc:sender'
const RECIPIENT = 'did:plc:recipient'
const THIEF = 'did:plc:thief'
const SENDER_WALLET = addr(1)
const RECIPIENT_WALLET = addr(2)
const THIEF_WALLET = addr(3)
const TX = `0x${'ab'.repeat(32)}`

/**
 * A chain holding one transfer: SENDER_WALLET sent 1000 wei to
 * RECIPIENT_WALLET in TX. Checks it the way EvmRpc.checkTransfer does.
 */
const chain = {
  checkTransfer: async ({
    txHash,
    from,
    to,
    amount,
  }: {
    txHash: string
    from?: string
    to: string
    amount: bigint
  }) => {
    if (txHash !== TX) {
      return { status: 'pending' as const, reason: 'Transaction not mined yet' }
    }
    if (to.toLowerCase() !== RECIPIENT_WALLET) {
      return { status: 'invalid' as const, reason: 'recipient mismatch' }
    }
    if (from && from.toLowerCase() !== SENDER_WALLET) {
      return { status: 'invalid' as const, reason: 'sender mismatch' }
    }
    if (amount !== 1000n) {
      return { status: 'invalid' as const, reason: 'amount mismatch' }
    }
    return { status: 'verified' as const }
  },
} as unknown as EvmRpc
const rpcs = new Map([[BASE, chain]])

let db: Database
let seq = 0

async function linkWallet(did: string, address: string) {
  const now = new Date().toISOString()
  await upsertWallet(db, {
    uri: `at://${did}/net.krao.actor.wallet/${++seq}`,
    did,
    account: `${BASE}:${address}`,
    accountRaw: `${BASE}:${address}`,
    evmAddress: address.toLowerCase(),
    label: null,
    status: 'verified',
    reason: null,
    createdAt: now,
    indexedAt: now,
  })
}

/** Index a tip record by `did` and verify it, like the indexer does */
async function tip(
  did: string,
  record: Record<string, unknown>,
  indexedAt = new Date(Date.now() + ++seq).toISOString(),
): Promise<TipTable['status']> {
  const row = {
    ...tipRowFromRecord(`at://${did}/net.krao.feed.tip/${++seq}`, did, {
      recipient: RECIPIENT,
      asset: ETH,
      amount: '1000',
      txHash: TX,
      from: `${BASE}:${SENDER_WALLET}`,
      to: `${BASE}:${RECIPIENT_WALLET}`,
      createdAt: new Date().toISOString(),
      ...record,
    }),
    indexedAt,
  }
  await upsertTip(db, row)
  return verifyTip(db, rpcs, row)
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  await linkWallet(SENDER, SENDER_WALLET)
  await linkWallet(RECIPIENT, RECIPIENT_WALLET)
  await linkWallet(THIEF, THIEF_WALLET)
})

afterEach(async () => {
  await db.destroy()
})

describe('verifyTip', () => {
  it('credits the account that sent the transfer', async () => {
    expect(await tip(SENDER, {})).toBe('verified')
  })

  it('refuses a tip without a sender wallet', async () => {
    expect(await tip(THIEF, { from: undefined })).toBe('invalid')
  })

  it('refuses a claim naming a wallet the tipper has not linked', async () => {
    // The thief names the real sender's wallet, which they do not control
    expect(await tip(THIEF, {})).toBe('invalid')
    // The real sender is still credited afterwards
    expect(await tip(SENDER, {})).toBe('verified')
  })

  it('refuses a claim from the tipper own wallet that did not send it', async () => {
    expect(await tip(THIEF, { from: `${BASE}:${THIEF_WALLET}` })).toBe(
      'invalid',
    )
  })

  it('lets one transaction back one tip only', async () => {
    expect(await tip(SENDER, {})).toBe('verified')
    expect(await tip(SENDER, {})).toBe('invalid')
  })

  it('makes a later claim by the same sender wait for an earlier pending one', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString()
    // An earlier claim on a chain this indexer has no RPC for stays pending
    await upsertTip(db, {
      ...tipRowFromRecord(`at://${SENDER}/net.krao.feed.tip/early`, SENDER, {
        recipient: RECIPIENT,
        asset: ETH,
        amount: '1000',
        txHash: TX,
        from: `${BASE}:${SENDER_WALLET}`,
        to: `${BASE}:${RECIPIENT_WALLET}`,
      }),
      indexedAt: t0,
    })
    expect(await tip(SENDER, {})).toBe('pending')
  })

  it('does not let a claim naming another sender hold a tip back', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString()
    // A bogus claim from the thief's own wallet, on a chain with no RPC, so
    // it can never settle
    expect(
      await tip(
        THIEF,
        {
          asset: 'eip155:1/slip44:60',
          from: `eip155:1:${THIEF_WALLET}`,
          to: `eip155:1:${RECIPIENT_WALLET}`,
        },
        t0,
      ),
    ).toBe('pending')
    expect(await tip(SENDER, {})).toBe('verified')
  })

  it('refuses a transfer to a wallet the recipient has not linked', async () => {
    expect(await tip(SENDER, { to: `${BASE}:${addr(9)}` })).toBe('invalid')
  })

  it('shows only verified tips, and none from hidden accounts', async () => {
    await tip(SENDER, {})
    await tip(SENDER, { txHash: `0x${'cd'.repeat(32)}` }) // never mined
    const listed = await listTips(db, { recipient: RECIPIENT }, 10)
    expect(listed.map((t) => t.status)).toEqual(['verified'])
    await db
      .insertInto('hidden_actor')
      .values({
        did: SENDER,
        status: 'takendown',
        since: new Date().toISOString(),
      })
      .execute()
    expect(await listTips(db, { recipient: RECIPIENT }, 10)).toEqual([])
  })

  it('checks a pending tip again later, not on every round', async () => {
    await tip(SENDER, { txHash: `0x${'ef'.repeat(32)}` }) // never mined
    expect(await getPendingTips(db)).toHaveLength(0)
    expect(await getPendingTips(db, Date.now() + 6_000)).toHaveLength(1)
  })
})
