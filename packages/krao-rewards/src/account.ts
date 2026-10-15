import type { Database } from './db.js'
import type { PhoneService } from './phone.js'
import { RewardsError, type RewardsService } from './service.js'

/*
 * Consent records and the personal data export (Decree 13 on personal data:
 * consent per kind of data, and a copy of one's data on request).
 */

export const CONSENT_ITEMS = ['terms', 'privacy', 'kyc', 'phone', 'wallet']

export type ConsentView = {
  version: string
  items: string[]
  createdAt: string
}

export async function recordConsent(
  db: Database,
  did: string,
  version: string,
  items: string[],
): Promise<ConsentView> {
  const unique = [...new Set(items)]
  const unknown = unique.filter((item) => !CONSENT_ITEMS.includes(item))
  if (!unique.length || unknown.length) {
    throw new RewardsError(
      'InvalidRequest',
      `Consent items must be among: ${CONSENT_ITEMS.join(', ')}`,
    )
  }
  if (!version.trim()) {
    throw new RewardsError('InvalidRequest', 'A version is required')
  }
  const row = {
    did,
    version: version.trim(),
    items: JSON.stringify(unique),
    createdAt: new Date().toISOString(),
  }
  await db.insertInto('consent_record').values(row).execute()
  return { version: row.version, items: unique, createdAt: row.createdAt }
}

export async function listConsents(
  db: Database,
  did: string,
): Promise<ConsentView[]> {
  const rows = await db
    .selectFrom('consent_record')
    .selectAll()
    .where('did', '=', did)
    .orderBy('id', 'desc')
    .limit(200)
    .execute()
  return rows.map((r) => ({
    version: r.version,
    items: JSON.parse(r.items) as string[],
    createdAt: r.createdAt,
  }))
}

/** What the push service holds: devices, by platform only (no tokens) */
export type PushDevices = { count: number; platforms: Record<string, number> }

/**
 * Everything the rewards service holds about an account: its code and who
 * invited it, whom it invited (DIDs), its points, its KYC outcome (no
 * documents: they stay with the provider), its phone (masked) and consents.
 */
export async function exportRewardsData(
  service: RewardsService,
  phone: PhoneService | null,
  did: string,
  pushDevices?: () => Promise<PushDevices | null>,
) {
  const { db } = service
  const [code, invitedBy, referrals, entries, kyc, phoneStatus, consents] =
    await Promise.all([
      db
        .selectFrom('referral_code')
        .select(['code', 'createdAt'])
        .where('ownerDid', '=', did)
        .where('kind', '=', 'personal')
        .executeTakeFirst(),
      db
        .selectFrom('referral')
        .select(['code', 'referrerDid', 'createdAt'])
        .where('did', '=', did)
        .executeTakeFirst(),
      db
        .selectFrom('referral')
        .select(['did', 'createdAt'])
        .where('referrerDid', '=', did)
        .orderBy('createdAt', 'desc')
        .limit(10_000)
        .execute(),
      db
        .selectFrom('points_entry')
        .select([
          'id',
          'amount',
          'status',
          'ruleId',
          'relatedDid',
          'note',
          'createdAt',
          'decidedAt',
        ])
        .where('did', '=', did)
        .orderBy('id', 'desc')
        .limit(10_000)
        .execute(),
      service.kycRecord(did),
      phone ? phone.status(did) : Promise.resolve(null),
      listConsents(db, did),
    ])
  return withoutEmpty({
    referralCode: code?.code ?? null,
    signedUpWith: invitedBy
      ? {
          code: invitedBy.code,
          invitedBy: invitedBy.referrerDid,
          at: invitedBy.createdAt,
        }
      : null,
    referrals: referrals.map((r) => ({ did: r.did, joinedAt: r.createdAt })),
    points: {
      balance: await service.balance(did),
      entries,
    },
    kyc: kyc
      ? { status: kyc.status, provider: kyc.provider, updatedAt: kyc.updatedAt }
      : { status: 'none' },
    phone: phoneStatus ?? { verified: false },
    consents,
    pushDevices: pushDevices ? await pushDevices().catch(() => null) : null,
  })
}

/** Drops null and undefined values, which lexicon data leaves out */
export function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmpty)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, withoutEmpty(v)]),
    )
  }
  return value
}
