import { sql } from 'kysely'
import type { Database, FeedFollowTable, FeedTagTable } from './db.js'

export const FOLLOW_COLLECTION = 'app.bsky.graph.follow'
export const STARTER_PACK_COLLECTION = 'app.bsky.graph.starterpack'

/** Most hashtags of one post that count towards trending */
const MAX_TAGS_PER_POST = 10

/** How far back trending hashtags look */
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/*
 * Discovery for Krao's own network. The AppView asks "suggestion" and
 * "topics" services for skeletons (lists of DIDs, feeds, topics) and hydrates
 * them itself; Bluesky runs those services, Krao answers from the follows and
 * hashtags of Krao accounts that the indexer sees on the firehose.
 */

/** A follow by a Krao account, or null when the record names no account */
export function feedFollowRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): FeedFollowTable | null {
  const subject = (record as { subject?: unknown } | null)?.subject
  if (typeof subject !== 'string' || !subject.startsWith('did:')) return null
  return { uri, did, subject, indexedAt: new Date().toISOString() }
}

export async function upsertFeedFollow(db: Database, row: FeedFollowTable) {
  await db
    .insertInto('feed_follow')
    .values(row)
    .onConflict((oc) => oc.column('uri').doNothing())
    .execute()
}

export async function deleteFeedFollow(db: Database, uri: string) {
  await db.deleteFrom('feed_follow').where('uri', '=', uri).execute()
}

/**
 * Hashtags of a post: tag facets in the text plus the record's `tags`,
 * lowercased and without the leading #.
 */
