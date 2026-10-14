import type { Kysely } from 'kysely'

/**
 * Sign-ups to report to the Krao rewards service: written in the same
 * transaction as the account, then delivered (and retried) in the background,
 * so a new account never loses who referred it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('krao_referral_outbox')
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('code', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('lastError', 'varchar')
    .addColumn('deliveredAt', 'varchar')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('krao_referral_outbox').execute()
}
