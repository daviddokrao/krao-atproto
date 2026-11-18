import type { Kysely } from 'kysely'

/**
 * Krao outboxes: rows the rewards service rejected for good get `failedAt`,
 * so they stop blocking later rows, and the background scan is indexed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ['krao_referral_outbox', 'krao_takedown_outbox']) {
    await db.schema.alterTable(table).addColumn('failedAt', 'varchar').execute()
    await db.schema
      .createIndex(`${table}_pending_idx`)
      .on(table)
      .columns(['deliveredAt', 'failedAt', 'createdAt'])
      .execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['krao_referral_outbox', 'krao_takedown_outbox']) {
    await db.schema.dropIndex(`${table}_pending_idx`).execute()
    await db.schema.alterTable(table).dropColumn('failedAt').execute()
  }
}
