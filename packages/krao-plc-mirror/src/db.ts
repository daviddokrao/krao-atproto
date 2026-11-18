import SqliteDB from 'better-sqlite3'
import { type Generated, Kysely, SqliteDialect, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { runMigrations } from './migrate.js'

/** A PLC operation the mirror took, in the order it took them */
export interface OpTable {
  id: Generated<number>
  did: string
  cid: string
  /** The operation, as JSON */
  operation: string
  /** Undone by a recovery operation */
  nullified: number
  /** When the source directory took it */
  createdAt: string
  receivedAt: string
}

export interface StateTable {
  key: string
  value: string
}

export interface DatabaseSchema {
  op: OpTable
  state: StateTable
}

export type Database = Kysely<DatabaseSchema>

export function createDb(location: string): Database {
  const sqlite = new SqliteDB(location)
  sqlite.pragma('journal_mode = WAL')
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  })
}

const migrations: Record<string, Migration> = {
  '001-initial': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('op')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('cid', 'varchar', (col) => col.notNull())
        .addColumn('operation', 'varchar', (col) => col.notNull())
        .addColumn('nullified', 'integer', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('receivedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create unique index op_did_cid_idx on op (did, cid)`.execute(db)
      await sql`create index op_did_idx on op (did, id)`.execute(db)
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
