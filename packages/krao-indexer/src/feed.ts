import type { Database, FeedGeneratorTable, FeedPostTable } from './db.js'

export const POST_COLLECTION = 'app.bsky.feed.post'
export const FEED_GENERATOR_COLLECTION = 'app.bsky.feed.generator'

/**
 * Posts for the "latest" feed: top-level posts only, since replies make no
 * sense out of their thread.
 */
export function feedPostRowFromRecord(
  uri: string,
  cid: string,
  did: string,
  record: unknown,
): FeedPostTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  if (value.reply) return null
  return { uri, cid, did, indexedAt: new Date().toISOString() }
}

export async function upsertFeedPost(db: Database, row: FeedPostTable) {
  await db
    .insertInto('feed_post')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet({ cid: row.cid }))
    .execute()
}

export async function deleteFeedPost(db: Database, uri: string) {
  await db.deleteFrom('feed_post').where('uri', '=', uri).execute()
}

export async function deleteFeedDataForDid(db: Database, did: string) {
  await db.deleteFrom('feed_post').where('did', '=', did).execute()
  await db.deleteFrom('feed_generator').where('did', '=', did).execute()
}

/**
 * Feed generator records pointing at this service. Only these feeds are
 * served, so anyone can publish a record for them but not invent new ones.
 */
export async function upsertFeedGenerator(
  db: Database,
  row: FeedGeneratorTable,
) {
  await db
    .insertInto('feed_generator')
    .values(row)
    .onConflict((oc) => oc.column('uri').doNothing())
    .execute()
}

export async function deleteFeedGenerator(db: Database, uri: string) {
  await db.deleteFrom('feed_generator').where('uri', '=', uri).execute()
}

export async function listFeedGenerators(db: Database): Promise<string[]> {
  const rows = await db.selectFrom('feed_generator').select('uri').execute()
  return rows.map((r) => r.uri)
}

/** Newest posts first. The cursor is `<indexedAt>::<cid>`. */
export async function getLatestPosts(
  db: Database,
  limit: number,
  cursor?: string,
) {
  let qb = db
    .selectFrom('feed_post')
    .select(['uri', 'cid', 'indexedAt'])
    .orderBy('indexedAt', 'desc')
    .orderBy('cid', 'desc')
    .limit(limit)
  if (cursor) {
    const [indexedAt, cid] = cursor.split('::')
    if (!indexedAt || !cid) throw new Error('Malformed cursor')
    qb = qb.where((eb) =>
      eb.or([
        eb('indexedAt', '<', indexedAt),
        eb.and([eb('indexedAt', '=', indexedAt), eb('cid', '<', cid)]),
      ]),
    )
  }
  const rows = await qb.execute()
  const last = rows.at(-1)
  return {
    posts: rows.map((r) => r.uri),
    cursor:
      rows.length === limit && last
        ? `${last.indexedAt}::${last.cid}`
        : undefined,
  }
}
