import type { Kysely } from 'kysely'

/**
 * Krao: the takedown outbox also carries account deletions, so the rewards
 * service can stop the account's codes and void the points that waited for
 * it. `kind` is "takedown" (applied or lifted) or "deleted".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('krao_takedown_outbox')
    .addColumn('kind', 'varchar', (col) => col.notNull().defaultTo('takedown'))
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('krao_takedown_outbox')
    .dropColumn('kind')
    .execute()
}
