import SqliteDB from 'better-sqlite3'
import { type Generated, Kysely, SqliteDialect, sql } from 'kysely'
import { runMigrations } from './migrate.js'

export type CodeKind = 'personal' | 'campaign' | 'partner'
export type KycStatus = 'none' | 'pending' | 'retry' | 'approved' | 'rejected'
export type EntryStatus = 'pending' | 'approved' | 'void'
/** Conditions for a ledger entry to be approved */
export type Vesting = 'kyc:self' | 'kyc:related'
export type RewardEvent =
  | 'account.created'
  | 'kyc.approved'
  /** The account's first verified wallet (reported by the indexer) */
  | 'wallet.linked'
  /** The account's first post (reported by the indexer) */
  | 'post.first'
export const REWARD_EVENTS: RewardEvent[] = [
  'account.created',
  'kyc.approved',
  'wallet.linked',
  'post.first',
]
/** Events the indexer reports at /internal/events, once per account */
export const ACCOUNT_EVENTS: RewardEvent[] = ['wallet.linked', 'post.first']
/** Referral rewards are one level only (no referrer's referrer) */
export type Beneficiary = 'actor' | 'referrer'

export interface ReferralCodeTable {
  /** Upper case */
  code: string
  kind: CodeKind
  /** Credited as the referrer of sign-ups with the code */
  ownerDid: string | null
  campaignId: string | null
  maxUses: number | null
  expiresAt: string | null
  disabled: number
  note: string | null
  createdBy: string
  createdAt: string
}

/** Who referred an account: one row per account that signed up with a code */
export interface ReferralTable {
  did: string
  code: string
  referrerDid: string | null
  /** The referrer's own referrer, for second level rewards */
  referrer2Did: string | null
  codeKind: CodeKind | null
  campaignId: string | null
  /** 'invalid_code' or 'over_limit' when the code no longer allowed it */
  flag: string | null
  createdAt: string
}

export interface KycRecordTable {
  did: string
  status: KycStatus
  provider: string | null
  /** The provider's id for the person (eg a Sumsub applicant id) */
  providerRef: string | null
  rejectReason: string | null
  updatedAt: string
}

/** Manual KYC decisions by admins */
export interface KycReviewTable {
  id: Generated<number>
  did: string
  reviewerDid: string
  decision: 'approve' | 'reject'
  reasonCode: string
  note: string
  /** 1 once applied (an approval may wait for a second reviewer) */
  applied: number
  createdAt: string
}

export interface RewardRuleTable {
  id: string
  version: number
  enabled: number
  description: string | null
  event: RewardEvent
  beneficiary: Beneficiary
  amount: number
  /** JSON Vesting[] */
  vesting: string
  /** JSON CodeKind[]; empty means any */
  codeKinds: string
  campaignId: string | null
  validFrom: string | null
  validUntil: string | null
  capPerBeneficiary: number | null
  capPerDay: number | null
  updatedAt: string
  updatedBy: string
}

/** Events the rules ran on, kept so rules can be audited and replayed */
export interface RewardEventTable {
  id: string
  type: RewardEvent
  actorDid: string
  /** JSON */
  data: string
  createdAt: string
}

export interface PointsEntryTable {
  /** Time-ordered */
  id: string
  did: string
  amount: number
  status: EntryStatus
  ruleId: string | null
  ruleVersion: number | null
  eventId: string | null
  relatedDid: string | null
  /** JSON Vesting[] */
  vesting: string
  note: string | null
  /** Unique: the same reward is never given twice */
  idempotencyKey: string
  createdAt: string
  decidedAt: string | null
}

/** Accounts taken down by moderators: they earn nothing while listed */
export interface TakenDownTable {
  did: string
  createdAt: string
}

export interface AuditLogTable {
  id: Generated<number>
  /** Admin DID, or 'system' */
  actor: string
  action: string
  subject: string | null
  /** JSON */
  data: string | null
  createdAt: string
}

/** An account's verified phone number (see phone.ts); one account per number */
export interface PhoneVerificationTable {
  did: string
  /** HMAC of the E.164 number: unique */
  phoneHash: string
  /** AES-256-GCM of the E.164 number, kept for the authorities */
  phoneEnc: string
  verifiedAt: string
}

/** The code last sent to an account, until used or expired */
export interface PhoneOtpTable {
  did: string
  phoneHash: string
  codeHash: string
  attempts: number
  expiresAt: string
  createdAt: string
}

/** Codes sent, for the hourly limits per account and per number */
export interface PhoneSendLogTable {
  id: Generated<number>
  did: string
  phoneHash: string
  /** Client address, when known (per address limit) */
  ip: string | null
  sentAt: string
}

/** What an account agreed to, and when */
export interface ConsentRecordTable {
  id: Generated<number>
  did: string
  version: string
  /** JSON string[] */
  items: string
  createdAt: string
}

