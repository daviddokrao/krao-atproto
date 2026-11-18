import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdResolver } from '@atproto/identity'
import type { Event } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import { type Database, createDb, migrateDb } from './db.js'
import { FirehoseIndexer } from './indexer.js'
import type { OutboxEvent } from './rewards-events.js'

const OWNER = 'did:plc:owner'
const DIDS = ['did:plc:a', 'did:plc:b', 'did:plc:c', 'did:plc:d']
const CID_STR = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

/*
 * The rewards events the indexer queues (M33): a day of activity for any
 * record an account creates, and a first community joined
 */
describe('indexer rewards events', () => {
  let db: Database
  let indexer: FirehoseIndexer
  let sent: string[]
  let seq = 0

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    indexer = new FirehoseIndexer(
      db,
      new Map(),
      new IdResolver({ plcUrl: 'http://127.0.0.1:9' }),
      'ws://127.0.0.1:9',
      () => {},
    )
    sent = []
    indexer.rewardsEvents = {
      send: async (type: OutboxEvent, did: string, day?: string) => {
        sent.push(day ? `${type} ${did} ${day}` : `${type} ${did}`)
      },
    }
  })

  afterEach(async () => {
    await indexer.verificationIdle()
    await db.destroy()
  })

  const create = (
    did: string,
    collection: string,
    record: Record<string, unknown>,
    time = new Date().toISOString(),
  ) => {
    const rkey = `3k${String(++seq).padStart(11, 'a')}`
    return indexer.handleEvent({
      seq,
      time,
      event: 'create',
      did,
      collection,
      rkey,
      uri: new AtUri(`at://${did}/${collection}/${rkey}`),
      cid: { toString: () => CID_STR },
      record: { $type: collection, ...record },
    } as unknown as Event)
  }

  const outbox = async () =>
    (
      await db
        .selectFrom('rewards_outbox')
        .select(['type', 'did', 'day'])
        .orderBy('id')
        .execute()
    ).map((r) => (r.day ? `${r.type} ${r.did} ${r.day}` : `${r.type} ${r.did}`))

  it('queues a day of activity per account and Vietnam day', async () => {
    const like = {
      subject: { uri: 'at://x/app.bsky.feed.post/1', cid: CID_STR },
    }
    await create(DIDS[0], 'app.bsky.feed.like', like, '2026-10-16T10:00:00Z')
    await create(DIDS[0], 'app.bsky.feed.like', like, '2026-10-16T16:00:00Z')
    // 00:30 on the 17th in Vietnam
    await create(DIDS[0], 'app.bsky.feed.like', like, '2026-10-16T17:30:00Z')
    await create(
      DIDS[1],
      'app.bsky.graph.follow',
      { subject: DIDS[0], createdAt: new Date().toISOString() },
      '2026-10-16T10:00:00Z',
    )
    expect(await outbox()).toEqual([
      `activity.day ${DIDS[0]} 2026-10-16`,
      `activity.day ${DIDS[0]} 2026-10-17`,
      `activity.day ${DIDS[1]} 2026-10-16`,
    ])
    await indexer.deliverRewardsEvents()
    expect(sent).toContain(`activity.day ${DIDS[0]} 2026-10-17`)
  })

  it('queues community.joined for a community with 3 other members, once', async () => {
    const createdAt = new Date().toISOString()
    await create(OWNER, 'net.krao.community.profile', {
      name: 'Krao VN',
      access: { mode: 'open' },
      createdAt,
    })
    const community = (
      await db.selectFrom('community').select('uri').executeTakeFirstOrThrow()
    ).uri
    const join = (did: string, subject: string) =>
      create(did, 'net.krao.community.membership', { subject, createdAt })
    for (const did of DIDS) await join(did, community)
    // A second community, as big: no second event
    await create(OWNER, 'net.krao.community.profile', {
      name: 'Krao EN',
      access: { mode: 'open' },
      createdAt,
    })
    const second = (
      await db
        .selectFrom('community')
        .select('uri')
        .where('uri', '!=', community)
        .executeTakeFirstOrThrow()
    ).uri
    for (const did of [DIDS[0], DIDS[1], DIDS[3], DIDS[2]]) {
      await join(did, second)
    }
    const joined = (await outbox()).filter((e) =>
      e.startsWith('community.joined'),
    )
    // The owner + 2 others when the third joined: only the third and fourth
    expect(joined).toEqual([
      `community.joined ${DIDS[2]}`,
      `community.joined ${DIDS[3]}`,
    ])
  })

  it('queues nothing without a rewards service', async () => {
    indexer.rewardsEvents = undefined
    await create(DIDS[0], 'app.bsky.feed.like', {
      subject: { uri: 'at://x/app.bsky.feed.post/1', cid: CID_STR },
    })
    expect(await outbox()).toEqual([])
  })
})
