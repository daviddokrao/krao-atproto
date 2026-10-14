import type {
  Database,
  FeedGeneratorTable,
  FeedInteractionTable,
  FeedPostTable,
} from './db.js'

export const POST_COLLECTION = 'app.bsky.feed.post'
export const FEED_GENERATOR_COLLECTION = 'app.bsky.feed.generator'
export const LIKE_COLLECTION = 'app.bsky.feed.like'
export const REPOST_COLLECTION = 'app.bsky.feed.repost'

/** The rkey of the feed generator record that serves the "popular" feed */
export const POPULAR_FEED_RKEY = 'popular'

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
  const createdAt =
    typeof value.createdAt === 'string' && !isNaN(Date.parse(value.createdAt))
      ? new Date(value.createdAt).toISOString()
      : null
  return { uri, cid, did, indexedAt: new Date().toISOString(), createdAt }
}

export async function upsertFeedPost(db: Database, row: FeedPostTable) {
  await db
    .insertInto('feed_post')
    .values(row)
    .onConflict((oc) =>
      oc.column('uri').doUpdateSet({ cid: row.cid, createdAt: row.createdAt }),
    )
    .execute()
}

export async function deleteFeedPost(db: Database, uri: string) {
  await db.deleteFrom('feed_post').where('uri', '=', uri).execute()
}

/** A like or repost, or null when the record names no post */
export function feedInteractionRowFromRecord(
  uri: string,
  did: string,
  collection: string,
  record: unknown,
): FeedInteractionTable | null {
  const subject = (record as { subject?: { uri?: unknown } } | null)?.subject
  if (typeof subject?.uri !== 'string') return null
  return {
    uri,
    did,
    subject: subject.uri,
    kind: collection === LIKE_COLLECTION ? 'like' : 'repost',
    indexedAt: new Date().toISOString(),
  }
}

export async function upsertFeedInteraction(
  db: Database,
  row: FeedInteractionTable,
) {
  await db
    .insertInto('feed_interaction')
    .values(row)
    .onConflict((oc) => oc.column('uri').doNothing())
    .execute()
}

export async function deleteFeedInteraction(db: Database, uri: string) {
  await db.deleteFrom('feed_interaction').where('uri', '=', uri).execute()
}

export async function deleteFeedDataForDid(db: Database, did: string) {
  await db.deleteFrom('feed_post').where('did', '=', did).execute()
  await db.deleteFrom('feed_interaction').where('did', '=', did).execute()
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

/** How far back the "popular" feed looks */
const POPULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Most posts the "popular" feed ranks */
const POPULAR_MAX_POSTS = 1000

/**
 * Score of a post for the "popular" feed: interactions decayed by age, so a
 * fresh post with a few likes can outrank an older one with more. A repost
 * counts double since it spreads the post further.
 */
export function popularScore(
  likes: number,
  reposts: number,
  ageMs: number,
): number {
  const hours = Math.max(ageMs, 0) / 3_600_000
  return (likes + 2 * reposts + 1) / Math.pow(hours + 2, 1.5)
}

/**
 * Posts of the last week ranked by {@link popularScore}. The ranking moves
 * as time passes, so the cursor is a plain offset into it.
 */
export async function getPopularPosts(
  db: Database,
  limit: number,
  cursor?: string,
  now = Date.now(),
) {
  const offset = cursor ? Number(cursor) : 0
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('Malformed cursor')
  }
  const since = new Date(now - POPULAR_WINDOW_MS).toISOString()
  const posts = await db
    .selectFrom('feed_post')
    .select(['uri', 'indexedAt', 'createdAt'])
    .where('indexedAt', '>=', since)
    .orderBy('indexedAt', 'desc')
    .limit(POPULAR_MAX_POSTS)
    .execute()
  if (!posts.length) return { posts: [], cursor: undefined }
  const counts = await db
    .selectFrom('feed_interaction')
    .select(['subject', 'kind', (eb) => eb.fn.countAll<number>().as('count')])
    .where(
      'subject',
      'in',
      posts.map((p) => p.uri),
    )
    .groupBy(['subject', 'kind'])
    .execute()
  const likes = new Map<string, number>()
  const reposts = new Map<string, number>()
  for (const row of counts) {
    const map = row.kind === 'like' ? likes : reposts
    map.set(row.subject, Number(row.count))
  }
  const ranked = posts
    .map((p) => ({ ...p, postedAt: postedAt(p) }))
    // Imported or backdated posts are as old as they claim
    .filter((p) => p.postedAt >= now - POPULAR_WINDOW_MS)
    .map((p) => ({
      uri: p.uri,
      score: popularScore(
        likes.get(p.uri) ?? 0,
        reposts.get(p.uri) ?? 0,
        now - p.postedAt,
      ),
    }))
    .sort((a, b) => b.score - a.score)
  const page = ranked.slice(offset, offset + limit)
  return {
    posts: page.map((p) => p.uri),
    cursor: offset + limit < ranked.length ? String(offset + limit) : undefined,
  }
}

/**
 * When a post counts as posted: the earlier of its own createdAt and when it
 * was indexed. A post can claim to be older than it is, which only hurts it,
 * but not newer, which would let it stay on top.
 */
function postedAt(post: { indexedAt: string; createdAt: string | null }) {
  const indexed = Date.parse(post.indexedAt)
  const created = post.createdAt ? Date.parse(post.createdAt) : NaN
  return isNaN(created) ? indexed : Math.min(created, indexed)
}
