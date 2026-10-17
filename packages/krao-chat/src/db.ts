import SqliteDB from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { runMigrations } from './migrate.js'

export type ConvoKind = 'direct' | 'group'
export type LockStatus = 'unlocked' | 'locked' | 'locked-permanently'

export interface ConvoTable {
  id: string
  kind: ConvoKind
  /** Group name; null for direct convos */
  name: string | null
  /** Group owner; null for direct convos */
  ownerDid: string | null
  /** The two member DIDs, sorted and joined, so a pair has one direct convo */
  directKey: string | null
  lockStatus: LockStatus
  memberLimit: number
  createdAt: string
  /** Rev of the last activity, for ordering convo lists */
  rev: string
}

export type MemberStatus = 'request' | 'accepted'
export type MemberState = 'active' | 'left' | 'removed'

export interface MemberTable {
  convoId: string
  did: string
  /** 'owner' or 'standard' in groups; null in direct convos */
  role: 'owner' | 'standard' | null
  status: MemberStatus
  state: MemberState
  muted: number
  addedBy: string | null
  /** Rev at which the member (last) joined: earlier messages are hidden */
  joinedRev: string
  /** Rev of the last message the member has read */
  lastReadRev: string
}

export interface MessageTable {
  id: string
  convoId: string
  /** Null for system messages */
  senderDid: string | null
  text: string | null
  /** JSON */
  facets: string | null
  /** JSON of the messageInput embed (app.bsky.embed.record / joinLink) */
  embed: string | null
  replyTo: string | null
  /** JSON of the system message data, for system messages */
  system: string | null
  sentAt: string
  rev: string
}

export interface HiddenMessageTable {
  messageId: string
  did: string
}

export interface ReactionTable {
  messageId: string
  convoId: string
  did: string
  value: string
  createdAt: string
  rev: string
}

export interface LogTable {
  rev: string
  did: string
  convoId: string
  /** JSON of the log entry, without rev (added on read) */
  data: string
}

export interface JoinLinkTable {
  convoId: string
  code: string
  enabled: number
  requireApproval: number
  joinRule: 'anyone' | 'followedByOwner'
  createdAt: string
}

export interface JoinRequestTable {
  convoId: string
  did: string
  requestedAt: string
  read: number
}

export interface PrefsTable {
  did: string
  /** JSON of chat.bsky.notification.defs#preferences */
  prefs: string
}

/** Chat access a moderator set for an account (chat.bsky.moderation.updateActorAccess) */
export interface ActorAccessTable {
  did: string
  allowAccess: number
  ref: string | null
  updatedAt: string
}

export interface DatabaseSchema {
  convo: ConvoTable
  member: MemberTable
  message: MessageTable
  hidden_message: HiddenMessageTable
  reaction: ReactionTable
  log: LogTable
  join_link: JoinLinkTable
  join_request: JoinRequestTable
  prefs: PrefsTable
  actor_access: ActorAccessTable
  state: StateTable
}

/** Small values the service keeps, eg its firehose cursor */
export interface StateTable {
  key: string
  value: string
}

export type Database = Kysely<DatabaseSchema>

export function createDb(location: string): Database {
  const sqlite = new SqliteDB(location)
  sqlite.pragma('journal_mode = WAL')
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
  '002-state': {
    up: async (db: Kysely<any>) => {
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

async function initialSchema(db: Database): Promise<void> {
  await db.schema
    .createTable('actor_access')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('allowAccess', 'integer', (col) => col.notNull())
    .addColumn('ref', 'varchar')
    .addColumn('updatedAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('convo')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('kind', 'varchar', (col) => col.notNull())
    .addColumn('name', 'varchar')
    .addColumn('ownerDid', 'varchar')
    .addColumn('directKey', 'varchar', (col) => col.unique())
    .addColumn('lockStatus', 'varchar', (col) => col.notNull())
    .addColumn('memberLimit', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('rev', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('member')
    .ifNotExists()
    .addColumn('convoId', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('role', 'varchar')
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('state', 'varchar', (col) => col.notNull())
    .addColumn('muted', 'integer', (col) => col.notNull())
    .addColumn('addedBy', 'varchar')
    .addColumn('joinedRev', 'varchar', (col) => col.notNull())
    .addColumn('lastReadRev', 'varchar', (col) => col.notNull())
    .addPrimaryKeyConstraint('member_pk', ['convoId', 'did'])
    .execute()
  await sql`create index if not exists member_did_idx on member (did)`.execute(
    db,
  )
  await db.schema
    .createTable('message')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('convoId', 'varchar', (col) => col.notNull())
    .addColumn('senderDid', 'varchar')
    .addColumn('text', 'varchar')
    .addColumn('facets', 'varchar')
    .addColumn('embed', 'varchar')
    .addColumn('replyTo', 'varchar')
    .addColumn('system', 'varchar')
    .addColumn('sentAt', 'varchar', (col) => col.notNull())
    .addColumn('rev', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists message_convo_rev_idx on message (convoId, rev)`.execute(
    db,
  )
  // Moderation and account deletion look messages up by sender
  await sql`create index if not exists message_sender_idx on message (senderDid)`.execute(
    db,
  )
  await db.schema
    .createTable('hidden_message')
    .ifNotExists()
    .addColumn('messageId', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addPrimaryKeyConstraint('hidden_message_pk', ['messageId', 'did'])
    .execute()
  await db.schema
    .createTable('reaction')
    .ifNotExists()
    .addColumn('messageId', 'varchar', (col) => col.notNull())
    .addColumn('convoId', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('value', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('rev', 'varchar', (col) => col.notNull())
    .addPrimaryKeyConstraint('reaction_pk', ['messageId', 'did', 'value'])
    .execute()
  await sql`create index if not exists reaction_convo_rev_idx on reaction (convoId, rev)`.execute(
    db,
  )
  await db.schema
    .createTable('log')
    .ifNotExists()
    .addColumn('rev', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('convoId', 'varchar', (col) => col.notNull())
    .addColumn('data', 'varchar', (col) => col.notNull())
    .addPrimaryKeyConstraint('log_pk', ['did', 'rev'])
    .execute()
  await db.schema
    .createTable('join_link')
    .ifNotExists()
    .addColumn('convoId', 'varchar', (col) => col.primaryKey())
    .addColumn('code', 'varchar', (col) => col.notNull().unique())
    .addColumn('enabled', 'integer', (col) => col.notNull())
    .addColumn('requireApproval', 'integer', (col) => col.notNull())
    .addColumn('joinRule', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('join_request')
    .ifNotExists()
    .addColumn('convoId', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('requestedAt', 'varchar', (col) => col.notNull())
    .addColumn('read', 'integer', (col) => col.notNull())
    .addPrimaryKeyConstraint('join_request_pk', ['convoId', 'did'])
    .execute()
  await db.schema
    .createTable('prefs')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('prefs', 'varchar', (col) => col.notNull())
    .execute()
}
