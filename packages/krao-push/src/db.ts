import SqliteDB from 'better-sqlite3'
import { type Kysely, Kysely as KyselyDb, SqliteDialect } from 'kysely'
import { runMigrations } from './migrate.js'

export type Platform = 'ios' | 'android' | 'web'

/** A device of an account; one device can carry several accounts */
export interface DeviceTokenTable {
  did: string
  token: string
  platform: Platform
  appId: string
  /** 1 when the account is age-restricted, as told by the AppView */
  ageRestricted: number
  createdAt: string
  updatedAt: string
}

/** Notifications already pushed, so a re-read of the AppView sends none twice */
export interface SentTable {
  key: string
  sentAt: string
}

export interface StateTable {
  key: string
  value: string
}

export interface DatabaseSchema {
  device_token: DeviceTokenTable
  sent: SentTable
  state: StateTable
}

export type Database = Kysely<DatabaseSchema>

export function createDb(location: string): Database {
  const sqlite = new SqliteDB(location)
  sqlite.pragma('journal_mode = WAL')
  return new KyselyDb<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  })
}

const migrations = {
  '001-initial': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('device_token')
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('token', 'varchar', (col) => col.notNull())
        .addColumn('platform', 'varchar', (col) => col.notNull())
        .addColumn('appId', 'varchar', (col) => col.notNull())
        .addColumn('ageRestricted', 'integer', (col) =>
          col.notNull().defaultTo(0),
        )
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('updatedAt', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('device_token_pkey', ['did', 'token'])
        .execute()
      await db.schema
        .createIndex('device_token_token_idx')
        .on('device_token')
        .column('token')
        .execute()
      await db.schema
        .createTable('sent')
        .addColumn('key', 'varchar', (col) => col.primaryKey())
        .addColumn('sentAt', 'varchar', (col) => col.notNull())
        .execute()
      await db.schema
        .createIndex('sent_at_idx')
        .on('sent')
        .column('sentAt')
        .execute()
      await db.schema
        .createTable('state')
        .addColumn('key', 'varchar', (col) => col.primaryKey())
        .addColumn('value', 'varchar', (col) => col.notNull())
        .execute()
    },
  },
}

export async function migrateDb(db: Database): Promise<void> {
  await runMigrations(db, migrations)
}

export async function getState(db: Database, key: string) {
  const row = await db
    .selectFrom('state')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
  return row?.value
}

export async function setState(db: Database, key: string, value: string) {
  await db
    .insertInto('state')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute()
}
