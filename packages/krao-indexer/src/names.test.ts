import { functionSelector } from '@krao/wallet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  BASENAMES,
  ENS,
  type NameRpc,
  decodeAddress,
  decodeString,
  getPrimaryNames,
  isAcceptableName,
  markPrimaryNameStale,
  nameAddresses,
  namehash,
  refreshPrimaryNames,
  resolvePrimaryName,
  verifiedName,
} from './names.js'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const sel = (sig: string) => hex(functionSelector(sig))
const RESOLVER = '0x00000000000000000000000000000000000000aa'
const ALICE = '0x1111111111111111111111111111111111111111'
const BOB = '0x2222222222222222222222222222222222222222'

const word = (value: string) => value.replace(/^0x/, '').padStart(64, '0')
function encodeString(value: string) {
  const bytes = Buffer.from(value, 'utf8')
  const padded = Buffer.concat([
    bytes,
    Buffer.alloc((32 - (bytes.length % 32)) % 32),
  ])
  return '0x' + word('20') + word(bytes.length.toString(16)) + hex(padded)
}

/**
 * A chain with one registry and resolver (Basenames' layout): forward
 * records, ENSIP-19 reverse records and legacy reverse records
 */
function fakeChain(registry: string, reverseSuffix: string) {
  const forward = new Map<string, string>()
  const reverse = new Map<string, string>()
  const legacy = new Map<string, string>()
  let down = false
  const nodes = () => {
    const map = new Map<string, { kind: 'name' | 'reverse'; key: string }>()
    for (const name of forward.keys()) {
      map.set(hex(namehash(name)), { kind: 'name', key: name })
    }
    for (const address of legacy.keys()) {
      map.set(hex(namehash(`${address.slice(2)}.${reverseSuffix}`)), {
        kind: 'reverse',
        key: address,
      })
    }
    return map
  }
  const rpc: NameRpc = {
    async tryCall(to, data) {
      if (down) throw new Error('fetch failed')
      const selector = data.slice(2, 10)
      const arg = data.slice(10, 74)
      to = to.toLowerCase()
      if (
        to === BASENAMES.l2ReverseRegistrar &&
        selector === sel('nameForAddr(address)')
      ) {
        return encodeString(reverse.get('0x' + arg.slice(24)) ?? '')
      }
      if (to === registry && selector === sel('resolver(bytes32)')) {
        return '0x' + word(nodes().has(arg) ? RESOLVER : '0')
      }
      if (to === RESOLVER) {
        const found = nodes().get(arg)
        if (selector === sel('addr(bytes32)') && found?.kind === 'name') {
          return '0x' + word(forward.get(found.key)!)
        }
        if (selector === sel('name(bytes32)') && found?.kind === 'reverse') {
          return encodeString(legacy.get(found.key)!)
        }
        return null
      }
      return '0x'
    },
  }
  return {
    rpc,
    forward,
    reverse,
    legacy,
    setDown: (value: boolean) => (down = value),
  }
}

describe('namehash', () => {
  it('matches the ENS test vectors', () => {
    expect(hex(namehash(''))).toBe('0'.repeat(64))
    expect(hex(namehash('eth'))).toBe(
      '93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae',
    )
    expect(hex(namehash('foo.eth'))).toBe(
      'de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f',
    )
  })
})

describe('isAcceptableName', () => {
  it('takes lowercase ASCII Basenames and ENS names only', () => {
    expect(isAcceptableName('alice.base.eth', 'basename')).toBe(true)
    expect(isAcceptableName('alice.eth', 'basename')).toBe(false)
    expect(isAcceptableName('alice.eth', 'ens')).toBe(true)
    expect(isAcceptableName('alice.base.eth', 'ens')).toBe(false)
    expect(isAcceptableName('Alice.base.eth', 'basename')).toBe(false)
    // Look-alike Unicode (Cyrillic a) and empty labels
    expect(isAcceptableName('аlice.base.eth', 'basename')).toBe(false)
    expect(isAcceptableName('alice..base.eth', 'basename')).toBe(false)
    expect(isAcceptableName('al ice.eth', 'ens')).toBe(false)
  })
})

describe('ABI decoding', () => {
  it('decodes strings and addresses, rejecting malformed data', () => {
    expect(decodeString(encodeString('jesse.base.eth'))).toBe('jesse.base.eth')
    expect(decodeString(encodeString(''))).toBe('')
    expect(decodeString('0x')).toBeNull()
    expect(decodeString(null)).toBeNull()
    expect(decodeString('0x' + word('20') + word('ff'))).toBeNull()
    expect(decodeAddress('0x' + word(ALICE))).toBe(ALICE)
    expect(decodeAddress('0x' + word('0'))).toBeNull()
    expect(decodeAddress('0x')).toBeNull()
  })
})

