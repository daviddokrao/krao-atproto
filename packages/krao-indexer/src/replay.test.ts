import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdResolver } from '@atproto/identity'
import { type Database, createDb, migrateDb } from './db.js'
import { FirehoseIndexer } from './indexer.js'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const WALLET = 'net.krao.actor.wallet'
const CID = 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'

/**
 * The PDS the indexer follows, answering the two reads a replay makes:
 * alice's wallet record exists, bob's is gone, bob is taken down, and
 * `fail` records make the PDS error.
 */
function fakePds() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const rkey = url.searchParams.get('rkey')
      if (url.searchParams.get('repo') === ALICE && rkey === 'w1') {
        return json(200, {
          uri: `at://${ALICE}/${WALLET}/w1`,
          cid: CID,
          value: {
            $type: WALLET,
            account: 'eip155:8453:0x0000000000000000000000000000000000000001',
            createdAt: '2026-10-16T00:00:00.000Z',
          },
        })
      }
      if (rkey === 'fail') return json(500, { error: 'InternalServerError' })
      return json(400, { error: 'RecordNotFound', message: 'not found' })
    }
    if (url.pathname === '/xrpc/com.atproto.sync.getRepoStatus') {
      return json(200, {
        did: url.searchParams.get('did'),
        active: false,
        status: 'takendown',
      })
    }
    json(404, { error: 'NotFound' })
  })
  return server
}

describe('replayFailedEvents', () => {
  let db: Database
  let pds: http.Server
  let indexer: FirehoseIndexer

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    pds = fakePds().listen(0)
    await once(pds, 'listening')
    const { port } = pds.address() as AddressInfo
    indexer = new FirehoseIndexer(
      db,
      new Map(),
      new IdResolver({ plcUrl: 'http://127.0.0.1:9' }),
      `ws://127.0.0.1:${port}`,
      () => {},
    )
  })

  afterEach(async () => {
    pds.close()
    await db.destroy()
  })

  const failed = (rows: { did: string; event: string; uri?: string }[]) =>
    db
      .insertInto('failed_event')
      .values(
        rows.map((r, i) => ({
          seq: 10 + i,
          did: r.did,
          event: r.event,
          uri: r.uri ?? null,
          error: 'RPC down',
          failedAt: '2026-10-16T00:00:00.000Z',
        })),
      )
      .execute()

  it('indexes failed events from the current state of the PDS', async () => {
    // bob's old link is indexed; its record has been deleted since
    await db
      .insertInto('wallet')
      .values({
        uri: `at://${BOB}/${WALLET}/old`,
        did: BOB,
        account: 'eip155:8453:0x0000000000000000000000000000000000000002',
        accountRaw: 'eip155:8453:0x0000000000000000000000000000000000000002',
        evmAddress: '0x0000000000000000000000000000000000000002',
        label: null,
        status: 'verified',
        reason: null,
        createdAt: '2026-10-15T00:00:00.000Z',
        indexedAt: '2026-10-15T00:00:00.000Z',
      })
      .execute()
    await failed([
      { did: ALICE, event: 'create', uri: `at://${ALICE}/${WALLET}/w1` },
      { did: BOB, event: 'update', uri: `at://${BOB}/${WALLET}/old` },
      { did: BOB, event: 'account' },
      { did: ALICE, event: 'create', uri: `at://${ALICE}/${WALLET}/fail` },
    ])

    expect(await indexer.replayFailedEvents()).toEqual({
      replayed: 3,
      failed: 1,
      remaining: 1,
    })
    const wallets = await db.selectFrom('wallet').selectAll().execute()
    // alice's record is indexed (its proof is missing, so it is invalid)
    expect(wallets.map((w) => [w.uri, w.status])).toEqual([
      [`at://${ALICE}/${WALLET}/w1`, 'invalid'],
    ])
    const hidden = await db.selectFrom('hidden_actor').selectAll().execute()
    expect(hidden.map((h) => [h.did, h.status])).toEqual([[BOB, 'takendown']])
    const left = await db.selectFrom('failed_event').selectAll().execute()
    expect(left).toHaveLength(1)
    expect(left[0].uri).toBe(`at://${ALICE}/${WALLET}/fail`)
    expect(left[0].error).toMatch(/HTTP 500/)
  })

  it('replays at most `limit` events, oldest first', async () => {
    await failed([
      { did: ALICE, event: 'create', uri: `at://${ALICE}/${WALLET}/w1` },
      { did: BOB, event: 'account' },
    ])
    expect(await indexer.replayFailedEvents(1)).toEqual({
      replayed: 1,
      failed: 0,
      remaining: 1,
    })
    const left = await db.selectFrom('failed_event').selectAll().execute()
    expect(left.map((r) => r.event)).toEqual(['account'])
  })
})
