import { type Kysely, sql } from 'kysely'

/**
 * Krao: accent-insensitive search, so "tien ao" finds "tiền ảo".
 *
 * unaccent() is only STABLE (its dictionary could change), so it cannot be
 * used in an index. f_unaccent() wraps it as IMMUTABLE, naming the
 * dictionary and the function with their schema so the result does not
 * depend on search_path (AppView tables live in their own schema, the
 * extensions in public). It also folds đ/Đ to d/D, which the default
 * unaccent rules may not do. Search matches with ILIKE on
 * f_unaccent(text) through trigram indexes on the same expression.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  for (const ext of ['unaccent', 'pg_trgm']) {
    try {
      await sql`create extension if not exists ${sql.raw(ext)} with schema public`.execute(
        db,
      )
    } catch (err: unknown) {
      // Test suites race to create shared extensions, see the init migration
      if (!err?.['detail']?.includes?.(`(${ext}) already exists`)) throw err
    }
  }
  await sql`
    create or replace function f_unaccent(text) returns text
    language sql immutable parallel safe strict
    as $$ select translate(public.unaccent('public.unaccent'::regdictionary, $1), 'đĐ', 'dD') $$
  `.execute(db)
  await sql`create index if not exists post_text_unaccent_trgm_idx on post using gin (f_unaccent(text) gin_trgm_ops)`.execute(
    db,
  )
  await sql`create index if not exists profile_display_name_unaccent_trgm_idx on profile using gin (f_unaccent("displayName") gin_trgm_ops)`.execute(
    db,
  )
  // Replaced by the index above: search no longer matches the raw text
  await sql`drop index if exists post_text_trgm_idx`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`create index if not exists post_text_trgm_idx on post using gin (text gin_trgm_ops)`.execute(
    db,
  )
  await sql`drop index if exists profile_display_name_unaccent_trgm_idx`.execute(
    db,
  )
  await sql`drop index if exists post_text_unaccent_trgm_idx`.execute(db)
  await sql`drop function if exists f_unaccent(text)`.execute(db)
}
