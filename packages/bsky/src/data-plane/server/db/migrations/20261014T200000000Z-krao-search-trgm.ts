import { type Kysely, sql } from 'kysely'

/**
 * Krao: post and starter pack search use ILIKE '%term%' (Krao runs no
 * separate search service), which needs trigram indexes to avoid full scans.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index if not exists post_text_trgm_idx on post using gin (text gin_trgm_ops)`.execute(
    db,
  )
  await sql`create index if not exists starter_pack_name_trgm_idx on starter_pack using gin (name gin_trgm_ops)`.execute(
    db,
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists starter_pack_name_trgm_idx`.execute(db)
  await sql`drop index if exists post_text_trgm_idx`.execute(db)
}
