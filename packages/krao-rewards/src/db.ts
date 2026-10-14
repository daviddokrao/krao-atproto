import SqliteDB from 'better-sqlite3'
import { type Generated, Kysely, SqliteDialect, sql } from 'kysely'

export type CodeKind = 'personal' | 'campaign' | 'partner'
export type KycStatus = 'none' | 'pending' | 'retry' | 'approved' | 'rejected'
export type EntryStatus = 'pending' | 'approved' | 'void'
/** Conditions for a ledger entry to be approved */
export type Vesting = 'kyc:self' | 'kyc:related'
export type RewardEvent = 'account.created' | 'kyc.approved'
export type Beneficiary = 'actor' | 'referrer' | 'referrer2'

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

export interface DatabaseSchema {
  referral_code: ReferralCodeTable
  referral: ReferralTable
  kyc_record: KycRecordTable
  kyc_review: KycReviewTable
  reward_rule: RewardRuleTable
  reward_event: RewardEventTable
  points_entry: PointsEntryTable
  audit_log: AuditLogTable
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

export async function migrateDb(db: Database) {
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
}
