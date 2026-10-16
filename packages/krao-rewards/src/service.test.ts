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

  it('reports what a personal code gives now', async () => {
    expect(await service.personalReferralPoints()).toEqual({
      referrer: 100,
      actor: 50,
    })
    await service.upsertRule(ADMIN, { ...DEFAULT_RULES[0], amount: 150 })
    await service.upsertRule(ADMIN, { ...DEFAULT_RULES[1], enabled: false })
    expect(await service.personalReferralPoints()).toEqual({
      referrer: 150,
      actor: 0,
    })
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

  it('refuses rules that reward beyond one level', async () => {
    for (const beneficiary of ['referrer2', 'referrer_l2', 'referrer3']) {
      const err = await service
        .upsertRule(ADMIN, {
          ...DEFAULT_RULES[0],
          id: 'referral.level2',
          beneficiary: beneficiary as never,
          amount: 10,
          vesting: [],
        })
        .catch((e: { error?: string }) => e)
      expect((err as { error?: string }).error).toBe('MultiLevelReferral')
    }
    expect((await service.listRules()).map((r) => r.id)).not.toContain(
      'referral.level2',
    )
  })

  it('ignores multi-level rules left from before', async () => {
    await db
      .insertInto('reward_rule')
      .values({
        id: 'legacy.level2',
        version: 1,
        enabled: 1,
        description: null,
        event: 'account.created',
        beneficiary: 'referrer2' as never,
        amount: 10,
        vesting: '[]',
        codeKinds: '[]',
        campaignId: null,
        validFrom: null,
        validUntil: null,
        capPerBeneficiary: null,
        capPerDay: null,
        updatedAt: new Date().toISOString(),
        updatedBy: 'test',
      })
      .execute()
    await signUp(BOB, ALICE)
    await signUp(CAROL, BOB)
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
  })

  it('caps the default inviter rule at 20 sign-ups a day', async () => {
    const [inviter] = (await service.listRules()).filter(
      (r) => r.id === 'referral.inviter',
    )
    expect(inviter.capPerDay).toBe(20)
    for (let i = 0; i < 21; i++) {
      await signUp(`did:plc:invitee${i}`, ALICE)
    }
    expect(await service.balance(ALICE)).toEqual({
      pending: 2000,
      approved: 0,
    })
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

  it('stops a taken down account from earning, until the takedown is lifted', async () => {
    const code = await service.personalCode(ALICE)
    await signUp(BOB, ALICE)
    await service.takeDown(ALICE)
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })
    expect((await service.checkCode(code)).valid).toBe(false)

    // An earlier invitee passing KYC brings nothing now
    await approveKyc(ALICE)
    await approveKyc(BOB)
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })

    await service.liftTakedown(ALICE)
    expect((await service.checkCode(code)).valid).toBe(true)
    await service.recordReferral(CAROL, code, new Date().toISOString())
    expect(await service.balance(ALICE)).toEqual({ pending: 100, approved: 0 })
  })

  it('runs a KYC approval that came during a takedown once it is lifted', async () => {
    await service.upsertRule(ADMIN, {
      ...DEFAULT_RULES[0],
      id: 'kyc-bonus',
      event: 'kyc.approved',
      beneficiary: 'actor',
      amount: 10,
      vesting: [],
    })
    await service.takeDown(ALICE)
    await approveKyc(ALICE)
    expect((await service.balance(ALICE)).approved).toBe(0)
    await service.liftTakedown(ALICE)
    expect((await service.balance(ALICE)).approved).toBe(10)
  })

  it('stops a deleted account and voids the points that waited for it', async () => {
    const bobCode = await service.personalCode(BOB)
    await signUp(BOB, ALICE)
    expect((await service.balance(ALICE)).pending).toBe(100)
    await service.accountDeleted(BOB)
    // Alice's points needed Bob's KYC, which can no longer happen
    expect(await service.balance(ALICE)).toEqual({ pending: 0, approved: 0 })
    expect((await service.checkCode(bobCode)).valid).toBe(false)
  })

  it('keeps approved points when an invitee deletes their account later', async () => {
    await signUp(BOB, ALICE)
    await approveKyc(ALICE)
    await approveKyc(BOB)
    const before = await service.balance(ALICE)
    expect(before.approved).toBeGreaterThan(0)
    await service.accountDeleted(BOB)
    expect(await service.balance(ALICE)).toEqual(before)
  })

  it('keeps the bonus of someone a taken down account invited', async () => {
    await service.upsertRule(ADMIN, {
      ...DEFAULT_RULES[1],
      vesting: ['kyc:self'],
    })
    await signUp(BOB, ALICE)
    await service.takeDown(ALICE)
    expect(await service.balance(BOB)).toEqual({ pending: 50, approved: 0 })
  })

  it('rewards a first wallet and a first post once per account', async () => {
    await signUp(BOB, ALICE)
    const before = await service.balance(BOB)
    for (let i = 0; i < 3; i++) {
      // The indexer reports again after an unlink and relink, a repost...
      await service.recordAccountEvent('wallet.linked', BOB)
      await service.recordAccountEvent('post.first', BOB)
    }
    const entries = (await service.listEntries(BOB, 50)).entries
    expect(
      entries.filter((e) => e.ruleId === 'growth.wallet-linked'),
    ).toHaveLength(1)
    expect(
      entries.filter((e) => e.ruleId === 'growth.first-post'),
    ).toHaveLength(1)
    expect(await service.balance(BOB)).toEqual({
      pending: before.pending + 30,
      approved: 0,
    })
    // Vesting on the account's own KYC only
    await approveKyc(BOB)
    expect((await service.balance(BOB)).approved).toBeGreaterThanOrEqual(30)
    // The referrer rules are off by default
    expect(
      (await service.listEntries(ALICE, 50)).entries.some((e) =>
        e.ruleId?.startsWith('growth.'),
      ),
    ).toBe(false)
  })

  it('gives the referrer growth points once turned on, one level, capped', async () => {
    const rule = DEFAULT_RULES.find(
      (r) => r.id === 'growth.first-post.referrer',
    )!
    await service.upsertRule(ADMIN, { ...rule, enabled: true, capPerDay: 1 })
    await signUp(BOB, ALICE)
    await signUp(CAROL, ALICE)
    await service.recordAccountEvent('post.first', BOB)
    await service.recordAccountEvent('post.first', CAROL)
    const growth = (await service.listEntries(ALICE, 50)).entries.filter(
      (e) => e.ruleId === 'growth.first-post.referrer',
    )
    // Daily cap of one
    expect(growth).toHaveLength(1)
    expect(growth[0]).toMatchObject({ amount: 5, relatedDid: BOB })
  })

  it('drops account events of taken down and deleted accounts', async () => {
    await service.takeDown(BOB)
    await service.recordAccountEvent('post.first', BOB)
    await service.accountDeleted(CAROL)
    await service.recordAccountEvent('wallet.linked', CAROL)
    expect(await service.balance(BOB)).toEqual({ pending: 0, approved: 0 })
    expect(await service.balance(CAROL)).toEqual({ pending: 0, approved: 0 })
    await expect(
      service.recordAccountEvent('account.created', BOB),
    ).rejects.toThrow()
  })

  it('adds new default rules to an existing rule table', async () => {
    const fresh = createDb(':memory:')
    await migrateDb(fresh)
    const old = new RewardsService(fresh)
    // A table seeded before the growth rules existed
    for (const rule of DEFAULT_RULES.filter((r) =>
      r.id.startsWith('referral.'),
    )) {
      await old.upsertRule('system', { ...rule, amount: 7 })
    }
    await old.seedRules()
    const rules = await old.listRules()
    expect(rules.map((r) => r.id).sort()).toEqual(
      DEFAULT_RULES.map((r) => r.id).sort(),
    )
    // Existing rules keep their settings
    expect(rules.find((r) => r.id === 'referral.inviter')?.amount).toBe(7)
    await fresh.destroy()
  })

  it('refuses rules for unknown events', async () => {
    await expect(
      service.upsertRule(ADMIN, {
        ...DEFAULT_RULES[0],
        event: 'nope' as never,
      }),
    ).rejects.toThrow(/event must be one of/)
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
