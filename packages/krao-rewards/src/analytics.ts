import { sql } from 'kysely'
import { addDays, vnDay } from './activity.js'
import type { Database } from './db.js'
import { weekPeriod } from './leaderboard.js'

/*
 * Krao's own analytics (M33): aggregate numbers for the rewards admins,
 * computed from what the rewards service already holds. Accounts are the
 * ones that signed up (their account.created event, which every sign-up
 * with a referral code has); steps come from phone verification, KYC and
 * the events the indexer reports (wallet.linked, tip.first). Activity is the
 * activity days the indexer reports (see activity.ts). Only counts leave
 * this file: never a DID.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const FUNNEL_DEFAULT_DAYS = 30
export const RETENTION_MAX_WEEKS = 26

export type FunnelStepId =
  'registered' | 'phoneVerified' | 'kycApproved' | 'walletLinked' | 'firstTip'

export type Funnel = {
  since: string
  until: string
  steps: { id: FunnelStepId; count: number }[]
}

/**
 * Of the accounts that signed up from `since` to `until` (default: the last
 * 30 days), how many reached each step, whenever and in whatever order
 */
export async function getFunnel(
  db: Database,
  opts: { since?: string; until?: string; now?: number } = {},
): Promise<Funnel> {
  const now = opts.now ?? Date.now()
  const until = new Date(opts.until ?? now).toISOString()
  const since = new Date(
    opts.since ?? Date.parse(until) - FUNNEL_DEFAULT_DAYS * DAY_MS,
  ).toISOString()
  const { rows } = await sql<{
    registered: number
    phoneVerified: number | null
    kycApproved: number | null
    walletLinked: number | null
    firstTip: number | null
  }>`select count(*) as registered,
      sum(exists (select 1 from phone_verification p where p.did = e.actorDid)) as phoneVerified,
      sum(exists (select 1 from kyc_record k where k.did = e.actorDid and k.status = 'approved')) as kycApproved,
      sum(exists (select 1 from reward_event w where w.id = 'wallet.linked:' || e.actorDid)) as walletLinked,
      sum(exists (select 1 from reward_event t where t.id = 'tip.first:' || e.actorDid)) as firstTip
    from reward_event e
    where e.type = 'account.created' and e.createdAt >= ${since} and e.createdAt <= ${until}`.execute(
    db,
  )
  const row = rows[0]
  const count = (n: number | null | undefined) => Number(n ?? 0)
  return {
    since,
    until,
    steps: [
      { id: 'registered', count: count(row?.registered) },
      { id: 'phoneVerified', count: count(row?.phoneVerified) },
      { id: 'kycApproved', count: count(row?.kycApproved) },
      { id: 'walletLinked', count: count(row?.walletLinked) },
      { id: 'firstTip', count: count(row?.firstTip) },
    ],
  }
}

/**
 * Retention windows, in days after the sign-up day (Vietnam time): an
 * account counts for dN when it was active on any day of the window
 */
export const RETENTION_WINDOWS = {
  d1: [1, 1],
  d7: [6, 8],
  d30: [28, 32],
} as const

type WindowId = keyof typeof RETENTION_WINDOWS

export type Cohort = {
  week: string
  size: number
  d1?: number
  d7?: number
  d30?: number
}

/**
 * Cohorts of the last `weeks` sign-up weeks (Monday to Monday, Vietnam time,
 * the current week included), the oldest first. A window's count is left out
 * until it has ended for every account the cohort can hold (its last day is
 * before today), so a cohort's numbers only ever get added, never change.
 */
export async function getRetention(
  db: Database,
  opts: { weeks?: number; now?: number } = {},
): Promise<{ cohorts: Cohort[] }> {
  const now = opts.now ?? Date.now()
  const weeks = Math.min(Math.max(opts.weeks ?? 8, 1), RETENTION_MAX_WEEKS)
  const current = Date.parse(weekPeriod(now).start)
  const starts = Array.from(
    { length: weeks },
    (_, i) => current - (weeks - 1 - i) * 7 * DAY_MS,
  )
  const accounts = await db
    .selectFrom('reward_event')
    .select(['actorDid', 'createdAt'])
    .where('type', '=', 'account.created')
    .where('createdAt', '>=', new Date(starts[0]).toISOString())
    .where('createdAt', '<', new Date(current + 7 * DAY_MS).toISOString())
    .execute()
  const signUpDay = new Map(
    accounts.map((a) => [a.actorDid, vnDay(a.createdAt)]),
  )
  const active = new Map<string, Set<string>>()
  const dids = [...signUpDay.keys()]
  for (let i = 0; i < dids.length; i += 500) {
    const batch = dids.slice(i, i + 500)
    const rows = await db
      .selectFrom('activity_day')
      .select(['did', 'day'])
      .where('did', 'in', batch)
      .where('day', '>=', vnDay(starts[0]))
      .execute()
    for (const row of rows) {
      const days = active.get(row.did) ?? new Set<string>()
      days.add(row.day)
      active.set(row.did, days)
    }
  }
  const today = vnDay(now)
  const cohorts: Cohort[] = starts.map((start) => {
    // The week's Monday, as a Vietnamese date
    const week = vnDay(start)
    const members = dids.filter((did) => {
      const day = signUpDay.get(did)!
      return day >= week && day <= addDays(week, 6)
    })
    const cohort: Cohort = { week, size: members.length }
    for (const id of Object.keys(RETENTION_WINDOWS) as WindowId[]) {
      const [from, to] = RETENTION_WINDOWS[id]
      // The cohort's last sign-up day is the Sunday
      if (addDays(week, 6 + to) >= today) continue
      cohort[id] = members.filter((did) => {
        const day = signUpDay.get(did)!
        const days = active.get(did)
        if (!days) return false
        for (let n = from; n <= to; n++) {
          if (days.has(addDays(day, n))) return true
        }
        return false
      }).length
    }
    return cohort
  })
  return { cohorts }
}

export type Summary = {
  accounts: number
  activeToday: number
  active7d: number
  active30d: number
}

/**
 * Accounts that signed up and are neither taken down nor deleted, and
 * accounts active today, over the last 7 and the last 30 days (Vietnam
 * days, today included)
 */
export async function getSummary(
  db: Database,
  opts: { now?: number } = {},
): Promise<Summary> {
  const today = vnDay(opts.now ?? Date.now())
  const accounts = await db
    .selectFrom('reward_event')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('type', '=', 'account.created')
    .where('actorDid', 'not in', (eb) =>
      eb.selectFrom('taken_down').select('did'),
    )
    .executeTakeFirst()
  const activeSince = async (days: number) => {
    const row = await db
      .selectFrom('activity_day')
      .select(sql<number>`count(distinct did)`.as('count'))
      .where('day', '>=', addDays(today, 1 - days))
      .where('day', '<=', today)
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }
  return {
    accounts: Number(accounts?.count ?? 0),
    activeToday: await activeSince(1),
    active7d: await activeSince(7),
    active30d: await activeSince(30),
  }
}
