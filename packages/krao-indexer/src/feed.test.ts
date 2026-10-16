import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  feedInteractionRowFromRecord,
  feedPostRowFromRecord,
  getLatestPosts,
  getPopularPosts,
  popularScore,
  upsertFeedInteraction,
  upsertFeedPost,
} from './feed.js'

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-14T12:00:00Z')

describe('popularScore', () => {
  it('ranks more interactions higher at the same age', () => {
    expect(popularScore(5, 0, HOUR)).toBeGreaterThan(popularScore(1, 0, HOUR))
  })

  it('counts a repost as two likes', () => {
    expect(popularScore(0, 1, HOUR)).toBe(popularScore(2, 0, HOUR))
  })

  it('decays with age', () => {
    expect(popularScore(3, 0, HOUR)).toBeGreaterThan(
      popularScore(3, 0, 24 * HOUR),
    )
  })
})

describe('feedPostRowFromRecord', () => {
  it('leaves replies out', () => {
    expect(
      feedPostRowFromRecord('at://a/p/1', 'cid', 'did:a', {
        text: 'hi',
        reply: {},
      }),
    ).toBeNull()
  })

  it('keeps a valid createdAt and drops an invalid one', () => {
    const row = feedPostRowFromRecord('at://a/p/1', 'cid', 'did:a', {
      createdAt: '2026-10-01T00:00:00Z',
    })
    expect(row?.createdAt).toBe('2026-10-01T00:00:00.000Z')
    const bad = feedPostRowFromRecord('at://a/p/1', 'cid', 'did:a', {
      createdAt: 'yesterday',
    })
    expect(bad?.createdAt).toBeNull()
  })
})

describe('getPopularPosts', () => {
  let db: Database

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const post = async (uri: string, hoursAgo: number, createdAt?: string) => {
    const at = new Date(NOW - hoursAgo * HOUR).toISOString()
    await db
      .insertInto('feed_post')
      .values({
        uri,
        cid: uri,
        did: 'did:a',
        indexedAt: at,
        createdAt: createdAt ?? at,
        vi: 0,
      })
      .execute()
  }
  const like = (uri: string, subject: string) => {
    const row = feedInteractionRowFromRecord(
      uri,
      'did:b',
      'app.bsky.feed.like',
      { subject: { uri: subject } },
    )
    if (!row) throw new Error('no row')
    return upsertFeedInteraction(db, row)
  }

  it('ranks a liked post above a newer plain one, and pages by offset', async () => {
    await post('at://a/p/liked', 2)
    await post('at://a/p/plain', 1)
    await like('at://b/l/1', 'at://a/p/liked')
    await like('at://b/l/2', 'at://a/p/liked')

    const first = await getPopularPosts(db, 1, undefined, NOW)
    expect(first.posts).toEqual(['at://a/p/liked'])
    expect(first.cursor).toBe('1')
    const second = await getPopularPosts(db, 1, first.cursor, NOW)
    expect(second.posts).toEqual(['at://a/p/plain'])
    expect(second.cursor).toBeUndefined()
  })

  it('leaves out posts older than a week, even when backdated on import', async () => {
    await post('at://a/p/old', 8 * 24)
    await post('at://a/p/backdated', 1, '2022-07-15T00:00:00Z')
    await post('at://a/p/fresh', 1)
    const { posts } = await getPopularPosts(db, 10, undefined, NOW)
    expect(posts).toEqual(['at://a/p/fresh'])
  })

  it('refuses a malformed cursor', async () => {
    await expect(getPopularPosts(db, 10, 'abc', NOW)).rejects.toThrow()
  })
})

describe('the "Tiếng Việt" feed', () => {
  let db: Database

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const index = async (uri: string, did: string, record: unknown) => {
    const row = feedPostRowFromRecord(uri, uri, did, record)
    if (row) await upsertFeedPost(db, row)
  }

  it('lists Vietnamese posts only, newest first, without unsafe links or hidden accounts', async () => {
    await index('at://a/p/1', 'did:a', { text: 'Chúc mừng năm mới!' })
    await index('at://a/p/2', 'did:a', { text: 'Happy new year!' })
    await index('at://a/p/3', 'did:a', { text: 'gm', langs: ['vi'] })
    await index('at://a/p/4', 'did:a', { text: 'Nhận quà miễn phí tại đây' })
    await index('at://b/p/5', 'did:b', { text: 'Bài của tài khoản bị khoá' })
    await db
      .insertInto('unsafe_post')
      .values({
        uri: 'at://a/p/4',
        did: 'did:a',
        domain: 'drainer.test',
        flaggedAt: new Date().toISOString(),
      })
      .execute()
    await db
      .insertInto('hidden_actor')
      .values({ did: 'did:b', status: 'takendown', since: '2026-10-16' })
      .execute()
    const page = await getLatestPosts(db, 10, undefined, { vietnamese: true })
    expect(page.posts.sort()).toEqual(['at://a/p/1', 'at://a/p/3'])
    // The latest feed is unchanged
    const latest = await getLatestPosts(db, 10)
    expect(latest.posts).toHaveLength(4)
  })

  it('follows an edit that changes the language', async () => {
    await index('at://a/p/1', 'did:a', { text: 'Hello', langs: ['vi'] })
    await index('at://a/p/1', 'did:a', { text: 'Hello', langs: ['en'] })
    const page = await getLatestPosts(db, 10, undefined, { vietnamese: true })
    expect(page.posts).toEqual([])
  })
})
