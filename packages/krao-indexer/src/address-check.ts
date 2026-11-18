import { sql } from 'kysely'
import type { Database } from './db.js'

/*
 * Address poisoning: a scammer sends dust from an address that starts and
 * ends like one the victim uses (wallets show "0x1234…abcd"), hoping it gets
 * copied from the history later. Krao knows which addresses accounts
 * verified, so it can tell who owns an address and which verified wallets of
 * other accounts it imitates.
 */

export const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/

/** Most lookalikes reported per address */
const MAX_LOOKALIKES = 10

export type Lookalike = { address: string; did: string }

export type AddressCheck = {
  address: string
  owner?: string
  matchesExpected?: boolean
  lookalikes: Lookalike[]
}

/**
 * The owner of each address: of the accounts with a verified link to it,
 * the first one seen (as wallets.ts decides for gates and tips). Owners that
 * are hidden (taken down, deactivated) are left out.
 */
async function firstOwners(
  db: Database,
  rows: { did: string; evmAddress: string | null }[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  for (const row of rows) {
    if (row.evmAddress && !owners.has(row.evmAddress)) {
      owners.set(row.evmAddress, row.did)
    }
  }
  const dids = [...new Set(owners.values())]
  if (!dids.length) return owners
  const hidden = new Set(
    (
      await db
        .selectFrom('hidden_actor')
        .select('did')
        .where('did', 'in', dids)
        .execute()
    ).map((r) => r.did),
  )
  for (const [address, did] of owners) {
    if (hidden.has(did)) owners.delete(address)
  }
  return owners
}

/**
 * Verified wallets whose address shares the first 4 and last 4 hex
 * characters with `address` but is another address, with their owners.
 * The expressions match the wallet_evm_ends_idx index (db.ts).
 */
export async function lookalikeWallets(
  db: Database,
  address: string,
): Promise<Lookalike[]> {
  const rows = await db
    .selectFrom('wallet')
    .select(['did', 'evmAddress'])
    .where(
      sql<boolean>`substr(evmAddress, 1, 6) = ${address.slice(0, 6)} and substr(evmAddress, -4) = ${address.slice(-4)}`,
    )
    .where('evmAddress', '!=', address)
    .where('status', '=', 'verified')
    .orderBy('indexedAt', 'asc')
    .orderBy('uri', 'asc')
    .limit(500)
    .execute()
  const owners = await firstOwners(db, rows)
  return [...owners].map(([addr, did]) => ({ address: addr, did }))
}

export class InvalidAddressError extends Error {}

/** Owner and lookalikes of each address (see net.krao.safety.checkAddresses) */
export async function checkAddresses(
  db: Database,
  addresses: string[],
  expectedDid?: string,
): Promise<AddressCheck[]> {
  const normalized = addresses.map((a) => a.trim().toLowerCase())
  const bad = normalized.find((a) => !EVM_ADDRESS_RE.test(a))
  if (bad !== undefined) {
    throw new InvalidAddressError(`Not an EVM address: ${bad.slice(0, 64)}`)
  }
  const unique = [...new Set(normalized)]
  const owners = await firstOwners(
    db,
    unique.length
      ? await db
          .selectFrom('wallet')
          .select(['did', 'evmAddress'])
          .where('evmAddress', 'in', unique)
          .where('status', '=', 'verified')
          .orderBy('indexedAt', 'asc')
          .orderBy('uri', 'asc')
          .execute()
      : [],
  )
  const similar = new Map<string, Lookalike[]>()
  for (const address of unique) {
    similar.set(address, await lookalikeWallets(db, address))
  }
  return normalized.map((address) => {
    const owner = owners.get(address)
    return {
      address,
      ...(owner ? { owner } : {}),
      ...(expectedDid ? { matchesExpected: owner === expectedDid } : {}),
      // A wallet of the same account is not an imitation
      lookalikes: (similar.get(address) ?? [])
        .filter((l) => l.did !== owner)
        .slice(0, MAX_LOOKALIKES),
    }
  })
}
