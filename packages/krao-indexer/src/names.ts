import { keccak256 } from '@krao/wallet'
import type { EvmRpc } from './chain.js'
import { type Database, type WalletTable, visibleDid } from './db.js'
import { ownedEvmAddresses } from './wallets.js'

/*
 * Verified Basename / ENS names next to the handle (M32). For the verified
 * wallets an account owns, the indexer reads the wallet's primary name
 * (reverse record) and keeps it only when the name resolves forward to the
 * same address: anyone can set any reverse name, only the name's owner can
 * point it at an address. One name per account, Basenames first (Base L2),
 * then ENS on Ethereum mainnet when an RPC for it is configured.
 *
 * Only plain lowercase ASCII names (letters, digits, hyphens) are accepted:
 * no UTS-46 normalization library is needed for the namehash, and look-alike
 * Unicode names cannot pass for others. Names that resolve only through
 * wildcard or offchain (CCIP-read) resolvers are not supported.
 */

export type NameSource = 'basename' | 'ens'
export type PrimaryName = { name: string; source: NameSource; address: string }

/** The eth_call the resolution needs (EvmRpc, or a fake in tests) */
export type NameRpc = Pick<EvmRpc, 'tryCall'>

/** Basenames on Base (chain 8453) */
export const BASENAMES = {
  registry: '0xb94704422c2a1e396835a571837aa5ae53285a95',
  /** ENSIP-19 L2 reverse registrar (nameForAddr), the current reverse records */
  l2ReverseRegistrar: '0x0000000000d8e504002cc26e3ec46d81971c1664',
  /** Reverse records from before ENSIP-19: <addr>.80002105.reverse */
  legacyReverseSuffix: '80002105.reverse',
  suffix: '.base.eth',
}

/** ENS on Ethereum mainnet */
export const ENS = {
  registry: '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e',
  reverseSuffix: 'addr.reverse',
  suffix: '.eth',
}

const SELECTORS = {
  resolver: '0178b8bf', // resolver(bytes32)
  addr: '3b3b57de', // addr(bytes32)
  name: '691f3431', // name(bytes32)
  nameForAddr: '4ec3bd23', // nameForAddr(address)
}

const LABEL_RE = /^[a-z0-9-]{1,63}$/

export function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32)
  if (!name) return node
  for (const label of name.split('.').reverse()) {
    const joined = new Uint8Array(64)
    joined.set(node, 0)
    joined.set(keccak256(new TextEncoder().encode(label)), 32)
    node = keccak256(joined)
  }
  return node
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

/** Whether `name` may be shown as a primary name of `source` */
export function isAcceptableName(name: string, source: NameSource): boolean {
  if (name.length > 255 || name !== name.toLowerCase()) return false
  const labels = name.split('.')
  if (!labels.every((label) => LABEL_RE.test(label))) return false
  return source === 'basename'
    ? labels.length >= 3 && name.endsWith(BASENAMES.suffix)
    : labels.length >= 2 &&
        name.endsWith(ENS.suffix) &&
        // Basenames are only taken from Base
        !name.endsWith(BASENAMES.suffix)
}

/** An ABI-encoded `string` return value, or null */
export function decodeString(data: string | null): string | null {
  if (!data) return null
  const bytes = Buffer.from(data.replace(/^0x/, ''), 'hex')
  if (bytes.length < 64) return null
  const offset = Number(BigInt('0x' + bytes.subarray(0, 32).toString('hex')))
  if (offset + 32 > bytes.length) return null
  const length = Number(
    BigInt('0x' + bytes.subarray(offset, offset + 32).toString('hex')),
  )
  if (offset + 32 + length > bytes.length) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 32, offset + 32 + length),
    )
  } catch {
    return null
  }
}

/** An ABI-encoded `address` return value (lowercase), or null for none/zero */
export function decodeAddress(data: string | null): string | null {
  const clean = (data ?? '').replace(/^0x/, '')
  if (clean.length < 64) return null
  const address = '0x' + clean.slice(24, 64).toLowerCase()
  return /^0x0{40}$/.test(address) ? null : address
}

