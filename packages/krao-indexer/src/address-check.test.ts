import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkAddresses, lookalikeWallets } from './address-check.js'
import { type Database, createDb, migrateDb } from './db.js'

/** An address starting 0x1234 and ending abcd */
const addr = (fill: string) => `0x1234${fill.repeat(32)}abcd`
const BOB_ADDRESS = addr('a')
// Same first 4 and last 4 hex characters, another address
const POISON = addr('b')
const UNRELATED = `0x9999${'c'.repeat(32)}0000`

describe('checkAddresses', () => {
  let db: Database
  let n = 0

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const link = async (
    did: string,
    address: string,
    status: 'verified' | 'invalid' = 'verified',
  ) => {
    n++
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
    await db
      .insertInto('wallet')
      .values({
        uri: `at://${did}/net.krao.actor.wallet/${n}`,
        did,
        account: `eip155:8453:${address}`,
        accountRaw: `eip155:8453:${address}`,
        evmAddress: address,
        label: null,
        status,
        reason: null,
        showPrimaryName: 1,
        createdAt: at,
        indexedAt: at,
      })
      .execute()
  }

  it('resolves the owner of a verified wallet, in any case', async () => {
    await link('did:bob', BOB_ADDRESS)
    const [result] = await checkAddresses(
      db,
      [BOB_ADDRESS.toUpperCase().replace('0X', '0x')],
      'did:bob',
    )
    expect(result).toEqual({
      address: BOB_ADDRESS,
      owner: 'did:bob',
      matchesExpected: true,
      lookalikes: [],
    })
  })

  it("finds another account's wallet that a poisoned address imitates", async () => {
    await link('did:bob', BOB_ADDRESS)
    await link('did:bob', UNRELATED)
    // The scammer may even verify the poisoned address on their account
    await link('did:mallory', POISON)
    const [unknown, mallory] = await checkAddresses(
      db,
      [addr('c'), POISON],
      'did:bob',
    )
    expect(unknown.owner).toBeUndefined()
    expect(unknown.matchesExpected).toBe(false)
    expect(unknown.lookalikes.map((l) => l.did).sort()).toEqual([
      'did:bob',
      'did:mallory',
    ])
    expect(mallory.owner).toBe('did:mallory')
    expect(mallory.matchesExpected).toBe(false)
    expect(mallory.lookalikes).toEqual([
      { address: BOB_ADDRESS, did: 'did:bob' },
    ])
  })

  it('does not count wallets of the same account, unverified links or hidden accounts', async () => {
    await link('did:bob', BOB_ADDRESS)
    await link('did:bob', POISON)
    await link('did:eve', addr('d'), 'invalid')
    await link('did:gone', addr('e'))
    await db
      .insertInto('hidden_actor')
      .values({ did: 'did:gone', status: 'takendown', since: 'now' })
      .execute()
    const [result] = await checkAddresses(db, [BOB_ADDRESS])
    expect(result.owner).toBe('did:bob')
    expect(result.matchesExpected).toBeUndefined()
    expect(result.lookalikes).toEqual([])
  })

  it('keeps the first account that linked an address as its owner', async () => {
    await link('did:first', BOB_ADDRESS)
    await link('did:second', BOB_ADDRESS)
    const [result] = await checkAddresses(db, [BOB_ADDRESS])
    expect(result.owner).toBe('did:first')
  })

  it('refuses malformed addresses', async () => {
    await expect(checkAddresses(db, ['0x1234'])).rejects.toThrow(
      /Not an EVM address/,
    )
  })

  it('looks lookalikes up through the index', async () => {
    await link('did:bob', BOB_ADDRESS)
    expect(await lookalikeWallets(db, POISON)).toEqual([
      { address: BOB_ADDRESS, did: 'did:bob' },
    ])
    const plan = await sql<{
      detail: string
    }>`explain query plan select did from wallet where substr(evmAddress, 1, 6) = ${'0x1234'} and substr(evmAddress, -4) = ${'abcd'}`.execute(
      db,
    )
    expect(plan.rows.map((r) => r.detail).join(' ')).toContain(
      'wallet_evm_ends_idx',
    )
  })
})
