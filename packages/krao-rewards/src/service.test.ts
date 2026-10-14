import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import { DEFAULT_RULES, RewardsService } from './service.js'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const CAROL = 'did:plc:carol'
const ADMIN = 'did:plc:admin'

describe('RewardsService', () => {
  let db: Database
  let service: RewardsService

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new RewardsService(db)
    await service.seedRules()
  })

  afterEach(async () => {
    await db.destroy()
  })

  const approveKyc = (did: string) =>
    service.setKycStatus('test', did, { status: 'approved', provider: 'test' })

  const signUp = async (did: string, referrer: string) => {
    const code = await service.personalCode(referrer)
    await service.recordReferral(did, code, new Date().toISOString())
  }

  it('gives each account one personal code', async () => {
    const code = await service.personalCode(ALICE)
    expect(code).toMatch(/^[2-9A-Z]{8}$/)
    expect(await service.personalCode(ALICE)).toBe(code)
    expect(await service.personalCode(BOB)).not.toBe(code)
  })

  it('checks codes case-insensitively and enforces limits', async () => {
    const code = await service.personalCode(ALICE)
    expect((await service.checkCode(code.toLowerCase())).valid).toBe(true)
    expect(await service.checkCode('NOPE-NOPE')).toEqual({
      valid: false,
      reason: 'not_found',
    })

    await service.createCode(ADMIN, {
      code: 'launch',
      kind: 'campaign',
      maxUses: 1,
    })
    expect((await service.checkCode('LAUNCH')).valid).toBe(true)
    await service.recordReferral(BOB, 'LAUNCH', new Date().toISOString())
    expect(await service.checkCode('LAUNCH')).toEqual({
      valid: false,
      reason: 'used_up',
    })

    await service.updateCode(ADMIN, { code: 'launch', disabled: true })
    expect(await service.checkCode('launch')).toMatchObject({
      reason: 'disabled',
    })
  })

  it('gives pending points to both sides of a referral', async () => {
    await signUp(BOB, ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
    expect(await service.balance(BOB)).toEqual({ pending: 50, approved: 0 })
  })

  it('records a referral once, however often the PDS reports it', async () => {
    await signUp(BOB, ALICE)
    await signUp(BOB, ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
  })

  it('approves points only once both accounts pass KYC', async () => {
    await signUp(BOB, ALICE)
    await approveKyc(BOB)
    expect(await service.balance(BOB)).toEqual({ pending: 50, approved: 0 })
    const { entries } = await service.listEntries(BOB, 10)
    expect(entries[0].waitingFor).toEqual(['kyc:related'])

    await approveKyc(ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 100 })
    expect(await service.balance(BOB)).toEqual({ pending: 0, approved: 50 })
  })

  it('approves at once when both had already passed KYC', async () => {
    await approveKyc(ALICE)
    await approveKyc(BOB)
    await signUp(BOB, ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 100 })
  })

  it('voids the pending points of a rejected account and its referrer', async () => {
    await signUp(BOB, ALICE)
    await service.setKycStatus('test', BOB, {
      status: 'rejected',
      provider: 'test',
      duplicate: true,
    })
    expect(await service.balance(BOB)).toEqual({ pending: 0, approved: 0 })
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })
  })

  it('keeps points pending when verification can be retried', async () => {
    await signUp(BOB, ALICE)
    await service.setKycStatus('test', BOB, {
      status: 'retry',
      provider: 'test',
    })
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
  })

  it('reverses approved points when they are revoked', async () => {
    await approveKyc(ALICE)
    await approveKyc(BOB)
    await signUp(BOB, ALICE)
    const counts = await service.revokePoints(ADMIN, ALICE, 'Fraud ring found')
    expect(counts).toEqual({ voided: 0, reversed: 1 })
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })
    // Revoking again changes nothing
    await service.revokePoints(ADMIN, ALICE, 'Fraud ring found')
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })
  })

  it('applies changed rules to new sign-ups only', async () => {
    await signUp(BOB, ALICE)
    await service.upsertRule(ADMIN, { ...DEFAULT_RULES[0], amount: 200 })
    await signUp(CAROL, ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 300, approved: 0 })
    const { entries } = await service.listEntries(ALICE, 10)
    expect(entries.map((e) => [e.amount, e.ruleVersion])).toEqual([
      [200, 2],
      [100, 1],
    ])
  })

  it('respects a cap per beneficiary', async () => {
    await service.upsertRule(ADMIN, {
      ...DEFAULT_RULES[0],
      capPerBeneficiary: 100,
    })
    await signUp(BOB, ALICE)
    await signUp(CAROL, ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
  })

  it('limits campaign rules to their codes', async () => {
    await service.createCode(ADMIN, {
      code: 'PARTNER-X',
      kind: 'partner',
      ownerDid: ALICE,
      campaignId: 'x',
    })
    await service.upsertRule(ADMIN, {
      ...DEFAULT_RULES[1],
      id: 'partner.x.bonus',
      amount: 25,
      campaignId: 'x',
    })
    await service.recordReferral(BOB, 'PARTNER-X', new Date().toISOString())
    await signUp(CAROL, ALICE)
    expect(await service.balance(BOB)).toEqual({ pending: 75, approved: 0 })
    expect(await service.balance(CAROL)).toEqual({ pending: 50, approved: 0 })
  })

  it('pays second level referrers when a rule asks for it', async () => {
    await service.upsertRule(ADMIN, {
      ...DEFAULT_RULES[0],
      id: 'referral.level2',
      beneficiary: 'referrer2',
      amount: 10,
      vesting: [],
    })
    await signUp(BOB, ALICE)
    await signUp(CAROL, BOB)
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 10 })
  })

  it('does not reward sign-ups that raced past a code limit', async () => {
    await service.createCode(ADMIN, {
      code: 'ONE',
      kind: 'campaign',
      ownerDid: ALICE,
      maxUses: 1,
    })
    await service.recordReferral(BOB, 'ONE', new Date().toISOString())
    await service.recordReferral(CAROL, 'ONE', new Date().toISOString())
    const carol = await db
      .selectFrom('referral')
      .select('flag')
      .where('did', '=', CAROL)
      .executeTakeFirstOrThrow()
    expect(carol.flag).toBe('over_limit')
    expect(await service.balance(CAROL)).toEqual({ pending: 0, approved: 0 })
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
  })

  it('keeps a provider rejection, unless an admin overrides it', async () => {
    await service.setKycStatus('sumsub', BOB, {
      status: 'rejected',
      provider: 'sumsub',
    })
    await service.setKycStatus('sumsub', BOB, {
      status: 'approved',
      provider: 'sumsub',
    })
    expect((await service.kycRecord(BOB))?.status).toBe('rejected')
    await service.setKycStatus(ADMIN, BOB, {
      status: 'approved',
      provider: 'manual',
    })
    expect((await service.kycRecord(BOB))?.status).toBe('approved')
  })

  it('takes back what a revoked account earned its referrer', async () => {
    await approveKyc(ALICE)
    await approveKyc(BOB)
    await signUp(BOB, ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 100 })
    await service.setKycStatus('sumsub', BOB, {
      status: 'rejected',
      provider: 'sumsub',
      duplicate: true,
    })
    expect(await service.balance(BOB)).toEqual({ pending: 0, approved: 0 })
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })
  })

  it('flags sign-ups whose code was no longer valid, without rewards', async () => {
    await service.recordReferral(BOB, 'GHOST', new Date().toISOString())
    const referral = await db
      .selectFrom('referral')
      .selectAll()
      .where('did', '=', BOB)
      .executeTakeFirstOrThrow()
    expect(referral.flag).toBe('invalid_code')
    expect(await service.balance(BOB)).toEqual({ pending: 0, approved: 0 })
  })
})
