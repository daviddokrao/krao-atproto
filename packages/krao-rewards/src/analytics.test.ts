import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addDays, vnDay } from './activity.js'
import { getFunnel, getRetention, getSummary } from './analytics.js'
import { type Database, createDb, migrateDb } from './db.js'
import { RewardsService } from './service.js'

const DAY = 24 * 60 * 60 * 1000
// A Wednesday, 10:00 in Vietnam
const NOW = Date.parse('2026-10-14T03:00:00Z')

describe('analytics', () => {
  let db: Database
  let service: RewardsService

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new RewardsService(db)
    await service.seedRules()
    await service.createCode('system', { code: 'KRAO-DEV', kind: 'campaign' })
  })

  afterEach(async () => {
    await db.destroy()
  })

  const signUp = (did: string, at: number) =>
    service.recordReferral(did, 'KRAO-DEV', new Date(at).toISOString())
  const verifyPhone = (did: string) =>
    db
      .insertInto('phone_verification')
      .values({
        did,
        phoneHash: `hash-${did}`,
        phoneEnc: 'x',
        verifiedAt: new Date(NOW).toISOString(),
      })
      .execute()
  const steps = (funnel: { steps: { id: string; count: number }[] }) =>
    Object.fromEntries(funnel.steps.map((s) => [s.id, s.count]))

  it('counts the funnel of the accounts that signed up in the window', async () => {
    await signUp('did:a', NOW - 2 * DAY)
    await signUp('did:b', NOW - 3 * DAY)
    await signUp('did:c', NOW - 10 * DAY)
    // Before the default 30 days: out, whatever it did
    await signUp('did:old', NOW - 40 * DAY)
    await verifyPhone('did:a')
    await verifyPhone('did:b')
    await verifyPhone('did:old')
    await service.setKycStatus('test', 'did:b', {
      status: 'approved',
      provider: 'manual',
    })
    // Steps count in any order: a tip without a wallet event still counts
    await service.recordAccountEvent('wallet.linked', 'did:a')
    await service.recordAccountEvent('wallet.linked', 'did:old')
    await service.recordAccountEvent('tip.first', 'did:c')
    // Events of accounts without a sign-up do not count
    await service.recordAccountEvent('wallet.linked', 'did:nobody')

    const funnel = await getFunnel(db, { now: NOW })
    expect(funnel.until).toBe(new Date(NOW).toISOString())
    expect(funnel.since).toBe(new Date(NOW - 30 * DAY).toISOString())
    expect(steps(funnel)).toEqual({
      registered: 3,
      phoneVerified: 2,
      kycApproved: 1,
      walletLinked: 1,
      firstTip: 1,
    })
    expect(funnel.steps.map((s) => s.id)).toEqual([
      'registered',
      'phoneVerified',
      'kycApproved',
      'walletLinked',
      'firstTip',
    ])
    const narrow = await getFunnel(db, {
      since: new Date(NOW - 5 * DAY).toISOString(),
      until: new Date(NOW).toISOString(),
    })
    expect(steps(narrow).registered).toBe(2)
    const empty = await getFunnel(db, {
      since: '2020-01-01T00:00:00Z',
      until: '2020-02-01T00:00:00Z',
    })
    expect(steps(empty)).toEqual({
      registered: 0,
      phoneVerified: 0,
      kycApproved: 0,
      walletLinked: 0,
      firstTip: 0,
    })
  })

  it('counts steps reached before the PDS reported the sign-up', async () => {
    // The PDS reports sign-ups 10-40 seconds late, from its outbox: a phone,
    // a KYC approval or a wallet can come first
    await verifyPhone('did:late')
    await service.setKycStatus('test', 'did:late', {
      status: 'approved',
      provider: 'manual',
    })
    await service.recordAccountEvent('wallet.linked', 'did:late')
    expect(steps(await getFunnel(db, { now: NOW })).registered).toBe(0)
    await signUp('did:late', NOW - DAY)
    expect(steps(await getFunnel(db, { now: NOW }))).toEqual({
      registered: 1,
      phoneVerified: 1,
      kycApproved: 1,
      walletLinked: 1,
      firstTip: 0,
    })
  })

  it('builds weekly cohorts with d1, d7 and d30 windows', async () => {
    // Six weeks back: every window has ended
    const old = NOW - 6 * 7 * DAY
    await signUp('did:a', old)
    await signUp('did:b', old)
    await signUp('did:c', old + DAY)
    const dayA = vnDay(old)
    const dayC = vnDay(old + DAY)
    const active = async (did: string, day: string) =>
      service.recordActivityDay(did, day, { anyDay: true })
    await active('did:a', addDays(dayA, 1)) // d1
    await active('did:a', addDays(dayA, 8)) // d7 (6-8)
    await active('did:a', addDays(dayA, 30)) // d30 (28-32)
    await active('did:b', addDays(dayA, 2)) // nothing
    await active('did:b', addDays(dayA, 9)) // nothing
    await active('did:c', addDays(dayC, 6)) // d7
    await active('did:c', addDays(dayC, 33)) // nothing
    // This week's sign-up: windows still open
    await signUp('did:new', NOW - DAY)

    const { cohorts } = await getRetention(db, { weeks: 8, now: NOW })
    expect(cohorts).toHaveLength(8)
    expect(cohorts.map((c) => c.week)).toEqual(
      [...cohorts.map((c) => c.week)].sort(),
    )
    // Weeks start on Monday (Vietnam time)
    for (const c of cohorts) {
      expect(new Date(`${c.week}T00:00:00Z`).getUTCDay()).toBe(1)
    }
    const oldCohort = cohorts.find((c) => c.size === 3)
    expect(oldCohort).toEqual({
      week: oldCohort!.week,
      size: 3,
      d1: 1,
      d7: 2,
      d30: 1,
    })
    const current = cohorts.at(-1)!
    expect(current).toEqual({ week: current.week, size: 1 })
    // Empty weeks long past still say 0
    expect(cohorts[0]).toEqual({
      week: cohorts[0].week,
      size: 0,
      d1: 0,
      d7: 0,
      d30: 0,
    })
    expect(
      (await getRetention(db, { weeks: 99, now: NOW })).cohorts,
    ).toHaveLength(26)
  })

  it('leaves out windows that have not ended for the whole cohort', async () => {
    // Two weeks back: d1 and d7 are known, d30 is not
    await signUp('did:a', NOW - 14 * DAY)
    const { cohorts } = await getRetention(db, { weeks: 3, now: NOW })
    const cohort = cohorts.find((c) => c.size === 1)!
    expect(cohort.d1).toBe(0)
    expect(cohort.d7).toBe(0)
    expect(cohort.d30).toBeUndefined()
  })

  it('sums up accounts and recent activity, without taken down accounts', async () => {
    await signUp('did:a', NOW - DAY)
    await signUp('did:b', NOW - DAY)
    await signUp('did:c', NOW - DAY)
    await service.takeDown('did:c')
    const today = vnDay(NOW)
    const active = (did: string, day: string) =>
      service.recordActivityDay(did, day, { anyDay: true })
    await active('did:a', today)
    await active('did:a', addDays(today, -3))
    await active('did:b', addDays(today, -6))
    await active('did:x', addDays(today, -20))
    await active('did:y', addDays(today, -30))
    expect(await getSummary(db, { now: NOW })).toEqual({
      accounts: 2,
      activeToday: 1,
      active7d: 2,
      active30d: 3,
    })
  })
})
