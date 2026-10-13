import { normalizeAccountId, verifyWalletProof } from '@krao/wallet'
import type { Database, WalletTable } from './db.js'

export const WALLET_COLLECTION = 'io.krao.actor.wallet'

/**
 * Turn an io.krao.actor.wallet record into a row, verifying its proof. Records
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

  return {
    uri,
    did,
    account,
    accountRaw,
    label,
    status: result.ok ? 'verified' : 'invalid',
    reason: result.ok ? null : result.reason,
    createdAt,
    indexedAt: now,
  }
}

export async function upsertWallet(db: Database, row: WalletTable) {
  await db
    .insertInto('wallet')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(row))
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
    .orderBy('createdAt', 'asc')
    .execute()
}

/** DIDs that have a verified link to the given wallet. */
export async function getWalletOwners(
  db: Database,
  accountId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom('wallet')
    .select('did')
    .distinct()
    .where('account', '=', normalizeAccountId(accountId))
    .where('status', '=', 'verified')
    .execute()
  return rows.map((r) => r.did)
}
