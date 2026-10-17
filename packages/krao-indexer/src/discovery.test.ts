import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  feedFollowRowFromRecord,
  postTags,
  setPostTags,
  suggestedAccounts,
  suggestedStarterPacks,
  trendingTags,
  upsertFeedFollow,
  upsertStarterPack,
} from './discovery.js'

describe('postTags', () => {
  it('reads tag facets and the tags field, lowercased and deduplicated', () => {
    expect(
      postTags({
        text: '#DeFi on #Base',
        facets: [
          { features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'DeFi' }] },
          { features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'Base' }] },
          { features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'x' }] },
        ],
        tags: ['#defi', 'web3'],
      }).sort(),
    ).toEqual(['base', 'defi', 'web3'])
  })

  it('counts at most ten tags of a post', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `t${i}`)
    expect(postTags({ tags })).toHaveLength(10)
  })

  it('ignores records without tags', () => {
    expect(postTags({ text: 'hi' })).toEqual([])
    expect(postTags(null)).toEqual([])
  })
})

describe('feedFollowRowFromRecord', () => {
  it('needs a DID subject', () => {
    expect(
      feedFollowRowFromRecord('at://a/f/1', 'did:a', { subject: 'bob' }),
    ).toBeNull()
    expect(
      feedFollowRowFromRecord('at://a/f/1', 'did:a', { subject: 'did:b' })
        ?.subject,
    ).toBe('did:b')
  })
})

describe('with a database', () => {
  let db: Database

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const follow = (did: string, subject: string) => {
    const row = feedFollowRowFromRecord(`at://${did}/f/${subject}`, did, {
      subject,
    })
    if (!row) throw new Error('no row')
    return upsertFeedFollow(db, row)
  }
  const posted = (did: string) =>
    db
      .insertInto('feed_post')
      .values({
        uri: `at://${did}/p/1`,
        cid: 'cid',
        did,
        indexedAt: new Date().toISOString(),
        createdAt: null,
        vi: 0,
      })
      .execute()

  it('suggests popular accounts, never the viewer or who they follow', async () => {
    for (const did of ['did:a', 'did:b', 'did:c', 'did:d']) await posted(did)
    await follow('did:b', 'did:c')
    await follow('did:d', 'did:c')
    await follow('did:a', 'did:b')

    const dids = await suggestedAccounts(db, { viewer: 'did:a', limit: 10 })
    expect(dids[0]).toBe('did:c')
    expect(dids).not.toContain('did:a')
    expect(dids).not.toContain('did:b')
  })

  it('puts friends of friends first when relative to an account', async () => {
    for (const did of ['did:a', 'did:b', 'did:c', 'did:d', 'did:e']) {
      await posted(did)
    }
    // did:e is the most followed, but did:a's friend did:b follows did:d
    await follow('did:c', 'did:e')
    await follow('did:d', 'did:e')
    await follow('did:a', 'did:b')
    await follow('did:b', 'did:d')

    const dids = await suggestedAccounts(db, {
      viewer: 'did:a',
      relativeTo: 'did:a',
      limit: 10,
    })
    expect(dids[0]).toBe('did:d')
  })

  it("suggests starter packs, not the viewer's own or of people they follow", async () => {
    await upsertStarterPack(db, 'at://did:b/sp/1', 'did:b')
    await upsertStarterPack(db, 'at://did:c/sp/1', 'did:c')
    await upsertStarterPack(db, 'at://did:a/sp/1', 'did:a')
    await follow('did:a', 'did:b')
    expect(
      await suggestedStarterPacks(db, { viewer: 'did:a', limit: 10 }),
    ).toEqual(['at://did:c/sp/1'])
    expect(await suggestedStarterPacks(db, { limit: 10 })).toHaveLength(3)
  })

  it('ranks hashtags by the posts using them this week', async () => {
    await setPostTags(db, 'at://a/p/1', 'did:a', ['web3', 'defi'])
    await setPostTags(db, 'at://b/p/1', 'did:b', ['web3'])
    await setPostTags(db, 'at://c/p/1', 'did:c', ['nft'])
    // Re-tagging a post replaces its tags rather than adding to them
    await setPostTags(db, 'at://c/p/1', 'did:c', ['web3'])

    const tags = await trendingTags(db, 10)
    expect(tags.map((t) => [t.tag, t.postCount])).toEqual([
      ['web3', 3],
      ['defi', 1],
    ])
    expect(tags[0].dids.sort()).toEqual(['did:a', 'did:b', 'did:c'])
  })
})