describe('verifiedName', () => {
  it('needs the forward record to point back at the same address', async () => {
    const chain = fakeChain(BASENAMES.registry, BASENAMES.legacyReverseSuffix)
    chain.reverse.set(ALICE, 'alice.base.eth')
    chain.forward.set('alice.base.eth', ALICE)
    expect(await verifiedName(chain.rpc, 'basename', ALICE)).toEqual({
      name: 'alice.base.eth',
      source: 'basename',
      address: ALICE,
    })
    // Bob claims Alice's name: his reverse record says so, the name does not
    chain.reverse.set(BOB, 'alice.base.eth')
    expect(await verifiedName(chain.rpc, 'basename', BOB)).toBeNull()
    // And a name nobody resolved
    chain.reverse.set(BOB, 'ghost.base.eth')
    expect(await verifiedName(chain.rpc, 'basename', BOB)).toBeNull()
  })

  it('falls back to legacy reverse records, and checks ENS the same way', async () => {
    const base = fakeChain(BASENAMES.registry, BASENAMES.legacyReverseSuffix)
    base.legacy.set(BOB, 'bob.base.eth')
    base.forward.set('bob.base.eth', BOB)
    expect((await verifiedName(base.rpc, 'basename', BOB))?.name).toBe(
      'bob.base.eth',
    )
    const ens = fakeChain(ENS.registry, ENS.reverseSuffix)
    ens.legacy.set(ALICE, 'alice.eth')
    ens.forward.set('alice.eth', ALICE)
    expect(await verifiedName(ens.rpc, 'ens', ALICE)).toEqual({
      name: 'alice.eth',
      source: 'ens',
      address: ALICE,
    })
    ens.forward.set('alice.eth', BOB)
    expect(await verifiedName(ens.rpc, 'ens', ALICE)).toBeNull()
  })

  it('prefers a Basename on any wallet over an ENS name', async () => {
    const base = fakeChain(BASENAMES.registry, BASENAMES.legacyReverseSuffix)
    const ens = fakeChain(ENS.registry, ENS.reverseSuffix)
    ens.legacy.set(ALICE, 'alice.eth')
    ens.forward.set('alice.eth', ALICE)
    base.reverse.set(BOB, 'bob.base.eth')
    base.forward.set('bob.base.eth', BOB)
    expect(
      await resolvePrimaryName({ base: base.rpc, ens: ens.rpc }, [ALICE, BOB]),
    ).toMatchObject({ name: 'bob.base.eth', source: 'basename' })
    expect(
      await resolvePrimaryName({ ens: ens.rpc }, [ALICE, BOB]),
    ).toMatchObject({ name: 'alice.eth', source: 'ens' })
  })
})

describe('nameAddresses', () => {
  const row = (
    evmAddress: string,
    createdAt: string,
    showPrimaryName = 1,
    status: 'verified' | 'invalid' = 'verified',
  ) => ({ evmAddress, createdAt, showPrimaryName, status })

  it('keeps owned, verified, shown wallets, oldest link first', () => {
    expect(
      nameAddresses(
        [
          row(BOB, '2026-10-02'),
          row(ALICE, '2026-10-01'),
          row('0x3333333333333333333333333333333333333333', '2026-09-01'),
        ],
        new Set([ALICE, BOB]),
      ),
    ).toEqual([ALICE, BOB])
    expect(
      nameAddresses(
        [row(ALICE, '2026-10-01'), row(ALICE, '2026-10-03', 0)],
        new Set([ALICE]),
      ),
    ).toEqual([])
    expect(
      nameAddresses([row(ALICE, '2026-10-01', 1, 'invalid')], new Set([ALICE])),
    ).toEqual([])
  })
})

describe('refreshPrimaryNames', () => {
  let db: Database
  const DID = 'did:plc:alice'
  const NOW = Date.parse('2026-10-16T12:00:00Z')

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    await db
      .insertInto('wallet')
      .values({
        uri: `at://${DID}/net.krao.actor.wallet/1`,
        did: DID,
        account: `eip155:8453:${ALICE}`,
        accountRaw: `eip155:8453:${ALICE}`,
        evmAddress: ALICE,
        label: null,
        status: 'verified',
        reason: null,
        showPrimaryName: 1,
        createdAt: '2026-10-01T00:00:00.000Z',
        indexedAt: '2026-10-01T00:00:00.000Z',
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('stores the verified name, keeps it through RPC failures, rechecks daily', async () => {
    const chain = fakeChain(BASENAMES.registry, BASENAMES.legacyReverseSuffix)
    chain.reverse.set(ALICE, 'alice.base.eth')
    chain.forward.set('alice.base.eth', ALICE)
    await markPrimaryNameStale(db, DID)
    await refreshPrimaryNames(db, { base: chain.rpc }, NOW)
    expect((await getPrimaryNames(db, [DID])).get(DID)).toEqual({
      name: 'alice.base.eth',
      source: 'basename',
      address: ALICE,
    })

    // The chain is down for the daily check: the name stays
    chain.setDown(true)
    const nextDay = NOW + 25 * 60 * 60 * 1000
    await refreshPrimaryNames(db, { base: chain.rpc }, nextDay)
    expect((await getPrimaryNames(db, [DID])).get(DID)?.name).toBe(
      'alice.base.eth',
    )

    // Back up, retried after the retry delay: the name moved away
    chain.setDown(false)
    chain.forward.set('alice.base.eth', BOB)
    await refreshPrimaryNames(db, { base: chain.rpc }, nextDay + 60_000)
    expect((await getPrimaryNames(db, [DID])).has(DID)).toBe(true)
    await refreshPrimaryNames(db, { base: chain.rpc }, nextDay + 11 * 60_000)
    expect((await getPrimaryNames(db, [DID])).has(DID)).toBe(false)
  })

  it('drops the name when the owner hides it', async () => {
    const chain = fakeChain(BASENAMES.registry, BASENAMES.legacyReverseSuffix)
    chain.reverse.set(ALICE, 'alice.base.eth')
    chain.forward.set('alice.base.eth', ALICE)
    await markPrimaryNameStale(db, DID)
    await refreshPrimaryNames(db, { base: chain.rpc }, NOW)
    await db.updateTable('wallet').set({ showPrimaryName: 0 }).execute()
    await markPrimaryNameStale(db, DID)
    await refreshPrimaryNames(db, { base: chain.rpc }, NOW + 1000)
    expect((await getPrimaryNames(db, [DID])).has(DID)).toBe(false)
  })
})