async function resolverOf(rpc: NameRpc, registry: string, node: Uint8Array) {
  return decodeAddress(
    await rpc.tryCall(registry, '0x' + SELECTORS.resolver + hex(node)),
  )
}

/** The address `name` resolves to (forward resolution), or null */
export async function forwardAddress(
  rpc: NameRpc,
  registry: string,
  name: string,
): Promise<string | null> {
  const node = namehash(name)
  const resolver = await resolverOf(rpc, registry, node)
  if (!resolver) return null
  return decodeAddress(
    await rpc.tryCall(resolver, '0x' + SELECTORS.addr + hex(node)),
  )
}

/** A reverse record through the registry: name(<node>) at its resolver */
async function reverseThroughRegistry(
  rpc: NameRpc,
  registry: string,
  reverseName: string,
) {
  const node = namehash(reverseName)
  const resolver = await resolverOf(rpc, registry, node)
  if (!resolver) return null
  return decodeString(
    await rpc.tryCall(resolver, '0x' + SELECTORS.name + hex(node)),
  )
}

/** The Basename `address` claims (reverse record), not yet verified */
export async function reverseBasename(
  rpc: NameRpc,
  address: string,
): Promise<string | null> {
  const bare = address.toLowerCase().replace(/^0x/, '')
  const current = decodeString(
    await rpc.tryCall(
      BASENAMES.l2ReverseRegistrar,
      '0x' + SELECTORS.nameForAddr + bare.padStart(64, '0'),
    ),
  )
  if (current) return current
  return reverseThroughRegistry(
    rpc,
    BASENAMES.registry,
    `${bare}.${BASENAMES.legacyReverseSuffix}`,
  )
}

/** The ENS name `address` claims (reverse record), not yet verified */
export async function reverseEns(
  rpc: NameRpc,
  address: string,
): Promise<string | null> {
  const bare = address.toLowerCase().replace(/^0x/, '')
  return reverseThroughRegistry(
    rpc,
    ENS.registry,
    `${bare}.${ENS.reverseSuffix}`,
  )
}

/**
 * The primary name of `address` from `source`, when its reverse record
 * names an acceptable name that resolves forward to the same address.
 * Throws when the chain cannot be reached.
 */
export async function verifiedName(
  rpc: NameRpc,
  source: NameSource,
  address: string,
): Promise<PrimaryName | null> {
  const lower = address.toLowerCase()
  const claimed =
    source === 'basename'
      ? await reverseBasename(rpc, lower)
      : await reverseEns(rpc, lower)
  if (!claimed || !isAcceptableName(claimed, source)) return null
  const registry = source === 'basename' ? BASENAMES.registry : ENS.registry
  const forward = await forwardAddress(rpc, registry, claimed)
  return forward === lower ? { name: claimed, source, address: lower } : null
}

/**
 * The account's primary name from its wallets, oldest link first:
 * Basenames on every wallet first, then ENS. Throws when a chain cannot be
 * reached (the last known name is then kept).
 */
export async function resolvePrimaryName(
  rpcs: { base?: NameRpc; ens?: NameRpc },
  addresses: string[],
): Promise<PrimaryName | null> {
  for (const [source, rpc] of [
    ['basename', rpcs.base],
    ['ens', rpcs.ens],
  ] as const) {
    if (!rpc) continue
    for (const address of addresses) {
      const name = await verifiedName(rpc, source, address)
      if (name) return name
    }
  }
  return null
}

/**
 * Addresses whose names may be shown for the account, oldest link first:
 * verified EVM wallets it owns (see ownedEvmAddresses), unless a link of
 * that wallet says not to (showPrimaryName false).
 */
