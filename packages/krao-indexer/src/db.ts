import SqliteDB from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'

export type WalletStatus = 'verified' | 'invalid'

export interface WalletTable {
  uri: string
  did: string
  /** Normalized CAIP-10 id (lowercase EVM address), used for lookups. */
  account: string
  /** CAIP-10 id exactly as written in the record. */
  accountRaw: string
  label: string | null
  status: WalletStatus
  /** Why verification failed, for debugging. */
  reason: string | null
  createdAt: string
  indexedAt: string
}

export type TipStatus = 'pending' | 'verified' | 'invalid'

export interface TipTable {
  uri: string
  /** Sender */
  did: string
  recipient: string
  /** Tipped post, if any */
  subject: string | null
  /** CAIP-19 asset id */
  asset: string
  /** Amount in the asset's smallest unit, as a decimal string */
  amount: string
  /** Lowercase transaction hash */
  txHash: string
  fromAccount: string | null
  toAccount: string | null
  message: string | null
  status: TipStatus
  reason: string | null
  createdAt: string
  indexedAt: string
}

export interface CursorTable {
  id: string
  seq: number
}

export interface DatabaseSchema {
  wallet: WalletTable
  tip: TipTable
  cursor: CursorTable
}

export type Database = Kysely<DatabaseSchema>

export function createDb(location: string): Database {
  const sqlite = new SqliteDB(location)
  sqlite.pragma('journal_mode = WAL')
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  })
}

export async function migrateDb(db: Database): Promise<void> {
  await db.schema
    .createTable('wallet')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('account', 'varchar', (col) => col.notNull())
    .addColumn('accountRaw', 'varchar', (col) => col.notNull())
    .addColumn('label', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('reason', 'varchar')
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists wallet_did_idx on wallet (did)`.execute(
    db,
  )
  await sql`create index if not exists wallet_account_idx on wallet (account)`.execute(
    db,
  )
  await db.schema
    .createTable('tip')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('recipient', 'varchar', (col) => col.notNull())
    .addColumn('subject', 'varchar')
    .addColumn('asset', 'varchar', (col) => col.notNull())
    .addColumn('amount', 'varchar', (col) => col.notNull())
    .addColumn('txHash', 'varchar', (col) => col.notNull())
    .addColumn('fromAccount', 'varchar')
    .addColumn('toAccount', 'varchar')
    .addColumn('message', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('reason', 'varchar')
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists tip_subject_idx on tip (subject)`.execute(
    db,
  )
  await sql`create index if not exists tip_recipient_idx on tip (recipient)`.execute(
    db,
  )
  await sql`create index if not exists tip_tx_idx on tip (txHash)`.execute(db)
  await sql`create index if not exists tip_status_idx on tip (status)`.execute(
    db,
  )
  await db.schema
    .createTable('cursor')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('seq', 'integer', (col) => col.notNull())
    .execute()
}
