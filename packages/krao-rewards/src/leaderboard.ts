import { sql } from 'kysely'
import type { Database } from './db.js'

/*
 * The weekly leaderboard (M32): points earned during the current week by
 * accounts that chose to appear on it. Off by default; only accounts that
 * opted in are listed and ranked. What counts is the week's points, not an
 * account's balance: entries created in the week that are not void (pending
 * ones included, reversals and adjustments subtracting). Accounts taken
 * down or deleted are left out.
 *
 * Weeks are ISO weeks (Monday to Monday) in Vietnam's time
 * (Asia/Ho_Chi_Minh, UTC+7 all year: no daylight saving), so a week starts
 * on Sunday at 17:00 UTC.
 */

/** Asia/Ho_Chi_Minh is UTC+7 all year */
export const LEADERBOARD_UTC_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
export const LEADERBOARD_MAX_LIMIT = 50

export type Period = { start: string; end: string }

/** The ISO week (Monday 00:00 to the next Monday, UTC+7) holding `at` */
export function weekPeriod(at: number | Date = Date.now()): Period {
  const local = new Date(+at + LEADERBOARD_UTC_OFFSET_MS)
  const sinceMonday = (local.getUTCDay() + 6) % 7
  const mondayLocal = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - sinceMonday,
  )
  const start = mondayLocal - LEADERBOARD_UTC_OFFSET_MS
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + 7 * DAY_MS).toISOString(),
  }
}

export type LeaderboardEntry = { did: string; points: number; rank: number }

/**
 * Ranks rows sorted by points, best first: equal points share a rank, and
 * the next rank counts everyone above (1, 2, 2, 4)
 */
export function rank(
  rows: { did: string; points: number }[],
): LeaderboardEntry[] {
  const ranked: LeaderboardEntry[] = []
  for (const [i, row] of rows.entries()) {
    const prev = ranked[i - 1]
    ranked.push({
      ...row,
      rank: prev && prev.points === row.points ? prev.rank : i + 1,
    })
  }
  return ranked
}

/** Points each opted-in account earned in `period`, best first (above 0 only) */
async function rankedWeek(db: Database, period: Period) {
  const rows = await db
    .selectFrom('points_entry')
    .innerJoin('leaderboard_pref', 'leaderboard_pref.did', 'points_entry.did')
    .select([
      'points_entry.did as did',
      (eb) => eb.fn.sum<number>('points_entry.amount').as('points'),
    ])
    .where('leaderboard_pref.optIn', '=', 1)
    .where('points_entry.status', '!=', 'void')
    .where('points_entry.createdAt', '>=', period.start)
    .where('points_entry.createdAt', '<', period.end)
    .where(
      sql<boolean>`${sql.ref('points_entry.did')} not in (select did from taken_down)`,
    )
    .groupBy('points_entry.did')
    .having((eb) => eb.fn.sum('points_entry.amount'), '>', 0)
    .orderBy('points', 'desc')
    .orderBy('did', 'asc')
    .execute()
  return rank(rows.map((r) => ({ did: r.did, points: Number(r.points) })))
}

/** Points `did` earned in `period` */
async function weekPoints(db: Database, did: string, period: Period) {
  const row = await db
    .selectFrom('points_entry')
    .select((eb) => eb.fn.sum<number>('amount').as('points'))
    .where('did', '=', did)
    .where('status', '!=', 'void')
    .where('createdAt', '>=', period.start)
    .where('createdAt', '<', period.end)
    .executeTakeFirst()
  return Number(row?.points ?? 0)
}

export async function getOptIn(db: Database, did: string): Promise<boolean> {
  const row = await db
    .selectFrom('leaderboard_pref')
    .select('optIn')
    .where('did', '=', did)
    .executeTakeFirst()
  return !!row?.optIn
}

export async function setOptIn(
  db: Database,
  did: string,
  optIn: boolean,
): Promise<{ optIn: boolean }> {
  const updatedAt = new Date().toISOString()
  await db
    .insertInto('leaderboard_pref')
    .values({ did, optIn: optIn ? 1 : 0, updatedAt })
    .onConflict((oc) =>
      oc.column('did').doUpdateSet({ optIn: optIn ? 1 : 0, updatedAt }),
    )
    .execute()
  return { optIn }
}

export type Leaderboard = {
  period: Period
  entries: LeaderboardEntry[]
  viewer?: { optedIn: boolean; rank?: number; points: number }
}

/**
 * This week's leaderboard: the first `limit` opted-in accounts, and where
 * the viewer (when known) stands. A viewer that did not opt in sees its own
 * points for the week, but no rank.
 */
export async function getLeaderboard(
  db: Database,
  opts: { limit: number; viewer?: string; now?: number },
): Promise<Leaderboard> {
  const period = weekPeriod(opts.now ?? Date.now())
  const limit = Math.min(Math.max(opts.limit, 1), LEADERBOARD_MAX_LIMIT)
  const ranked = await rankedWeek(db, period)
  const result: Leaderboard = { period, entries: ranked.slice(0, limit) }
  if (opts.viewer) {
    const viewer = opts.viewer
    const optedIn = await getOptIn(db, viewer)
    const mine = optedIn ? ranked.find((e) => e.did === viewer) : undefined
    result.viewer = mine
      ? { optedIn, rank: mine.rank, points: mine.points }
      : { optedIn, points: await weekPoints(db, viewer, period) }
  }
  return result
}
