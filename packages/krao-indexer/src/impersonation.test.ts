import sharp from 'sharp'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IdResolver } from '@atproto/identity'
import type { AdminAuditEntry } from './admin-roles.js'
import { type Database, createDb, migrateDb } from './db.js'
import {
  type ImpersonationModerator,
  ImpersonationWatcher,
  OzoneAdminClient,
  PROFILE_COLLECTION,
  type Target,
  VERIFICATION_COLLECTION,
  blobCid,
} from './impersonation.js'

const VERIFIER = 'did:plc:verifier'
const BRAND = 'did:plc:brand'
const FAKE = 'did:plc:fake'
const OTHER = 'did:plc:other'
const LOOKALIKE_HANDLE = 'did:plc:handle'

// Avatar blobs by CID: A, A re-encoded, and an unrelated picture
const CID_A = 'bafkreiaaaa'
const CID_A2 = 'bafkreiaaab'
const CID_B = 'bafkreibbbb'

const picture = (flip: boolean) => {
  const width = 64
  const data = Buffer.alloc(width * width)
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, 255 - x * 3 - y)
      data[y * width + (flip ? width - 1 - x : x)] =
        (x - 30) ** 2 + (y - 20) ** 2 < 150 ? 10 : v
    }
  }
  return sharp(data, { raw: { width, height: width, channels: 1 } })
}

let blobs: Map<string, Buffer>

beforeAll(async () => {
  blobs = new Map([
    [CID_A, await picture(false).png().toBuffer()],
    [CID_A2, await picture(false).resize(300, 300).jpeg().toBuffer()],
    [CID_B, await picture(true).png().toBuffer()],
  ])
})

describe('impersonation checks', () => {
  let db: Database
  let watcher: ImpersonationWatcher
  let handles: Map<string, string>
  let calls: string[]
  let failing: boolean
  let audit: AdminAuditEntry[]
  let blobReads: number

  const moderator: ImpersonationModerator = {
    actor: 'did:web:gate.test',
    label: async (did: string, target: Target, report: boolean) => {
      if (failing) throw new Error('Ozone down')
      calls.push(
        `label ${did} ${target.did} ${target.handle}${report ? ' report' : ''}`,
      )
    },
    unlabel: async (did: string) => {
      if (failing) throw new Error('Ozone down')
      calls.push(`unlabel ${did}`)
    },
  }

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    handles = new Map([
      [BRAND, 'nganhang.test'],
      [FAKE, 'support-team.test'],
      [OTHER, 'someone.test'],
      [LOOKALIKE_HANDLE, 'ngan-hang.test'],
    ])
    calls = []
    audit = []
    failing = false
    blobReads = 0
    const idResolver = {
      did: {
        resolve: async (did: string) => ({
          id: did,
          alsoKnownAs: handles.has(did) ? [`at://${handles.get(did)}`] : [],
        }),
      },
    } as unknown as IdResolver
    watcher = new ImpersonationWatcher(db, {
      verifiers: new Set([VERIFIER]),
      pdsUrl: 'http://pds.test',
      idResolver,
      moderator,
      audit: { record: async (entry) => void audit.push(entry) },
      fetchFn: (async (url: URL) => {
        blobReads++
        const blob = blobs.get(url.searchParams.get('cid') ?? '')
        return blob
          ? new Response(new Uint8Array(blob))
          : new Response('{}', { status: 404 })
      }) as unknown as typeof fetch,
    })
  })

  afterEach(async () => {
    await db.destroy()
  })

  const profile = (did: string, displayName: string, avatar?: string) =>
    watcher.onRecord(
      did,
      PROFILE_COLLECTION,
      `at://${did}/${PROFILE_COLLECTION}/self`,
      {
        $type: PROFILE_COLLECTION,
        displayName,
        ...(avatar
          ? {
              avatar: {
                $type: 'blob',
                ref: { $link: avatar },
                mimeType: 'image/png',
                size: 1,
              },
            }
          : {}),
      },
    )

  const verify = (did: string, displayName: string, issuer = VERIFIER) =>
    watcher.onRecord(
      issuer,
      VERIFICATION_COLLECTION,
      `at://${issuer}/${VERIFICATION_COLLECTION}/${did.slice(8)}`,
      {
        subject: did,
        handle: handles.get(did),
        displayName,
        createdAt: new Date().toISOString(),
      },
    )

  const setUp = async () => {
    await profile(BRAND, 'Ngân Hàng Krao', CID_A)
    await verify(BRAND, 'Ngân Hàng Krao')
    // Cyrillic К, the same avatar re-encoded, another handle
    await profile(FAKE, 'Ngân Hàng Кrao', CID_A2)
    // Another name, another avatar
    await profile(OTHER, 'Someone Else', CID_B)
    await watcher.round()
  }

  it('reads blob refs from the firehose and from JSON', () => {
    expect(blobCid({ ref: { $link: CID_A } })).toBe(CID_A)
    expect(blobCid({ ref: { toString: () => CID_A } })).toBe(CID_A)
    expect(blobCid(undefined)).toBeNull()
  })

  it('labels and reports a lookalike name with a lookalike avatar', async () => {
    await setUp()
    expect(calls).toEqual([`label ${FAKE} ${BRAND} nganhang.test report`])
    expect(audit).toEqual([
      {
        service: 'moderation',
        actor: 'did:web:gate.test',
        action: 'impersonation.label',
        subject: FAKE,
        details: { target: BRAND, targetHandle: 'nganhang.test' },
      },
    ])
    expect(await watcher.flagOf(FAKE)).toEqual({
      targetDid: BRAND,
      targetHandle: 'nganhang.test',
    })
    expect(await watcher.flagOf(BRAND)).toBeNull()
    expect(await watcher.flagOf(OTHER)).toBeNull()
  })

  it('also takes a lookalike handle instead of the avatar', async () => {
    await setUp()
    calls = []
    await profile(LOOKALIKE_HANDLE, 'Ngan hang KRAO', CID_B)
    await watcher.round()
    expect(calls).toEqual([
      `label ${LOOKALIKE_HANDLE} ${BRAND} nganhang.test report`,
    ])
  })

  it('leaves the same name alone with another avatar and handle', async () => {
    await setUp()
    calls = []
    await profile(OTHER, 'Ngân Hàng Krao', CID_B)
    await watcher.round()
    expect(calls).toEqual([])
  })

  it('takes the label off when the suspect renames, with no second report', async () => {
    await setUp()
    calls = []
    await profile(FAKE, 'Tiệm bánh mì', CID_A2)
    await watcher.round()
    expect(calls).toEqual([`unlabel ${FAKE}`])
    expect(audit.map((a) => a.action)).toEqual([
      'impersonation.label',
      'impersonation.unlabel',
    ])
    calls = []
    await profile(FAKE, 'Ngân Hàng Кrao', CID_A2)
    await watcher.round()
    expect(calls).toEqual([`label ${FAKE} ${BRAND} nganhang.test`])
  })

  it('never labels the verified account, and rechecks all when it changes', async () => {
    await setUp()
    calls = []
    // The brand renames: its verification no longer matches, nobody is verified
    await profile(BRAND, 'Ngân Hàng Krao Mới', CID_A)
    await watcher.round()
    expect(calls).toEqual([`unlabel ${FAKE}`])
    expect(await watcher.isVerified(BRAND)).toBe(false)
    calls = []
    // A new verification for the new name brings it back
    await verify(BRAND, 'Ngân Hàng Krao Mới')
    await profile(FAKE, 'Ngan Hang Krao Moi', CID_A2)
    await watcher.round()
    expect(calls).toEqual([`label ${FAKE} ${BRAND} nganhang.test`])
  })

  it('counts verifications by trusted verifiers only', async () => {
    await profile(BRAND, 'Ngân Hàng Krao', CID_A)
    await verify(BRAND, 'Ngân Hàng Krao', 'did:plc:random')
    await profile(FAKE, 'Ngân Hàng Кrao', CID_A2)
    await watcher.round()
    expect(calls).toEqual([])
    await watcher.onDelete(
      VERIFIER,
      VERIFICATION_COLLECTION,
      'at://nothing/x/y',
    )
  })

  it('follows handle changes from identity events', async () => {
    await setUp()
    calls = []
    // The brand's handle changes: its verification (by handle) lapses
    handles.set(BRAND, 'nganhang-new.test')
    await watcher.onIdentity(BRAND)
    await watcher.round()
    expect(calls).toEqual([`unlabel ${FAKE}`])
  })

  it('retries Ozone until it answers', async () => {
    failing = true
    await setUp()
    expect(calls).toEqual([])
    failing = false
    // Not due yet
    await watcher.applyFlags(Date.now() + 1_000)
    expect(calls).toEqual([])
    await watcher.applyFlags(Date.now() + 10_000)
    expect(calls).toEqual([`label ${FAKE} ${BRAND} nganhang.test report`])
  })

  it('reads each avatar once', async () => {
    await setUp()
    const reads = blobReads
    await profile(FAKE, 'Ngân Hàng Кrao!', CID_A2)
    await watcher.round()
    expect(blobReads).toBe(reads)
  })

  it('drops deleted accounts and their labels', async () => {
    await setUp()
    calls = []
    await watcher.onAccountDeleted(FAKE)
    await watcher.round()
    expect(calls).toEqual([`unlabel ${FAKE}`])
  })
})

