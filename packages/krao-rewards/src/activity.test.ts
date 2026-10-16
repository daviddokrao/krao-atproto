import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IdResolver } from '@atproto/identity'
import {
  acceptableDay,
  activeWindow,
  addDays,
  daysBetween,
  isDay,
  vnDay,
} from './activity.js'
import { type Database, createDb, migrateDb } from './db.js'
import { createApp } from './server.js'
import { RewardsService } from './service.js'

const DAY = 24 * 60 * 60 * 1000
const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'

describe('activity days', () => {
  it('uses Vietnam days (UTC+7)', () => {
    expect(vnDay(Date.parse('2026-10-16T16:59:59Z'))).toBe('2026-10-16')
    expect(vnDay(Date.parse('2026-10-16T17:00:00Z'))).toBe('2026-10-17')
    expect(vnDay('2026-12-31T18:00:00.000Z')).toBe('2027-01-01')
  })

  it('checks and moves calendar days', () => {
    expect(isDay('2026-10-16')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-1-01')).toBe(false)
    expect(isDay(20261016)).toBe(false)
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30)
  })

  it('takes days from the day before sign-up to tomorrow', () => {
    const now = Date.parse('2026-10-16T05:00:00Z')
    const createdAt = '2026-10-10T05:00:00.000Z'
    expect(acceptableDay('2026-10-17', { now, createdAt })).toBe(true)
    expect(acceptableDay('2026-10-18', { now, createdAt })).toBe(false)
    expect(acceptableDay('2026-10-09', { now, createdAt })).toBe(true)
    expect(acceptableDay('2026-10-08', { now, createdAt })).toBe(false)
    // Without a sign-up only the future is out
    expect(acceptableDay('2020-01-01', { now })).toBe(true)
  })

  it('counts 30 days from the sign-up day', () => {
    expect(activeWindow('2026-10-01T18:00:00.000Z')).toEqual({
      first: '2026-10-02',
      last: '2026-10-31',
    })
  })
})

describe('active.30d', () => {
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

  /** Signs up `did` `daysAgo` days ago; resolves to its sign-up day */
  const signUp = async (did: string, daysAgo: number) => {
    const createdAt = new Date(Date.now() - daysAgo * DAY).toISOString()
    await service.recordReferral(did, 'KRAO-DEV', createdAt)
    return vnDay(createdAt)
  }
  const activeEntries = async (did: string) =>
    (await service.listEntries(did, 50)).entries.filter(
      (e) => e.ruleId === 'growth.active-30d',
    )

  it('seeds the M33 rules, the referrer ones disabled', async () => {
    const rules = new Map((await service.listRules()).map((r) => [r.id, r]))
    expect(rules.get('growth.community-joined')).toMatchObject({
      enabled: true,
      event: 'community.joined',
      beneficiary: 'actor',
      amount: 10,
      vesting: ['kyc:self'],
      capPerDay: 1,
    })
    expect(rules.get('growth.active-30d')).toMatchObject({
      enabled: true,
      event: 'active.30d',
      amount: 50,
      vesting: ['kyc:self'],
      capPerDay: 1,
    })
    for (const id of [
      'growth.community-joined.referrer',
      'growth.active-30d.referrer',
    ]) {
      expect(rules.get(id)).toMatchObject({
        enabled: false,
        beneficiary: 'referrer',
        capPerDay: 20,
      })
    }
  })

  it('rewards a first community once', async () => {
    await service.recordAccountEvent('community.joined', ALICE)
    await service.recordAccountEvent('community.joined', ALICE)
    const entries = (await service.listEntries(ALICE, 50)).entries
    expect(
      entries.filter((e) => e.ruleId === 'growth.community-joined'),
    ).toEqual([expect.objectContaining({ amount: 10, status: 'pending' })])
    await expect(
      service.recordAccountEvent('active.30d', ALICE),
    ).rejects.toThrow(/Unknown event/)
  })

  it('rewards 20 active days of the first 30, once', async () => {
    const first = await signUp(ALICE, 40)
    for (let i = 0; i < 19; i++) {
      expect(await service.recordActivityDay(ALICE, addDays(first, i))).toBe(
        true,
      )
    }
    // The same day twice is one day
    await service.recordActivityDay(ALICE, addDays(first, 18))
    expect(await activeEntries(ALICE)).toEqual([])
    await service.recordActivityDay(ALICE, addDays(first, 29))
    const [entry] = await activeEntries(ALICE)
    expect(entry).toMatchObject({
      amount: 50,
      status: 'pending',
      waitingFor: ['kyc:self'],
    })
    await service.recordActivityDay(ALICE, addDays(first, 25))
    expect(await activeEntries(ALICE)).toHaveLength(1)
  })

  it('does not count days after the first 30', async () => {
    const first = await signUp(ALICE, 60)
    for (let i = 0; i < 19; i++) {
      await service.recordActivityDay(ALICE, addDays(first, i))
    }
    // Day 31 and later: kept (for the analytics), not counted
    for (let i = 30; i < 35; i++) {
      await service.recordActivityDay(ALICE, addDays(first, i))
    }
    expect(await activeEntries(ALICE)).toEqual([])
  })

  it('never rewards accounts without a sign-up event', async () => {
    const today = vnDay(Date.now())
    for (let i = 0; i < 25; i++) {
      await service.recordActivityDay(BOB, addDays(today, -i))
    }
    expect(await activeEntries(BOB)).toEqual([])
    expect(
      await db
        .selectFrom('activity_day')
        .selectAll()
        .where('did', '=', BOB)
        .execute(),
    ).toHaveLength(25)
  })

  it('ignores days out of range unless told any day goes', async () => {
    const first = await signUp(ALICE, 0)
    expect(await service.recordActivityDay(ALICE, addDays(first, -5))).toBe(
      false,
    )
    expect(await service.recordActivityDay(ALICE, addDays(first, 5))).toBe(
      false,
    )
    expect(
      await service.recordActivityDay(ALICE, addDays(first, -5), {
        anyDay: true,
      }),
    ).toBe(true)
    await expect(service.recordActivityDay(ALICE, 'yesterday')).rejects.toThrow(
      /YYYY-MM-DD/,
    )
  })

  it('ignores taken down accounts and forgets deleted ones', async () => {
    const first = await signUp(ALICE, 0)
    await service.recordActivityDay(ALICE, first)
    await service.takeDown(ALICE)
    expect(await service.recordActivityDay(ALICE, addDays(first, 1))).toBe(
      false,
    )
    await service.liftTakedown(ALICE)
    await service.accountDeleted(ALICE)
    expect(await db.selectFrom('activity_day').selectAll().execute()).toEqual(
      [],
    )
  })

  it('moves a sign-up back (dev), so a month can be played', async () => {
    const today = await signUp(ALICE, 0)
    const moved = await service.backdateAccount(ALICE, 40)
    expect(vnDay(moved!)).toBe(addDays(today, -40))
    const referral = await db
      .selectFrom('referral')
      .select('createdAt')
      .where('did', '=', ALICE)
      .executeTakeFirstOrThrow()
    expect(vnDay(referral.createdAt)).toBe(addDays(today, -40))
    expect(await service.backdateAccount(BOB, 40)).toBeUndefined()
    for (let i = 0; i < 20; i++) {
      await service.recordActivityDay(ALICE, addDays(today, i - 40))
    }
    expect(await activeEntries(ALICE)).toHaveLength(1)
  })

  it('counts activity days in the data export', async () => {
    const { exportRewardsData } = await import('./account.js')
    const first = await signUp(ALICE, 3)
    await service.recordActivityDay(ALICE, first)
    await service.recordActivityDay(ALICE, addDays(first, 1))
    const data = (await exportRewardsData(service, null, ALICE)) as {
      activityDays: number
    }
    expect(data.activityDays).toBe(2)
  })
})

