import { normalizeAccountId, verifyWalletProof } from '@krao/wallet'
import { type Database, type WalletTable, visibleDid } from './db.js'

export const WALLET_COLLECTION = 'net.krao.actor.wallet'

/**
 * Turn an net.krao.actor.wallet record into a row, verifying its proof. Records
 * that are malformed are still stored (as invalid) so clients can show the
 * user why a link is not working.
 */
export function walletRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): WalletTable {
  const now = new Date().toISOString()
  const value = (record ?? {}) as Record<string, unknown>
  const accountRaw = typeof value.account === 'string' ? value.account : ''
  const proof = value.proof as Record<string, unknown> | undefined
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : now
  const label = typeof value.label === 'string' ? value.label : null

  let account = accountRaw
  let result: { ok: true } | { ok: false; reason: string }
  if (
    !proof ||
    typeof proof.type !== 'string' ||
    typeof proof.message !== 'string' ||
    typeof proof.signature !== 'string'
  ) {
    result = { ok: false, reason: 'Missing or malformed proof' }
  } else {
    result = verifyWalletProof({
      did,
      account: accountRaw,
      proof: {
        type: proof.type,
        message: proof.message,
        signature: proof.signature,
      },
    })
    if (result.ok) account = normalizeAccountId(accountRaw)
  }

  const evmAddress = account.startsWith('eip155:')
    ? (account.split(':')[2]?.toLowerCase() ?? null)
    : null
  return {
    uri,
    did,
    account,
    accountRaw,
    evmAddress,
    label,
    status: result.ok ? 'verified' : 'invalid',
    reason: result.ok ? null : result.reason,
    createdAt,
    indexedAt: now,
  }
}

/** Verified wallets one account may have; more are marked invalid */
export const MAX_WALLETS_PER_ACCOUNT = 10

export async function upsertWallet(db: Database, row: WalletTable) {
  if (row.status === 'verified') {
    const others = await db
      .selectFrom('wallet')
      .select('account')
      .distinct()
      .where('did', '=', row.did)
      .where('status', '=', 'verified')
      .where('uri', '!=', row.uri)
      .where('account', '!=', row.account)
      .execute()
    if (others.length >= MAX_WALLETS_PER_ACCOUNT) {
      row = { ...row, status: 'invalid', reason: 'Too many linked wallets' }
    }
  }
  // indexedAt stays the first time the link was seen: it decides which
  // account owns a wallet linked by several (see ownedEvmAddresses)
  const { indexedAt: _first, ...update } = row
  await db
    .insertInto('wallet')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(update))
    .execute()
}

export async function deleteWallet(db: Database, uri: string) {
  await db.deleteFrom('wallet').where('uri', '=', uri).execute()
}

export async function deleteWalletsForDid(db: Database, did: string) {
  await db.deleteFrom('wallet').where('did', '=', did).execute()
}

export async function getWalletsForDids(db: Database, dids: string[]) {
  if (!dids.length) return []
  return db
    .selectFrom('wallet')
    .selectAll()
    .where('did', 'in', dids)
    .where(visibleDid('did'))
    .orderBy('createdAt', 'asc')
    .execute()
}

/**
 * One row per wallet of each account. Linking the same wallet again creates
 * another record, so keep the oldest verified one, or else the oldest.
 * Rows must be ordered by createdAt.
 */
export function uniqueWallets<T extends WalletTable>(rows: T[]): T[] {
  const best = new Map<string, T>()
  for (const row of rows) {
    const key = walletKey(row)
    const current = best.get(key)
    if (
      !current ||
      (current.status !== 'verified' && row.status === 'verified')
    ) {
      best.set(key, row)
    }
  }
  return rows.filter((row) => best.get(walletKey(row)) === row)
}

function walletKey(row: WalletTable): string {
  let account = row.accountRaw
  try {
    account = normalizeAccountId(row.accountRaw)
  } catch {
    // malformed ids can only match themselves
  }
  return `${row.did} ${account}`
}

/**
 * The account that owns the given wallet: of the accounts with a verified
 * link to it, the first one seen. Anyone can link a wallet they control to
 * several accounts; only one of them may sign in with it.
 */
export async function getWalletOwners(
  db: Database,
  accountId: string,
): Promise<string[]> {
  const account = normalizeAccountId(accountId)
  // EVM: one owner per address on every chain, as for gates and tips
  const evmAddress = account.startsWith('eip155:')
    ? account.split(':')[2]?.toLowerCase()
    : undefined
  const row = await db
    .selectFrom('wallet')
    .select('did')
    .where((eb) =>
      evmAddress
        ? eb('evmAddress', '=', evmAddress)
        : eb('account', '=', account),
    )
    .where('status', '=', 'verified')
    .orderBy('indexedAt', 'asc')
    .orderBy('uri', 'asc')
    .executeTakeFirst()
  return row ? [row.did] : []
}

/**
 * Lowercase EVM addresses `did` owns: verified links where no other account
 * linked the same address first. EVM addresses are the same on every chain,
 * so links on any eip155 chain count. One wallet then cannot open token
 * gates, back NFT avatars or receive tips for many accounts at once.
 */
export async function ownedEvmAddresses(
  db: Database,
  did: string,
): Promise<Set<string>> {
  const mine = await db
    .selectFrom('wallet')
    .select('evmAddress')
    .where('did', '=', did)
    .where('status', '=', 'verified')
    .where('evmAddress', 'is not', null)
    .execute()
  const addresses = [...new Set(mine.map((w) => w.evmAddress!))]
  if (!addresses.length) return new Set()
  const links = await db
    .selectFrom('wallet')
    .select(['did', 'evmAddress'])
    .where('status', '=', 'verified')
    .where('evmAddress', 'in', addresses)
    .orderBy('indexedAt', 'asc')
    .orderBy('uri', 'asc')
    .execute()
  const owner = new Map<string, string>()
  for (const link of links) {
    if (link.evmAddress && !owner.has(link.evmAddress)) {
      owner.set(link.evmAddress, link.did)
    }
  }
  return new Set(addresses.filter((a) => owner.get(a) === did))
}
