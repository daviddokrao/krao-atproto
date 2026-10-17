import { once } from 'node:events'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client, addSignature, atprotoOp, updateHandleOp } from '@did-plc/lib'
import * as plcServer from '@did-plc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import { type Database, createDb, migrateDb } from './db.js'
import { enableMockExport } from './dev.js'
import { PlcMirror } from './mirror.js'
import { createApp } from './server.js'
import { opCid, validateNextOp } from './validate.js'

describe('PLC mirror', () => {
  let source: plcServer.PlcServer
  let sourceUrl: string
  let db: Database
  let mirror: PlcMirror
  let server: http.Server
  let mirrorUrl: string
  let key: Secp256k1Keypair

  beforeEach(async () => {
    const plcDb = plcServer.Database.mock()
    enableMockExport(plcDb)
    source = plcServer.PlcServer.create({ db: plcDb, port: 0 })
    const listening = await source.start()
    sourceUrl = `http://localhost:${(listening.address() as AddressInfo).port}`
    db = createDb(':memory:')
    await migrateDb(db)
    mirror = new PlcMirror(db, { source: sourceUrl, pollMs: 50 })
    server = createApp(mirror).listen(0)
    await once(server, 'listening')
    mirrorUrl = `http://localhost:${(server.address() as AddressInfo).port}`
    key = await Secp256k1Keypair.create()
  })

  afterEach(async () => {
    await mirror.stop()
    server.close()
    await source.destroy()
    await db.destroy()
  })

  const createDid = (client: Client, handle: string, signer = key) =>
    client.createDid({
      signingKey: signer.did(),
      rotationKeys: [signer.did()],
      handle,
      pds: 'https://pds.krao.test',
      signer,
    })

  const get = async (base: string, path: string) => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  it('copies the source through its export, op by op', async () => {
    const plc = new Client(sourceUrl)
    const alice = await createDid(plc, 'alice.krao.test')
    const bob = await createDid(plc, 'bob.krao.test')
    await plc.updateHandle(alice, key, 'alice2.krao.test')
    expect(await mirror.pollOnce()).toBe(false)
    for (const did of [alice, bob]) {
      for (const path of ['', '/data', '/log', '/log/last']) {
        const mine = await get(mirrorUrl, `/${did}${path}`)
        expect(mine.status).toBe(200)
        expect(mine.body).toEqual((await get(sourceUrl, `/${did}${path}`)).body)
      }
      const audit = await get(mirrorUrl, `/${did}/log/audit`)
      const theirs = await get(sourceUrl, `/${did}/log/audit`)
      expect(audit.body.map((o: any) => o.cid)).toEqual(
        theirs.body.map((o: any) => o.cid),
      )
    }
    expect((await get(mirrorUrl, `/${alice}`)).body.alsoKnownAs).toEqual([
      'at://alice2.krao.test',
    ])
    // Nothing new: the next poll takes nothing twice
    await mirror.pollOnce()
    const health = await get(mirrorUrl, '/_health')
    expect(health.body).toMatchObject({ ok: true, ops: 3, rejected: 0 })
    expect(health.body.lagSeconds).toBeLessThan(5)
  })

  it('keeps following from its cursor', async () => {
    const plc = new Client(sourceUrl)
    mirror.start()
    const did = await createDid(plc, 'later.krao.test')
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if ((await mirror.ops(did)).length) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect((await mirror.ops(did)).length).toBe(1)
    expect(await mirror.getState('cursor')).toMatch(/^\d{4}-/)
  })

  it('passes writes to the source and serves them right away', async () => {
    const viaMirror = new Client(mirrorUrl)
    const did = await createDid(viaMirror, 'carol.krao.test')
    await viaMirror.updateHandle(did, key, 'carol2.krao.test')
    // The source has it, and the mirror without polling
    expect((await get(sourceUrl, `/${did}`)).body.alsoKnownAs).toEqual([
      'at://carol2.krao.test',
    ])
    expect((await mirror.ops(did)).length).toBe(2)
    // A write the source refuses is refused here too, and not taken
    const other = await Secp256k1Keypair.create()
    const last = await viaMirror.getLastOp(did)
    const forged = await updateHandleOp(last as never, other, 'evil.krao.test')
    const res = await fetch(`${mirrorUrl}/${did}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(forged),
    })
    expect(res.status).toBe(400)
    expect((await mirror.ops(did)).length).toBe(2)
  })

  it('asks the source for a DID it does not have yet', async () => {
    const did = await createDid(new Client(sourceUrl), 'dave.krao.test')
    const doc = await get(mirrorUrl, `/${did}`)
    expect(doc.status).toBe(200)
    expect(doc.body.id).toBe(did)
    const missing = await get(mirrorUrl, '/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(missing.status).toBe(404)
    expect((await get(mirrorUrl, '/did:web:example.com')).status).toBe(404)
  })

  it('serves only its own copy without the fallback', async () => {
    const strict = new PlcMirror(db, { source: sourceUrl, fallback: false })
    const did = await createDid(new Client(sourceUrl), 'erin.krao.test')
    expect(await strict.didDoc(did)).toBeUndefined()
  })

  it('refuses forged operations from the source', async () => {
    const plc = new Client(sourceUrl)
    const did = await createDid(plc, 'frank.krao.test')
    await mirror.pollOnce()
    const last = await plc.getLastOp(did)
    const prev = await opCid(last)
    const other = await Secp256k1Keypair.create()
    // Signed by a key that is not a rotation key
    const forged = await updateHandleOp(last as never, other, 'evil.krao.test')
    expect(
      await mirror.ingest({
        did,
        operation: forged,
        createdAt: new Date().toISOString(),
      }),
    ).toBe('rejected')
    // A real signature on an altered body
    const genuine = await updateHandleOp(last as never, key, 'frank2.krao.test')
    const altered = { ...genuine, alsoKnownAs: ['at://evil.krao.test'] }
    expect(
      await mirror.ingest({
        did,
        operation: altered,
        createdAt: new Date().toISOString(),
      }),
    ).toBe('rejected')
    // A CID that does not match the operation
    expect(
      await mirror.ingest({
        did,
        operation: genuine,
        cid: prev,
        createdAt: new Date().toISOString(),
      }),
    ).toBe('rejected')
    // A creation that does not hash to the DID
    const stranger = await atprotoOp({
      signingKey: key.did(),
      handle: 'x.krao.test',
      pds: 'https://pds.krao.test',
      rotationKeys: [key.did()],
      prev: null,
      signer: key,
    })
    expect(
      await mirror.ingest({
        did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
        operation: stranger,
        createdAt: new Date().toISOString(),
      }),
    ).toBe('rejected')
    expect(
      await mirror.ingest({
        did,
        operation: genuine,
        createdAt: new Date().toISOString(),
      }),
    ).toBe('added')
    expect((await get(mirrorUrl, `/${did}`)).body.alsoKnownAs).toEqual([
      'at://frank2.krao.test',
    ])
    expect(mirror.stats.rejected).toBe(4)
  })

  it('replays recoveries, within 72 hours of the undone operation', async () => {
    const recovery = await Secp256k1Keypair.create()
    const plc = new Client(sourceUrl)
    const did = await plc.createDid({
      signingKey: key.did(),
      rotationKeys: [recovery.did(), key.did()],
      handle: 'gina.krao.test',
      pds: 'https://pds.krao.test',
      signer: key,
    })
    const [create] = await plc.getOperationLog(did)
    const createCid = await opCid(create)
    // A change by the lower key, undone by the higher one
    await plc.updateHandle(did, key, 'stolen.krao.test')
    const undo = await addSignature(
      {
        type: 'plc_operation',
        verificationMethods: { atproto: key.did() },
        rotationKeys: [recovery.did()],
        alsoKnownAs: ['at://gina.krao.test'],
        services: {
          atproto_pds: {
            type: 'AtprotoPersonalDataServer',
            endpoint: 'https://pds.krao.test',
          },
        },
        prev: createCid,
      },
      recovery,
    )
    await plc.sendOperation(did, undo as never)
    await mirror.pollOnce()
    const audit = await get(mirrorUrl, `/${did}/log/audit`)
    expect(audit.body.map((o: any) => o.nullified)).toEqual([
      false,
      true,
      false,
    ])
    expect((await get(mirrorUrl, `/${did}`)).body.alsoKnownAs).toEqual([
      'at://gina.krao.test',
    ])

    // The same recovery, 73 hours after the operation it undoes
    const ops = await mirror.ops(did, true)
    const history = [
      { ...ops[0], createdAt: '2026-01-01T00:00:00.000Z' },
      { ...ops[1], createdAt: '2026-01-01T00:00:00.000Z' },
    ]
    await expect(
      validateNextOp(did, history, undo, '2026-01-04T01:00:00.000Z'),
    ).rejects.toThrow()
    expect(
      await validateNextOp(did, history, undo, '2026-01-03T23:00:00.000Z'),
    ).toEqual({ nullified: [ops[1].cid] })
  })

  it('can start from a point in time, copying older DIDs when asked', async () => {
    const plc = new Client(sourceUrl)
    const old = await createDid(plc, 'old.krao.test')
    await new Promise((r) => setTimeout(r, 5))
    const late = new PlcMirror(db, {
      source: sourceUrl,
      startAfter: new Date().toISOString(),
    })
    await plc.updateHandle(old, key, 'old2.krao.test')
    const fresh = await createDid(plc, 'fresh.krao.test')
    await late.pollOnce()
    expect((await late.ops(fresh)).length).toBe(1)
    // The update of a DID it never had is skipped, not refused
    expect(await late.ops(old)).toEqual([])
    expect(late.stats.rejected).toBe(0)
    expect((await late.didDoc(old))?.alsoKnownAs).toEqual([
      'at://old2.krao.test',
    ])
  })

  it('moves its time cursor without losing operations at page edges', async () => {
    // Pages served by a fake source: later operations of DIDs the mirror
    // never had (all skipped)
    const pages: { after: string | null }[] = []
    let page: unknown[] = []
    const fake = new PlcMirror(db, {
      source: 'http://plc.invalid',
      fetchFn: (async (url: URL) => {
        pages.push({ after: url.searchParams.get('after') })
        return new Response(page.map((e) => JSON.stringify(e)).join('\n'))
      }) as never,
    })
    const entry = (i: number, createdAt: string) => ({
      did: `did:plc:${String(i).padStart(24, 'a')}`,
      operation: {
        type: 'plc_tombstone',
        prev: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
        sig: `sig${i}`,
      },
      createdAt,
    })
    const t0 = Date.parse('2026-10-01T00:00:00.000Z')
    page = Array.from({ length: 1000 }, (_, i) =>
      entry(i, new Date(t0 + i).toISOString()),
    )
    expect(await fake.pollOnce()).toBe(true)
    // Skipped operations move the cursor to the last one's time, not past
    // it: others of that millisecond may come on the next page
    const last = new Date(t0 + 999).toISOString()
    expect(await fake.getState('cursor')).toBe(last)
    page = []
    expect(await fake.pollOnce()).toBe(false)
    expect(pages[1].after).toBe(new Date(t0 + 998).toISOString())

    // A full page all within the cursor's millisecond: stepped past, not
    // asked for forever
    page = Array.from({ length: 1000 }, (_, i) => entry(2000 + i, last))
    await fake.pollOnce()
    expect(await fake.getState('cursor')).toBe(
      new Date(t0 + 1000).toISOString(),
    )
  })

  it('reports how far behind it may be', async () => {
    expect(mirror.lagSeconds()).toBeNull()
    await mirror.pollOnce()
    expect(mirror.lagSeconds()).toBeLessThan(1)
    await source.destroy()
    await expect(mirror.pollOnce()).rejects.toThrow()
    // Restarted for afterEach
    const plcDb = plcServer.Database.mock()
    source = plcServer.PlcServer.create({ db: plcDb, port: 0 })
    await source.start()
  })
})
