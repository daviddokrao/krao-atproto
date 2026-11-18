import type { ServiceImpl } from '@connectrpc/connect'
import { sql } from 'kysely'
import type { Service } from '../../../proto/bsky_connect.js'
import type { Database } from '../db/index.js'
import {
  IndexedAtDidKeyset,
  TimeCidKeyset,
  paginate,
} from '../db/pagination.js'
import { parsePostSearchQuery } from '../util.js'

export default (db: Database): Partial<ServiceImpl<typeof Service>> => {
  const searchActorsImpl = async (req: {
    term: string
    limit: number
    cursor?: string
  }) => {
    const { term, limit, cursor } = req
    const { ref } = db.db.dynamic
    const words = searchWords(cleanQuery(term))
    if (isRankable(words)) return searchActorsRanked(db, words, limit, cursor)
    // Krao: no separate search service, so match display names too, ignoring case and accents
    const pattern = `%${escapeLike(cleanQuery(term))}%`
    let builder = db.db
      .selectFrom('actor')
      .leftJoin('profile', 'profile.creator', 'actor.did')
      .where((eb) =>
        eb.or([
          eb('actor.handle', 'ilike', pattern),
          unaccentedContains('profile.displayName', cleanQuery(term)),
        ]),
      )
      .selectAll('actor')

    const keyset = new IndexedAtDidKeyset(
      ref('actor.indexedAt'),
      ref('actor.did'),
    )
    builder = paginate(builder, {
      limit,
      cursor,
      keyset,
      tryIndex: true,
    })

    const page = keyset.page(await builder.execute(), limit)

    return {
      dids: page.items.map((row) => row.did),
      cursor: page.cursor,
    }
  }

  const searchPostsImpl = async (req: {
    term: string
    limit: number
    cursor?: string
  }) => {
    const { term, limit, cursor } = req
    const { q, author } = parsePostSearchQuery(term)

    let authorDid = author
    if (author && !author?.startsWith('did:')) {
      const res = await db.db
        .selectFrom('actor')
        .where('handle', '=', author)
        .selectAll()
        .executeTakeFirst()
      authorDid = res?.did
    }

    const words = searchWords(q)
    if (isRankable(words)) {
      return searchPostsRanked(db, words, authorDid, limit, cursor)
    }

    const { ref } = db.db.dynamic
    let builder = db.db.selectFrom('post').selectAll()
    // Krao: case- and accent-insensitive, since this is Krao's only post search
    for (const word of words) {
      builder = builder.where(unaccentedContains('post.text', word))
    }

    if (authorDid) {
      builder = builder.where('post.creator', '=', authorDid)
    }

    const keyset = new TimeCidKeyset(ref('post.sortAt'), ref('post.cid'))
    builder = paginate(builder, {
      limit,
      cursor,
      keyset,
      tryIndex: true,
    })

    const page = keyset.page(await builder.execute(), limit)
    return {
      uris: page.items.map((row) => row.uri),
      cursor: page.cursor,
    }
  }

  const searchStarterPacksImpl = async (req: {
    term: string
    limit: number
    cursor?: string
  }) => {
    const { term, limit, cursor } = req
    const { ref } = db.db.dynamic
    let builder = db.db
      .selectFrom('starter_pack')
      .where('starter_pack.name', 'ilike', `%${escapeLike(term)}%`)
      .selectAll()

    const keyset = new TimeCidKeyset(
      ref('starter_pack.sortAt'),
      ref('starter_pack.cid'),
    )

    builder = paginate(builder, {
      limit,
      cursor,
      keyset,
      tryIndex: true,
    })

    const page = keyset.page(await builder.execute(), limit)

    return {
      uris: page.items.map((row) => row.uri),
      cursor: page.cursor,
    }
  }

  return {
    // @TODO actor search endpoints still fall back to search service
    searchActors: searchActorsImpl,

    // @TODO post search endpoint still falls back to search service
    searchPosts: searchPostsImpl,

    searchStarterPacks: searchStarterPacksImpl,

    // V2 endpoints reuse the V1 SQL for dev env and reshape the response.
    async searchActorsV2(req) {
      const { dids, cursor } = await searchActorsImpl({
        term: req.params?.query ?? '',
        limit: req.params?.limit ?? 25,
        cursor: req.params?.cursor,
      })
      return {
        actors: dids.map((did) => ({ did, score: 0 })),
        pageInfo: { cursor: cursor ?? '', hitsTotal: 0n },
      }
    },

    async searchActorsTypeahead(req) {
      const { dids } = await searchActorsImpl({
        term: req.params?.query ?? '',
        limit: req.params?.limit || 10,
      })
      return {
        actors: dids.map((did) => ({ did, score: 0 })),
      }
    },

    async searchPostsV2(req) {
      const author = req.filters?.authors?.[0]
      const baseQuery = req.params?.query ?? ''
      const term = author ? `${baseQuery} from:${author}` : baseQuery
      const { uris, cursor } = await searchPostsImpl({
        term,
        limit: req.params?.limit ?? 25,
        cursor: req.params?.cursor,
      })
      return {
        posts: uris.map((uri) => ({ uri, score: 0 })),
        pageInfo: { cursor: cursor ?? '', hitsTotal: 0n },
        detectedQueryLanguages: [],
      }
    },

    async searchStarterPacksV2(req) {
      const { uris, cursor } = await searchStarterPacksImpl({
        term: req.params?.query ?? '',
        limit: req.params?.limit ?? 25,
        cursor: req.params?.cursor,
      })
      return {
        starterPacks: uris.map((uri) => ({ uri, score: 0 })),
        pageInfo: { cursor: cursor ?? '', hitsTotal: 0n },
      }
    },
  }
}

