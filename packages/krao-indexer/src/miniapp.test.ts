import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import { exportIndexerData } from './export.js'
import {
  MINIAPP_COLLECTION,
  MiniAppError,
  approveMiniApp,
  checkMiniAppUrl,
  deleteMiniApp,
  deleteMiniAppsForDid,
  getMiniApp,
  hiddenDids,
  listApprovedMiniApps,
  listPendingMiniApps,
  miniAppRowFromRecord,
  miniAppStatus,
  miniAppView,
  revokeMiniApp,
  upsertMiniApp,
} from './miniapp.js'

const DEV = 'did:plc:developer'
const ADMIN = 'did:plc:admin'
const RULES = { webOrigins: ['https://krao.net'] }
const uri = (rkey: string, did = DEV) =>
  `at://${did}/${MINIAPP_COLLECTION}/${rkey}`

const record = (over: Record<string, unknown> = {}) => ({
  $type: MINIAPP_COLLECTION,
  name: 'Bỏ phiếu nhanh',
  description: 'Quick polls',
  url: 'https://vote.example.com/app',
  permissions: ['identity', 'wallet'],
  createdAt: '2026-10-16T00:00:00.000Z',
  ...over,
})

let db: Database
const safe: (url: string) => boolean = () => false

async function index(rkey: string, cid: string, value = record()) {
  await upsertMiniApp(
    db,
    miniAppRowFromRecord(uri(rkey), DEV, cid, value, RULES),
  )
}

async function status(rkey: string, unsafe = safe) {
  const row = (await getMiniApp(db, uri(rkey)))!
  return miniAppStatus(row, {
    hidden: await hiddenDids(db, [row.did]),
    isUnsafe: unsafe,
  })
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
})

afterEach(async () => {
  await db.destroy()
})

describe('Mini App URLs', () => {
  it('needs https on another origin than the web app', () => {
    expect(checkMiniAppUrl('https://vote.example.com/x?y=1', RULES)).toEqual({
      origin: 'https://vote.example.com',
      href: 'https://vote.example.com/x?y=1',
    })
    expect(checkMiniAppUrl('http://vote.example.com/', RULES)).toHaveProperty(
      'reason',
    )
    expect(checkMiniAppUrl('https://krao.net/miniapp', RULES)).toHaveProperty(
      'reason',
    )
    expect(checkMiniAppUrl('javascript:alert(1)', RULES)).toHaveProperty(
      'reason',
    )
    expect(
      checkMiniAppUrl('https://a:b@vote.example.com/', RULES),
    ).toHaveProperty('reason')
    expect(checkMiniAppUrl('not a url', RULES)).toHaveProperty('reason')
  })

  it('allows http://localhost only in development', () => {
    expect(checkMiniAppUrl('http://localhost:2595/', RULES)).toHaveProperty(
      'reason',
    )
    expect(checkMiniAppUrl('https://localhost/', RULES)).toHaveProperty(
      'reason',
    )
    const dev = { devMode: true, webOrigins: ['http://localhost:8081'] }
    expect(checkMiniAppUrl('http://localhost:2595/', dev)).toEqual({
      origin: 'http://localhost:2595',
      href: 'http://localhost:2595/',
    })
    // Still not the web app's own origin, nor other plain http hosts
    expect(checkMiniAppUrl('http://localhost:8081/x', dev)).toHaveProperty(
      'reason',
    )
    expect(checkMiniAppUrl('http://example.com/', dev)).toHaveProperty('reason')
  })
})