export function nameAddresses(
  rows: Pick<
    WalletTable,
    'evmAddress' | 'status' | 'showPrimaryName' | 'createdAt'
  >[],
  owned: Set<string>,
): string[] {
  const hidden = new Set(
    rows
      .filter((r) => r.evmAddress && r.showPrimaryName === 0)
      .map((r) => r.evmAddress!),
  )
  const ordered = [...rows].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  )
  const result: string[] = []
  for (const row of ordered) {
    const address = row.evmAddress
    if (
      row.status === 'verified' &&
      address &&
      owned.has(address) &&
      !hidden.has(address) &&
      !result.includes(address)
    ) {
      result.push(address)
    }
  }
  return result
}

/** Names are checked again daily, and at most this often after a failure */
export const NAME_RECHECK_MS = 24 * 60 * 60 * 1000
export const NAME_RETRY_MS = 10 * 60 * 1000

/** The account's wallets changed: check its name at the next round */
export async function markPrimaryNameStale(db: Database, did: string) {
  await db
    .insertInto('primary_name')
    .values({
      did,
      name: null,
      source: null,
      address: null,
      checkedAt: null,
      attemptedAt: null,
      stale: 1,
    })
    .onConflict((oc) =>
      oc.column('did').doUpdateSet({ stale: 1, attemptedAt: null }),
    )
    .execute()
}

export async function deletePrimaryName(db: Database, did: string) {
  await db.deleteFrom('primary_name').where('did', '=', did).execute()
}

/**
 * Checks the names that are due: accounts whose wallets changed, and every
 * account daily. A chain that does not answer keeps the last known name and
 * is tried again after NAME_RETRY_MS.
 */
export async function refreshPrimaryNames(
  db: Database,
  rpcs: { base?: NameRpc; ens?: NameRpc },
  now = Date.now(),
  limit = 100,
) {
  const recheckBefore = new Date(now - NAME_RECHECK_MS).toISOString()
  const retryBefore = new Date(now - NAME_RETRY_MS).toISOString()
  const due = await db
    .selectFrom('primary_name')
    .select('did')
    .where((eb) =>
      eb.and([
        eb.or([
          eb('attemptedAt', 'is', null),
          eb('attemptedAt', '<', retryBefore),
        ]),
        eb.or([
          eb('stale', '=', 1),
          eb('checkedAt', 'is', null),
          eb('checkedAt', '<', recheckBefore),
        ]),
      ]),
    )
    .limit(limit)
    .execute()
  for (const { did } of due) {
    const at = new Date(now).toISOString()
    const [rows, owned] = await Promise.all([
      db
        .selectFrom('wallet')
        .select(['evmAddress', 'status', 'showPrimaryName', 'createdAt'])
        .where('did', '=', did)
        .execute(),
      ownedEvmAddresses(db, did),
    ])
    const addresses = nameAddresses(rows, owned)
    try {
      const name = addresses.length
        ? await resolvePrimaryName(rpcs, addresses)
        : null
      await db
        .updateTable('primary_name')
        .set({
          name: name?.name ?? null,
          source: name?.source ?? null,
          address: name?.address ?? null,
          checkedAt: at,
          attemptedAt: at,
          stale: 0,
        })
        .where('did', '=', did)
        .execute()
    } catch (err) {
      console.error('Krao indexer: primary name check failed', did, err)
      await db
        .updateTable('primary_name')
        .set({ attemptedAt: at })
        .where('did', '=', did)
        .execute()
    }
  }
}

/** The primary names of these accounts, as last checked */
export async function getPrimaryNames(
  db: Database,
  dids: string[],
): Promise<Map<string, PrimaryName>> {
  if (!dids.length) return new Map()
  const rows = await db
    .selectFrom('primary_name')
    .select(['did', 'name', 'source', 'address'])
    .where('did', 'in', dids)
    .where('name', 'is not', null)
    .where(visibleDid('did'))
    .execute()
  return new Map(
    rows.map((r) => [
      r.did,
      {
        name: r.name!,
        source: r.source as NameSource,
        address: r.address!,
      },
    ]),
  )
}
