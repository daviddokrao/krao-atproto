import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import { getLeaderboard, rank, setOptIn, weekPeriod } from './leaderboard.js'
import { RewardsService } from './service.js'

describe('weekPeriod', () => {
  it('starts weeks on Monday 00:00 in Vietnam (Sunday 17:00 UTC)', () => {
    // Wednesday 2026-10-14, noon UTC
    expect(weekPeriod(Date.parse('2026-10-14T12:00:00Z'))).toEqual({
      start: '2026-10-11T17:00:00.000Z',
      end: '2026-10-18T17:00:00.000Z',
    })
  })

  it('puts Sunday evening UTC in the next Vietnamese week', () => {
    // 2026-10-18 17:30 UTC is Monday 00:30 in Vietnam
    expect(weekPeriod(Date.parse('2026-10-18T17:30:00Z')).start).toBe(
      '2026-10-18T17:00:00.000Z',
    )
    // 16:59 UTC is still Sunday there
    expect(weekPeriod(Date.parse('2026-10-18T16:59:59Z')).start).toBe(
      '2026-10-11T17:00:00.000Z',
    )
  })

  it('handles the boundary itself and year ends', () => {
    expect(weekPeriod(Date.parse('2026-10-11T17:00:00Z')).start).toBe(
      '2026-10-11T17:00:00.000Z',
    )
    // Friday 2027-01-01 in Vietnam: ISO week from Monday 2026-12-28
    expect(weekPeriod(Date.parse('2026-12-31T20:00:00Z'))).toEqual({
      start: '2026-12-27T17:00:00.000Z',
      end: '2027-01-03T17:00:00.000Z',
    })
  })
})

describe('rank', () => {
  it('shares ranks between equal points and skips after them', () => {
    expect(
      rank([
        { did: 'a', points: 30 },
        { did: 'b', points: 20 },
        { did: 'c', points: 20 },
        { did: 'd', points: 5 },
      ]).map((e) => e.rank),
    ).toEqual([1, 2, 2, 4])
  })
})

describe('getLeaderboard', () => {
  let db: Database
  let service: RewardsService
  const ADMIN = 'did:plc:admin'

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new RewardsService(db)
    await service.seedRules()
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('lists and ranks only accounts that opted in', async () => {
    await service.adjustPoints(ADMIN, 'did:plc:a', 30, 'test')
    await service.adjustPoints(ADMIN, 'did:plc:b', 50, 'test')
    await service.adjustPoints(ADMIN, 'did:plc:c', 40, 'test')
    await setOptIn(db, 'did:plc:a', true)
    await setOptIn(db, 'did:plc:c', true)
    const board = await getLeaderboard(db, { limit: 10, viewer: 'did:plc:b' })
    expect(board.entries).toEqual([
      { did: 'did:plc:c', points: 40, rank: 1 },
      { did: 'did:plc:a', points: 30, rank: 2 },
    ])
    // B has more points but did not opt in: no rank, own points only
    expect(board.viewer).toEqual({ optedIn: false, points: 50 })
    const a = await getLeaderboard(db, { limit: 1, viewer: 'did:plc:a' })
    expect(a.entries).toHaveLength(1)
    expect(a.viewer).toEqual({ optedIn: true, rank: 2, points: 30 })
  })

  it('counts only this week, nets reversals, and drops taken down accounts', async () => {
    await service.adjustPoints(ADMIN, 'did:plc:a', 30, 'test')
    await service.adjustPoints(ADMIN, 'did:plc:a', -10, 'test')
    await service.adjustPoints(ADMIN, 'did:plc:b', 10, 'test')
    await setOptIn(db, 'did:plc:a', true)
    await setOptIn(db, 'did:plc:b', true)
    await setOptIn(db, 'did:plc:c', true)
    // Last week's points do not count
    await db
      .updateTable('points_entry')
      .set({ createdAt: '2020-01-01T00:00:00.000Z' })
      .where('did', '=', 'did:plc:b')
      .execute()
    let board = await getLeaderboard(db, { limit: 10 })
    expect(board.entries).toEqual([{ did: 'did:plc:a', points: 20, rank: 1 }])
    expect(board.viewer).toBeUndefined()
    await service.takeDown('did:plc:a')
    board = await getLeaderboard(db, { limit: 10 })
    expect(board.entries).toEqual([])
  })

  it('opting out takes the account off; deleting the account forgets it', async () => {
    await service.adjustPoints(ADMIN, 'did:plc:a', 30, 'test')
    await setOptIn(db, 'did:plc:a', true)
    await setOptIn(db, 'did:plc:a', false)
    expect((await getLeaderboard(db, { limit: 10 })).entries).toEqual([])
    await setOptIn(db, 'did:plc:a', true)
    await service.accountDeleted('did:plc:a')
    expect(
      await db.selectFrom('leaderboard_pref').selectAll().execute(),
    ).toEqual([])
  })
})