/** Whether an account shows the "human" badge (see badges.ts) */
export interface BadgePrefTable {
  did: string
  human: number
  updatedAt: string
}

/** Whether an account appears on the weekly leaderboard (see leaderboard.ts) */
export interface LeaderboardPrefTable {
  did: string
  optIn: number
  updatedAt: string
}

export interface DatabaseSchema {
  referral_code: ReferralCodeTable
  referral: ReferralTable
  kyc_record: KycRecordTable
  kyc_review: KycReviewTable
  reward_rule: RewardRuleTable
  reward_event: RewardEventTable
  points_entry: PointsEntryTable
  audit_log: AuditLogTable
  taken_down: TakenDownTable
  phone_verification: PhoneVerificationTable
  phone_otp: PhoneOtpTable
  phone_send_log: PhoneSendLogTable
  consent_record: ConsentRecordTable
  badge_pref: BadgePrefTable
  leaderboard_pref: LeaderboardPrefTable
}

export type Database = Kysely<DatabaseSchema>

export function createDb(location: string): Database {
  const sqlite = new SqliteDB(location)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  })
}

/**
 * Versioned schema changes, applied in name order. 001 is the schema as it
 * stood before versioning; it is idempotent, so databases made by older
 * versions adopt it safely.
 */
const migrations = {
  '001-initial': { up: (db: Kysely<any>) => initialSchema(db as Database) },
  '002-phone-consent': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('phone_verification')
        .addColumn('did', 'varchar', (col) => col.primaryKey())
        .addColumn('phoneHash', 'varchar', (col) => col.notNull().unique())
        .addColumn('phoneEnc', 'varchar', (col) => col.notNull())
        .addColumn('verifiedAt', 'varchar', (col) => col.notNull())
        .execute()
      await db.schema
        .createTable('phone_otp')
        .addColumn('did', 'varchar', (col) => col.primaryKey())
        .addColumn('phoneHash', 'varchar', (col) => col.notNull())
        .addColumn('codeHash', 'varchar', (col) => col.notNull())
        .addColumn('attempts', 'integer', (col) => col.notNull())
        .addColumn('expiresAt', 'varchar', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .execute()
      await db.schema
        .createTable('phone_send_log')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('phoneHash', 'varchar', (col) => col.notNull())
        .addColumn('sentAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index phone_send_log_did_idx on phone_send_log (did, sentAt)`.execute(
        db,
      )
      await sql`create index phone_send_log_phone_idx on phone_send_log (phoneHash, sentAt)`.execute(
        db,
      )
      await db.schema
        .createTable('consent_record')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('version', 'varchar', (col) => col.notNull())
        .addColumn('items', 'varchar', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index consent_record_did_idx on consent_record (did, id)`.execute(
        db,
      )
    },
  },
  /*
   * Referral rewards are one level only, with a daily cap: the default
   * inviter rule gets one if it has none (20 x 100 = 2,000 points a day),
   * and rules for a referrer's referrer stop.
   */
  '003-one-level-referrals': {
    up: async (db: Kysely<any>) => {
      const at = new Date().toISOString()
      const capped = await db
        .updateTable('reward_rule')
        .set((eb: any) => ({
          capPerDay: DEFAULT_INVITER_CAP_PER_DAY,
          version: eb('version', '+', 1),
          updatedAt: at,
          updatedBy: 'system',
        }))
        .where('id', '=', 'referral.inviter')
        .where('capPerDay', 'is', null)
        .executeTakeFirst()
      const stopped = await db
        .updateTable('reward_rule')
        .set((eb: any) => ({
          enabled: 0,
          version: eb('version', '+', 1),
          updatedAt: at,
          updatedBy: 'system',
        }))
        .where('beneficiary', 'not in', ['actor', 'referrer'])
        .where('enabled', '=', 1)
        .executeTakeFirst()
      const counts = {
        capped: Number(capped.numUpdatedRows),
        disabled: Number(stopped.numUpdatedRows),
      }
      if (!counts.capped && !counts.disabled) return
      await db
        .insertInto('audit_log')
        .values({
          actor: 'system',
          action: 'rule.oneLevel',
          subject: null,
          data: JSON.stringify(counts),
          createdAt: at,
        })
        .execute()
    },
  },
  // Code requests per client address, and the global hourly SMS cap
  '004-phone-send-log-ip': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .alterTable('phone_send_log')
        .addColumn('ip', 'varchar')
        .execute()
      await sql`create index phone_send_log_ip_idx on phone_send_log (ip, sentAt)`.execute(
        db,
      )
      await sql`create index phone_send_log_sent_idx on phone_send_log (sentAt)`.execute(
        db,
      )
    },
  },
  '005-badge-pref': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('badge_pref')
        .addColumn('did', 'varchar', (col) => col.primaryKey())
        .addColumn('human', 'integer', (col) => col.notNull())
        .addColumn('updatedAt', 'varchar', (col) => col.notNull())
        .execute()
    },
  },
  /*
   * The weekly leaderboard: opt-in per account, and points per account by
   * time. The growth rules (wallet.linked, post.first) are added by
   * seedRules, which fills in missing default rules on every start.
   */
  '006-leaderboard': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('leaderboard_pref')
        .addColumn('did', 'varchar', (col) => col.primaryKey())
        .addColumn('optIn', 'integer', (col) => col.notNull())
        .addColumn('updatedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index points_entry_did_time_idx on points_entry (did, createdAt)`.execute(
        db,
      )
    },
  },
}

