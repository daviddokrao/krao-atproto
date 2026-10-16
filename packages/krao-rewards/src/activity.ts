import type { Kysely } from 'kysely'
import type { DatabaseSchema } from './db.js'
import { LEADERBOARD_UTC_OFFSET_MS } from './leaderboard.js'

/*
 * Activity days (M33): the indexer reports each day (in Vietnam's time,
 * UTC+7 all year) an account created a record it saw: a post, reply, like,
 * repost, follow, vote... Days feed the "active 30 days" reward (active on
 * at least 20 of the 30 days from the account's sign-up, its account.created
 * event) and the retention and activity numbers of the analytics.
 */

/** Days of the window that counts for active.30d, the sign-up day first */
export const ACTIVE_WINDOW_DAYS = 30
/** Days within the window an account must have been active on */
export const ACTIVE_MIN_DAYS = 20

const DAY_MS = 24 * 60 * 60 * 1000
const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/** The day (YYYY-MM-DD, Vietnam time) holding the instant `at` */
export function vnDay(at: number | string | Date): string {
  const ms = typeof at === 'number' ? at : +new Date(at)
  return new Date(ms + LEADERBOARD_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/** Whether `day` is a real calendar day written YYYY-MM-DD */
export function isDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false
  const ms = Date.parse(`${day}T00:00:00Z`)
  return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day
}

/** `day` moved by `days` (negative: back) */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10)
}

/** Days from `from` to `to` (negative when `to` is earlier) */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  )
}

/** When the account signed up (its account.created event), if it did */
export async function accountCreatedAt(
  db: Kysely<DatabaseSchema>,
  did: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('reward_event')
    .select('createdAt')
    .where('id', '=', `account.created:${did}`)
    .executeTakeFirst()
  return row?.createdAt
}

/**
 * Whether the indexer may report `day` for an account: not after tomorrow,
 * and not before the day before its sign-up (when it signed up). Days
 * around the edges allow for clocks and time zones.
 */
export function acceptableDay(
  day: string,
  opts: { now: number; createdAt?: string },
): boolean {
  if (day > addDays(vnDay(opts.now), 1)) return false
  if (opts.createdAt && day < addDays(vnDay(opts.createdAt), -1)) return false
  return true
}

/** The first and last day of the account's active.30d window */
export function activeWindow(createdAt: string): {
  first: string
  last: string
} {
  const first = vnDay(createdAt)
  return { first, last: addDays(first, ACTIVE_WINDOW_DAYS - 1) }
}

/** Distinct days the account was active on within its active.30d window */
export async function activeDaysInWindow(
  db: Kysely<DatabaseSchema>,
  did: string,
  createdAt: string,
): Promise<number> {
  const { first, last } = activeWindow(createdAt)
  const row = await db
    .selectFrom('activity_day')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('did', '=', did)
    .where('day', '>=', first)
    .where('day', '<=', last)
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}
