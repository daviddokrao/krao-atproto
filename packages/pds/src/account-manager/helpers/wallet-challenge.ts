import type { AccountDb } from '../db/index.js'

/** Stores a new challenge and drops expired ones. */
export const create = async (
  db: AccountDb,
  challenge: { nonce: string; account: string; expiresAt: string },
): Promise<void> => {
  await db.executeWithRetry(
    db.db
      .deleteFrom('wallet_challenge')
      .where('expiresAt', '<', new Date().toISOString()),
  )
  await db.executeWithRetry(
    db.db.insertInto('wallet_challenge').values(challenge),
  )
}

/**
 * Deletes and returns the challenge if it exists, belongs to `account` and has
 * not expired. A single DELETE … RETURNING keeps "check then use" atomic, so a
 * challenge can only ever be used once.
 */
export const consume = async (
  db: AccountDb,
  nonce: string,
  account: string,
): Promise<boolean> => {
  const rows = await db.executeWithRetry(
    db.db
      .deleteFrom('wallet_challenge')
      .where('nonce', '=', nonce)
      .where('account', '=', account)
      .where('expiresAt', '>', new Date().toISOString())
      .returningAll(),
  )
  return rows.length > 0
}