describe('OzoneAdminClient', () => {
  it('labels, reports and unlabels the account with the admin password', async () => {
    const requests: { url: string; auth: string; body: any }[] = []
    const fetchFn = (async (url: URL, init: RequestInit) => {
      requests.push({
        url: url.toString(),
        auth: String((init.headers as Record<string, string>).authorization),
        body: JSON.parse(String(init.body)),
      })
      return new Response('{}')
    }) as unknown as typeof fetch
    const ozone = new OzoneAdminClient(
      'http://ozone.test',
      'secret',
      'did:web:gate.test',
      fetchFn,
    )
    await ozone.label(FAKE, { did: BRAND, handle: 'nganhang.test' }, true)
    await ozone.unlabel(FAKE)
    expect(requests.map((r) => r.url)).toEqual(
      Array(3).fill('http://ozone.test/xrpc/tools.ozone.moderation.emitEvent'),
    )
    expect(requests[0].auth).toBe(
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    )
    expect(requests[0].body).toMatchObject({
      subject: { $type: 'com.atproto.admin.defs#repoRef', did: FAKE },
      createdBy: 'did:web:gate.test',
      event: {
        $type: 'tools.ozone.moderation.defs#modEventLabel',
        createLabelVals: ['impersonation-suspect'],
      },
    })
    expect(requests[1].body.event).toMatchObject({
      $type: 'tools.ozone.moderation.defs#modEventReport',
      reportType: 'tools.ozone.report.defs#reasonMisleadingImpersonation',
    })
    expect(requests[1].body.event.comment).toContain(BRAND)
    expect(requests[2].body.event).toMatchObject({
      negateLabelVals: ['impersonation-suspect'],
    })
  })
})