describe('dev routes', () => {
  let db: Database
  let service: RewardsService
  let server: http.Server
  let base: string
  const TOKEN = 'internal-token-for-tests-0123456789'

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new RewardsService(db)
    await service.seedRules()
    await service.createCode('system', { code: 'KRAO-DEV', kind: 'campaign' })
    const app = createApp({
      service,
      idResolver: {} as IdResolver,
      serviceDid: 'did:web:rewards.test',
      internalToken: TOKEN,
      adminDids: new Set(),
      kycReviewerDids: new Set(),
      kycProvider: null,
      manualReview: { dailyLimit: 10, requireSecondApprover: false },
      phone: null,
      devMode: true,
    })
    server = app.listen(0)
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    await db.destroy()
  })

  const post = (path: string, body: unknown, token = TOKEN) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  it('backdates sign-ups and takes any day', async () => {
    const createdAt = new Date().toISOString()
    await service.recordReferral(ALICE, 'KRAO-DEV', createdAt)
    const res = await post('/internal/dev/backdate-account', {
      did: ALICE,
      days: 40,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { createdAt: string }
    const first = vnDay(body.createdAt)
    expect(first).toBe(addDays(vnDay(createdAt), -40))
    for (let i = 0; i < 20; i++) {
      const day = await post('/internal/events', {
        type: 'activity.day',
        did: ALICE,
        day: addDays(first, i),
      })
      expect(await day.json()).toEqual({ ok: true })
    }
    const { entries } = await service.listEntries(ALICE, 50)
    expect(entries.map((e) => e.ruleId).sort()).toEqual([
      'growth.active-30d',
      'referral.invitee',
    ])
    expect(
      (await post('/internal/dev/backdate-account', { did: BOB, days: 1 }))
        .status,
    ).toBe(404)
    expect(
      (await post('/internal/dev/backdate-account', { did: ALICE, days: -1 }))
        .status,
    ).toBe(400)
    expect(
      (
        await post(
          '/internal/dev/backdate-account',
          { did: ALICE, days: 1 },
          'wrong',
        )
      ).status,
    ).toBe(401)
  })
})
