import type { Database } from './db.js'

/*
 * The "human" badge: the account verified a phone number or passed KYC, and
 * chose to show it. Which of the two is never disclosed, and accounts taken
 * down lose the badge while they are.
 */

export type BadgeVisibility = { human: boolean; eligible: boolean }

/** Of `dids`, those that verified a phone or passed KYC and are not taken down */
async function eligibleDids(
  db: Database,
  dids: string[],
): Promise<Set<string>> {
  if (!dids.length) return new Set()
  const rows = await db
    .selectFrom('phone_verification')
    .select('did')
    .where('did', 'in', dids)
    .union(
      db
        .selectFrom('kyc_record')
        .select('did')
        .where('did', 'in', dids)
        .where('status', '=', 'approved'),
    )
    .execute()
  const eligible = new Set(rows.map((r) => r.did))
  if (!eligible.size) return eligible
  const takenDown = await db
    .selectFrom('taken_down')
    .select('did')
    .where('did', 'in', [...eligible])
    .execute()
  for (const { did } of takenDown) eligible.delete(did)
  return eligible
}

export async function getBadgeVisibility(
  db: Database,
  did: string,
): Promise<BadgeVisibility> {
  const [pref, eligible] = await Promise.all([
    db
      .selectFrom('badge_pref')
      .select('human')
      .where('did', '=', did)
      .executeTakeFirst(),
    eligibleDids(db, [did]),
  ])
  return { human: !!pref?.human, eligible: eligible.has(did) }
}

export async function setBadgeVisibility(
  db: Database,
  did: string,
  human: boolean,
): Promise<BadgeVisibility> {
  const updatedAt = new Date().toISOString()
  await db
    .insertInto('badge_pref')
    .values({ did, human: human ? 1 : 0, updatedAt })
    .onConflict((oc) =>
      oc.column('did').doUpdateSet({ human: human ? 1 : 0, updatedAt }),
    )
    .execute()
  return getBadgeVisibility(db, did)
}

/** Of `dids`, those that show the "human" badge */
export async function humanDids(
  db: Database,
  dids: string[],
): Promise<Set<string>> {
  const unique = [...new Set(dids)]
  if (!unique.length) return new Set()
  const shown = await db
    .selectFrom('badge_pref')
    .select('did')
    .where('did', 'in', unique)
    .where('human', '=', 1)
    .execute()
  return eligibleDids(
    db,
    shown.map((r) => r.did),
  )
}
