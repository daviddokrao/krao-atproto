import type { Kysely } from 'kysely'

/**
 * One-time challenges for Krao wallet sign-in (net.krao.server.*). A row is
 * deleted when it is used, so a signed challenge cannot be replayed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('wallet_challenge')
    .addColumn('nonce', 'varchar', (col) => col.primaryKey())
    .addColumn('account', 'varchar', (col) => col.notNull())
    .addColumn('expiresAt', 'varchar', (col) => col.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('wallet_challenge').execute()
}