// Remove leading @ in case a handle is input that way
const cleanQuery = (query: string) => query.trim().replace(/^@/g, '')

/** Makes `%`, `_` and `\` in a search term match themselves (Postgres LIKE escapes with `\`) */
const escapeLike = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`)

/*
 * Krao: accent-insensitive search (see the 20261016 migration). Each word of
 * the query must appear in f_unaccent(text), matched through the trigram
 * index on that expression, so "tien ao" finds "tiền ảo". Results are ranked
 * by how well the whole query matches, plus recency for posts, and paged by
 * offset (the cursor is the number of results already returned).
 */

/** Most words taken from a query, and most results paged through */
const MAX_SEARCH_WORDS = 8
const MAX_SEARCH_OFFSET = 10_000

/** The words of a search query, without quotes */
const searchWords = (q: string) =>
  q
    .replace(/"/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_WORDS)
    .map((w) => w.slice(0, 100))

const parseOffset = (cursor?: string) => {
  const n = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0
  return Math.min(n, MAX_SEARCH_OFFSET)
}

/** The cursor of the next page; none past the offset cap, or it would repeat the last page */
const nextCursor = (rows: unknown[], offset: number, limit: number) =>
  rows.length > limit && offset + limit <= MAX_SEARCH_OFFSET
    ? String(offset + limit)
    : undefined

/*
 * A word shorter than a trigram cannot use the trigram indexes, so a query
 * made only of such words ("a", "đi") would rank every post or actor. Those
 * are matched newest first instead, which stops at the first page.
 */
const MIN_RANKED_WORD = 3
const isRankable = (words: string[]) =>
  words.some((w) => w.length >= MIN_RANKED_WORD)

const contains = (term: string) => `%${escapeLike(term)}%`

/** `column` holds `term`, ignoring case and accents (uses the f_unaccent indexes) */
const unaccentedContains = (column: string, term: string) =>
  sql<boolean>`f_unaccent(${sql.ref(column)}) ilike f_unaccent(${contains(term)})`

async function searchPostsRanked(
  db: Database,
  words: string[],
  authorDid: string | undefined,
  limit: number,
  cursor?: string,
) {
  const offset = parseOffset(cursor)
  const phrase = words.join(' ')
  const text = sql.ref('post.text')
  let builder = db.db.selectFrom('post').select('post.uri')
  for (const word of words) {
    builder = builder.where(unaccentedContains('post.text', word))
  }
  if (authorDid) builder = builder.where('post.creator', '=', authorDid)
  // Trigram match of the whole query, then bonuses for the words in order,
  // as one phrase, and as typed (accents included), then recency (halved
  // after two days). word_similarity alone ignores the order of words.
  const inOrder = `%${words.map(escapeLike).join('%')}%`
  const rows = await builder
    .orderBy(
      sql`word_similarity(f_unaccent(${phrase}), f_unaccent(${text}))
        + case when f_unaccent(${text}) ilike f_unaccent(${inOrder}) then 0.2 else 0 end
        + case when f_unaccent(${text}) ilike f_unaccent(${contains(phrase)}) then 0.3 else 0 end
        + case when ${text} ilike ${contains(phrase)} then 0.2 else 0 end
        + 0.5 / (1 + greatest(0, extract(epoch from now() - ${sql.ref('post.sortAt')}::timestamptz)) / 172800)`,
      'desc',
    )
    .orderBy('post.sortAt', 'desc')
    .orderBy('post.cid', 'desc')
    .offset(offset)
    .limit(limit + 1)
    .execute()
  return {
    uris: rows.slice(0, limit).map((row) => row.uri),
    cursor: nextCursor(rows, offset, limit),
  }
}

async function searchActorsRanked(
  db: Database,
  words: string[],
  limit: number,
  cursor?: string,
) {
  const offset = parseOffset(cursor)
  const phrase = words.join(' ')
  const nameMatches = sql.join(
    words.map((word) => unaccentedContains('p.displayName', word)),
    sql` and `,
  )
  const rows = await db.db
    .selectFrom('actor')
    .leftJoin('profile', 'profile.creator', 'actor.did')
    .select('actor.did')
    .where(
      'actor.did',
      'in',
      sql<string>`(select a.did from actor a where a.handle ilike ${contains(phrase)}
        union select p.creator from profile p where ${nameMatches})`,
    )
    .orderBy(
      sql`greatest(
          similarity(${sql.ref('actor.handle')}, ${phrase}),
          word_similarity(f_unaccent(${phrase}), f_unaccent(${sql.ref('profile.displayName')}))
        )
        + case when ${sql.ref('actor.handle')} ilike ${`${escapeLike(phrase)}%`} then 0.5 else 0 end
        + case when f_unaccent(${sql.ref('profile.displayName')}) ilike f_unaccent(${`${escapeLike(phrase)}%`}) then 0.3 else 0 end`,
      'desc',
    )
    .orderBy('actor.did')
    .offset(offset)
    .limit(limit + 1)
    .execute()
  return {
    dids: rows.slice(0, limit).map((row) => row.did),
    cursor: nextCursor(rows, offset, limit),
  }
}