/** Daily cap of the default inviter rule: 20 sign-ups, 2,000 points */
export const DEFAULT_INVITER_CAP_PER_DAY = 20

/** Daily cap of the (disabled by default) growth referrer rules */
export const DEFAULT_GROWTH_REFERRER_CAP_PER_DAY = 20

export async function migrateDb(db: Database): Promise<void> {
  await runMigrations(db, migrations)
}

async function initialSchema(db: Database): Promise<void> {
  await db.schema
    .createTable('referral_code')
    .ifNotExists()
    .addColumn('code', 'varchar', (col) => col.primaryKey())
    .addColumn('kind', 'varchar', (col) => col.notNull())
    .addColumn('ownerDid', 'varchar')
    .addColumn('campaignId', 'varchar')
    .addColumn('maxUses', 'integer')
    .addColumn('expiresAt', 'varchar')
    .addColumn('disabled', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('note', 'varchar')
    .addColumn('createdBy', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  // One personal code per account
  await sql`create unique index if not exists referral_code_personal_idx on referral_code (ownerDid) where kind = 'personal'`.execute(
    db,
  )
  await db.schema
    .createTable('referral')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('code', 'varchar', (col) => col.notNull())
    .addColumn('referrerDid', 'varchar')
    .addColumn('referrer2Did', 'varchar')
    .addColumn('codeKind', 'varchar')
    .addColumn('campaignId', 'varchar')
    .addColumn('flag', 'varchar')
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists referral_referrer_idx on referral (referrerDid, createdAt)`.execute(
    db,
  )
  await sql`create index if not exists referral_code_idx on referral (code)`.execute(
    db,
  )
  await db.schema
    .createTable('kyc_record')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('provider', 'varchar')
    .addColumn('providerRef', 'varchar')
    .addColumn('rejectReason', 'varchar')
    .addColumn('updatedAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('kyc_review')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('reviewerDid', 'varchar', (col) => col.notNull())
    .addColumn('decision', 'varchar', (col) => col.notNull())
    .addColumn('reasonCode', 'varchar', (col) => col.notNull())
    .addColumn('note', 'varchar', (col) => col.notNull())
    .addColumn('applied', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('reward_rule')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('enabled', 'integer', (col) => col.notNull())
    .addColumn('description', 'varchar')
    .addColumn('event', 'varchar', (col) => col.notNull())
    .addColumn('beneficiary', 'varchar', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('vesting', 'varchar', (col) => col.notNull())
    .addColumn('codeKinds', 'varchar', (col) => col.notNull())
    .addColumn('campaignId', 'varchar')
    .addColumn('validFrom', 'varchar')
    .addColumn('validUntil', 'varchar')
    .addColumn('capPerBeneficiary', 'integer')
    .addColumn('capPerDay', 'integer')
    .addColumn('updatedAt', 'varchar', (col) => col.notNull())
    .addColumn('updatedBy', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('reward_event')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('type', 'varchar', (col) => col.notNull())
    .addColumn('actorDid', 'varchar', (col) => col.notNull())
    .addColumn('data', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('points_entry')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('amount', 'integer', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('ruleId', 'varchar')
    .addColumn('ruleVersion', 'integer')
    .addColumn('eventId', 'varchar')
    .addColumn('relatedDid', 'varchar')
    .addColumn('vesting', 'varchar', (col) => col.notNull())
    .addColumn('note', 'varchar')
    .addColumn('idempotencyKey', 'varchar', (col) => col.notNull().unique())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('decidedAt', 'varchar')
    .execute()
  await sql`create index if not exists points_entry_did_idx on points_entry (did, id)`.execute(
    db,
  )
  await sql`create index if not exists points_entry_related_idx on points_entry (relatedDid, status)`.execute(
    db,
  )
  await db.schema
    .createTable('taken_down')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('audit_log')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('actor', 'varchar', (col) => col.notNull())
    .addColumn('action', 'varchar', (col) => col.notNull())
    .addColumn('subject', 'varchar')
    .addColumn('data', 'varchar')
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists audit_log_subject_idx on audit_log (subject, id)`.execute(
    db,
  )
  // Taking points back looks entries up by the event that granted them
  await sql`create index if not exists points_entry_event_idx on points_entry (eventId)`.execute(
    db,
  )
}