describe('Mini App records', () => {
  it('indexes a valid record', () => {
    const row = miniAppRowFromRecord(uri('a'), DEV, 'cid1', record(), RULES)
    expect(row.invalidReason).toBeNull()
    expect(row.origin).toBe('https://vote.example.com')
    expect(JSON.parse(row.permissions)).toEqual(['identity', 'wallet'])
  })

  it('marks records that break the rules invalid, with the reason', () => {
    const invalid = (value: Record<string, unknown>) =>
      miniAppRowFromRecord(uri('a'), DEV, 'cid1', record(value), RULES)
        .invalidReason
    expect(invalid({ url: 'http://vote.example.com' })).toMatch(/https/)
    expect(invalid({ url: 'https://krao.net/app' })).toMatch(/origin/)
    expect(invalid({ permissions: ['identity', 'identity'] })).toMatch(
      /permissions/,
    )
    expect(invalid({ permissions: ['admin'] })).toMatch(/permissions/)
    expect(invalid({ permissions: undefined })).toMatch(/permissions/)
    expect(invalid({ chains: ['eip155:1'] })).toMatch(/chains/)
    expect(invalid({ name: ' ' })).toMatch(/name/)
    expect(invalid({ name: 'x'.repeat(65) })).toMatch(/name/)
    expect(invalid({ chains: ['eip155:8453'] })).toBeNull()
  })

  it('keeps a usable icon only', () => {
    const icon = (mimeType: string, size: number) =>
      miniAppRowFromRecord(
        uri('a'),
        DEV,
        'cid1',
        record({
          icon: {
            $type: 'blob',
            ref: { $link: 'bafkreiabcdefghijklmnop' },
            mimeType,
            size,
          },
        }),
        RULES,
      ).iconCid
    expect(icon('image/png', 1000)).toBe('bafkreiabcdefghijklmnop')
    expect(icon('image/svg+xml', 1000)).toBeNull()
    expect(icon('image/png', 2_000_000)).toBeNull()
  })

  it('stores what fits the view: ASCII URLs, byte-limited text', () => {
    const row = miniAppRowFromRecord(
      uri('a'),
      DEV,
      'cid1',
      record({ url: `https://bỏ-phiếu.example/${'đ'.repeat(300)}` }),
      RULES,
    )
    expect(row.invalidReason).toBeNull()
    expect(row.origin).toMatch(/^https:\/\/xn--[a-z0-9-]+\.example$/)
    expect(row.url).toMatch(/^[\x21-\x7e]+$/)
    expect(row.url.length).toBeLessThanOrEqual(2048)
    // Too long once percent-encoded: invalid, not a view that cannot be sent
    const long = miniAppRowFromRecord(
      uri('b'),
      DEV,
      'cid1',
      record({ url: `https://vote.example.com/${'đ'.repeat(2000)}` }),
      RULES,
    )
    expect(long.invalidReason).toMatch(/url is longer/)
    expect(Buffer.byteLength(long.url)).toBeLessThanOrEqual(2048)
    const named = miniAppRowFromRecord(
      uri('c'),
      DEV,
      'cid1',
      record({ name: 'ệ'.repeat(600), description: 'ệ'.repeat(2000) }),
      RULES,
    )
    expect(named.invalidReason).toMatch(/name/)
    expect(Buffer.byteLength(named.name)).toBeLessThanOrEqual(640)
    expect(Buffer.byteLength(named.description!)).toBeLessThanOrEqual(3000)
  })
})

