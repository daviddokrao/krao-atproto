import type { Kysely } from 'kysely'

/**
 * Account takedowns (and their lifting) to report to the Krao rewards
 * service, which takes back the account's points. Written in the takedown's
 * transaction, delivered in the background like krao_referral_outbox.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('krao_takedown_outbox')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('applied', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('lastError', 'varchar')
    .addColumn('deliveredAt', 'varchar')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('krao_takedown_outbox').execute()
}
