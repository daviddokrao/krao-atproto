import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBadgeVisibility, humanDids, setBadgeVisibility } from './badges.js'
import { type Database, createDb, migrateDb } from './db.js'

const PHONE = 'did:plc:phone'
const KYC = 'did:plc:kyc'
const NOBODY = 'did:plc:nobody'

describe('human badge', () => {
  let db: Database

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    const at = new Date().toISOString()
    await db
      .insertInto('phone_verification')
      .values({ did: PHONE, phoneHash: 'h', phoneEnc: 'e', verifiedAt: at })
      .execute()
    await db
      .insertInto('kyc_record')
      .values({
        did: KYC,
        status: 'approved',
        provider: 'manual',
        providerRef: null,
        rejectReason: null,
        updatedAt: at,
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('shows only once the account opts in', async () => {
    expect(await humanDids(db, [PHONE, KYC, NOBODY])).toEqual(new Set())
    expect(await getBadgeVisibility(db, PHONE)).toEqual({
      human: false,
      eligible: true,
    })
    await setBadgeVisibility(db, PHONE, true)
    await setBadgeVisibility(db, KYC, true)
    expect(await humanDids(db, [PHONE, KYC, NOBODY])).toEqual(
      new Set([PHONE, KYC]),
    )
    await setBadgeVisibility(db, KYC, false)
    expect(await humanDids(db, [PHONE, KYC])).toEqual(new Set([PHONE]))
  })

  it('needs a verified phone or approved KYC', async () => {
    expect(await setBadgeVisibility(db, NOBODY, true)).toEqual({
      human: true,
      eligible: false,
    })
    await db
      .insertInto('kyc_record')
      .values({
        did: NOBODY,
        status: 'pending',
        provider: 'manual',
        providerRef: null,
        rejectReason: null,
        updatedAt: new Date().toISOString(),
      })
      .execute()
    expect(await humanDids(db, [NOBODY])).toEqual(new Set())
  })

  it('is hidden while the account is taken down', async () => {
    await setBadgeVisibility(db, PHONE, true)
    await db
      .insertInto('taken_down')
      .values({ did: PHONE, createdAt: new Date().toISOString() })
      .execute()
    expect(await humanDids(db, [PHONE])).toEqual(new Set())
    expect((await getBadgeVisibility(db, PHONE)).eligible).toBe(false)
  })
})