describe('Mini App review', () => {
  it('goes from pending to approved, back to pending when changed', async () => {
    await index('a', 'cid1')
    expect(await status('a')).toEqual({ status: 'pending' })
    expect(
      (await listPendingMiniApps(db, { limit: 10 })).rows.map((r) => r.uri),
    ).toEqual([uri('a')])
    expect(
      (await listApprovedMiniApps(db, { limit: 10, isUnsafe: safe })).rows,
    ).toEqual([])

    await expect(
      approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid0' }, safe),
    ).rejects.toMatchObject({ code: 'CidMismatch' })
    await approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid1' }, safe)
    expect(await status('a')).toEqual({ status: 'approved' })
    expect(
      (await listApprovedMiniApps(db, { limit: 10, isUnsafe: safe })).rows.map(
        (r) => r.uri,
      ),
    ).toEqual([uri('a')])
    expect((await listPendingMiniApps(db, { limit: 10 })).rows).toEqual([])
    const log = await db.selectFrom('safety_audit_log').selectAll().execute()
    expect(log).toMatchObject([
      { adminDid: ADMIN, action: 'miniapp.approve', domain: uri('a') },
    ])

    // A new version needs a new review; the old approval stays on record
    await index('a', 'cid2', record({ name: 'Bỏ phiếu' }))
    expect(await status('a')).toEqual({ status: 'pending' })
    const row = await getMiniApp(db, uri('a'))
    expect(row?.approvedCid).toBe('cid1')
    expect(
      (await listApprovedMiniApps(db, { limit: 10, isUnsafe: safe })).rows,
    ).toEqual([])
  })

  it('revokes every version until approved again', async () => {
    await index('a', 'cid1')
    await approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid1' }, safe)
    await revokeMiniApp(db, ADMIN, { uri: uri('a'), reason: 'drainer' })
    expect(await status('a')).toEqual({
      status: 'revoked',
      revokedReason: 'drainer',
    })
    await index('a', 'cid2')
    expect((await status('a')).status).toBe('revoked')
    expect((await listPendingMiniApps(db, { limit: 10 })).rows).toEqual([])
    await approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid2' }, safe)
    expect(await status('a')).toEqual({ status: 'approved' })
    const actions = await db
      .selectFrom('safety_audit_log')
      .select('action')
      .orderBy('id')
      .execute()
    expect(actions.map((a) => a.action)).toEqual([
      'miniapp.approve',
      'miniapp.revoke',
      'miniapp.approve',
    ])
  })

  it('counts apps of hidden developers and unsafe domains as revoked', async () => {
    await index('a', 'cid1')
    await approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid1' }, safe)
    const unsafe = (url: string) => url.includes('vote.example.com')
    expect(await status('a', unsafe)).toEqual({
      status: 'revoked',
      revokedReason: 'unsafeDomain',
    })
    expect(
      (await listApprovedMiniApps(db, { limit: 10, isUnsafe: unsafe })).rows,
    ).toEqual([])
    await expect(
      approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid1' }, unsafe),
    ).rejects.toMatchObject({ code: 'UnsafeDomain' })

    await db
      .insertInto('hidden_actor')
      .values({ did: DEV, status: 'takendown', since: 'x' })
      .execute()
    expect(await status('a')).toEqual({
      status: 'revoked',
      revokedReason: 'developerTakenDown',
    })
    expect(
      (await listApprovedMiniApps(db, { limit: 10, isUnsafe: safe })).rows,
    ).toEqual([])
  })

  it('does not approve invalid records', async () => {
    await index('a', 'cid1', record({ url: 'http://vote.example.com' }))
    expect(await status('a')).toEqual({ status: 'invalid' })
    await expect(
      approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid1' }, safe),
    ).rejects.toMatchObject({ code: 'InvalidApp' })
    await expect(
      approveMiniApp(db, ADMIN, { uri: uri('nope'), cid: 'cid1' }, safe),
    ).rejects.toBeInstanceOf(MiniAppError)
    expect((await listPendingMiniApps(db, { limit: 10 })).rows).toEqual([])
  })

  it('pages approved apps, newest approval first', async () => {
    for (const [i, rkey] of ['a', 'b', 'c'].entries()) {
      await index(rkey, `cid-${rkey}`)
      await approveMiniApp(
        db,
        ADMIN,
        { uri: uri(rkey), cid: `cid-${rkey}` },
        safe,
        `2026-10-16T00:00:0${i}.000Z`,
      )
    }
    const first = await listApprovedMiniApps(db, { limit: 2, isUnsafe: safe })
    expect(first.rows.map((r) => r.uri)).toEqual([uri('c'), uri('b')])
    const second = await listApprovedMiniApps(db, {
      limit: 2,
      cursor: first.cursor,
      isUnsafe: safe,
    })
    expect(second.rows.map((r) => r.uri)).toEqual([uri('a')])
    expect(second.cursor).toBeUndefined()
    await expect(
      listApprovedMiniApps(db, { limit: 2, cursor: 'junk', isUnsafe: safe }),
    ).rejects.toBeInstanceOf(MiniAppError)
  })

  it('builds the view, with the icon through the proxy', async () => {
    await index(
      'a',
      'cid1',
      record({
        icon: {
          $type: 'blob',
          ref: { $link: 'bafkreiabcdefghijklmnop' },
          mimeType: 'image/png',
          size: 10,
        },
      }),
    )
    const row = (await getMiniApp(db, uri('a')))!
    const view = miniAppView(row, {
      hidden: new Set(),
      isUnsafe: safe,
      baseUrl: 'https://idx.krao.net',
    })
    expect(view).toMatchObject({
      uri: uri('a'),
      cid: 'cid1',
      developer: DEV,
      name: 'Bỏ phiếu nhanh',
      origin: 'https://vote.example.com',
      permissions: ['identity', 'wallet'],
      status: 'pending',
    })
    expect(view.iconUrl).toBe(
      `https://idx.krao.net/miniapp-icon?uri=${encodeURIComponent(uri('a'))}&cid=bafkreiabcdefghijklmnop`,
    )
    expect(view.approvedAt).toBeUndefined()
  })

  it('forgets deleted records and accounts', async () => {
    await index('a', 'cid1')
    await index('b', 'cid2')
    await deleteMiniApp(db, uri('a'))
    expect(await getMiniApp(db, uri('a'))).toBeUndefined()
    await deleteMiniAppsForDid(db, DEV)
    expect(await getMiniApp(db, uri('b'))).toBeUndefined()
  })

  it("is in the developer's data export, with its review", async () => {
    await index('a', 'cid1')
    await approveMiniApp(db, ADMIN, { uri: uri('a'), cid: 'cid1' }, safe)
    const data = (await exportIndexerData(db, DEV, (id) => id)) as {
      miniApps: Record<string, unknown>[]
    }
    expect(data.miniApps).toEqual([
      expect.objectContaining({
        uri: uri('a'),
        cid: 'cid1',
        name: 'Bỏ phiếu nhanh',
        url: 'https://vote.example.com/app',
        permissions: ['identity', 'wallet'],
        approvedCid: 'cid1',
      }),
    ])
    const other = (await exportIndexerData(db, ADMIN, (id) => id)) as {
      miniApps: unknown[]
    }
    expect(other.miniApps).toEqual([])
  })
})