export function postTags(record: unknown): string[] {
  const value = (record ?? {}) as {
    facets?: { features?: { $type?: string; tag?: unknown }[] }[]
    tags?: unknown[]
  }
  const tags = new Set<string>()
  for (const facet of value.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (
        feature.$type === 'app.bsky.richtext.facet#tag' &&
        typeof feature.tag === 'string'
      ) {
        tags.add(feature.tag)
      }
    }
  }
  for (const tag of value.tags ?? []) {
    if (typeof tag === 'string') tags.add(tag)
  }
  // Normalize before deduplicating: #DeFi and defi are the same tag
  const normalized = [...tags]
    .map((tag) => tag.replace(/^#/, '').trim().toLowerCase())
    .filter((tag) => tag.length > 0 && tag.length <= 64)
  // A post can carry thousands of tag facets; trending only needs a few
  return [...new Set(normalized)].slice(0, MAX_TAGS_PER_POST)
}

export async function setPostTags(
  db: Database,
  uri: string,
  did: string,
  tags: string[],
) {
  await db.deleteFrom('feed_tag').where('uri', '=', uri).execute()
  if (!tags.length) return
  const indexedAt = new Date().toISOString()
  const rows: FeedTagTable[] = tags.map((tag) => ({ uri, did, tag, indexedAt }))
  await db.insertInto('feed_tag').values(rows).execute()
}

export async function deletePostTags(db: Database, uri: string) {
  await db.deleteFrom('feed_tag').where('uri', '=', uri).execute()
}

export async function upsertStarterPack(
  db: Database,
  uri: string,
  did: string,
) {
  await db
    .insertInto('feed_starter_pack')
    .values({ uri, did, indexedAt: new Date().toISOString() })
    .onConflict((oc) => oc.column('uri').doNothing())
    .execute()
}

export async function deleteStarterPack(db: Database, uri: string) {
  await db.deleteFrom('feed_starter_pack').where('uri', '=', uri).execute()
}

/**
 * Starter packs to suggest, newest first, leaving out the viewer's own and
 * those of accounts they already follow (they joined through those already
 * or don't need them).
 */
export async function suggestedStarterPacks(
  db: Database,
  opts: { viewer?: string; limit: number },
): Promise<string[]> {
  let qb = db
    .selectFrom('feed_starter_pack')
    .select('uri')
    .orderBy('indexedAt', 'desc')
    .limit(opts.limit)
  if (opts.viewer) {
    const viewer = opts.viewer
    qb = qb
      .where('did', '!=', viewer)
      .where('did', 'not in', (eb) =>
        eb
          .selectFrom('feed_follow')
          .select('subject')
          .where('feed_follow.did', '=', viewer),
      )
  }
  return (await qb.execute()).map((r) => r.uri)
}

export async function deleteDiscoveryDataForDid(db: Database, did: string) {
  await db.deleteFrom('feed_starter_pack').where('did', '=', did).execute()
  await db.deleteFrom('feed_follow').where('did', '=', did).execute()
  await db.deleteFrom('feed_follow').where('subject', '=', did).execute()
  await db.deleteFrom('feed_tag').where('did', '=', did).execute()
}

/**
 * Krao accounts worth following, best first: those followed by the people
 * `relativeTo` follows, then the most followed and most active. Leaves out the
 * viewer and accounts they already follow.
 */
export async function suggestedAccounts(
  db: Database,
  opts: { viewer?: string; relativeTo?: string; limit: number },
): Promise<string[]> {
  const { viewer, relativeTo, limit } = opts
  const exclude = new Set<string>()
  if (viewer) {
    exclude.add(viewer)
    const follows = await db
      .selectFrom('feed_follow')
      .select('subject')
      .where('did', '=', viewer)
      .execute()
    for (const f of follows) exclude.add(f.subject)
  }
  if (relativeTo) exclude.add(relativeTo)

  const score = new Map<string, number>()
  const bump = (did: string, points: number) =>
    score.set(did, (score.get(did) ?? 0) + points)

  // Every account the indexer knows as a Krao poster or follower
  const known = await db
    .selectFrom('feed_post')
    .select('did')
    .distinct()
    .union(db.selectFrom('feed_follow').select('did').distinct())
    .execute()
  for (const { did } of known) bump(did, 0)

  const followers = await db
    .selectFrom('feed_follow')
    .select(['subject', (eb) => eb.fn.countAll<number>().as('count')])
    .groupBy('subject')
    .execute()
  const knownDids = new Set(known.map((k) => k.did))
  for (const row of followers) {
    if (knownDids.has(row.subject)) bump(row.subject, Number(row.count))
  }

  const posts = await db
    .selectFrom('feed_post')
    .select(['did', (eb) => eb.fn.countAll<number>().as('count')])
    .where(
      'indexedAt',
      '>=',
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    )
    .groupBy('did')
    .execute()
  for (const row of posts) bump(row.did, Math.min(Number(row.count), 20) / 10)

  if (relativeTo) {
    // Followed by the accounts relativeTo follows ("friends of friends")
    const fof = await db
      .selectFrom('feed_follow as a')
      .innerJoin('feed_follow as b', 'b.did', 'a.subject')
      .select(['b.subject', (eb) => eb.fn.countAll<number>().as('count')])
      .where('a.did', '=', relativeTo)
      .groupBy('b.subject')
      .execute()
    for (const row of fof) {
      if (knownDids.has(row.subject)) bump(row.subject, 100 * Number(row.count))
    }
  }

  return [...score.entries()]
    .filter(([did]) => !exclude.has(did))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([did]) => did)
}

export type TrendingTag = {
  tag: string
  postCount: number
  startedAt: string
  dids: string[]
}

/** Hashtags used in the most posts this week, most used first */
export async function trendingTags(
  db: Database,
  limit: number,
  now = Date.now(),
): Promise<TrendingTag[]> {
  const since = new Date(now - TRENDING_WINDOW_MS).toISOString()
  const rows = await db
    .selectFrom('feed_tag')
    .select([
      'tag',
      sql<number>`count(distinct uri)`.as('postCount'),
      sql<string>`min(indexedAt)`.as('startedAt'),
      sql<string>`max(indexedAt)`.as('lastAt'),
      sql<string>`group_concat(distinct did)`.as('dids'),
    ])
    .where('indexedAt', '>=', since)
    .groupBy('tag')
    .orderBy('postCount', 'desc')
    .orderBy('lastAt', 'desc')
    .limit(limit)
    .execute()
  return rows.map((row) => ({
    tag: row.tag,
    postCount: Number(row.postCount),
    startedAt: row.startedAt,
    dids: row.dids ? row.dids.split(',').slice(0, 5) : [],
  }))
}
