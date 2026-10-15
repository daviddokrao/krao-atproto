import SqliteDB from 'better-sqlite3'
import { type Generated, Kysely, SqliteDialect, sql } from 'kysely'
import { runMigrations } from './migrate.js'

export type WalletStatus = 'verified' | 'invalid'

export interface WalletTable {
  uri: string
  did: string
  /** Normalized CAIP-10 id (lowercase EVM address), used for lookups. */
  account: string
  /** CAIP-10 id exactly as written in the record. */
  accountRaw: string
  /** Lowercase address for eip155 accounts (the same on every EVM chain) */
  evmAddress: string | null
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
  /** When a pending tip is checked again (backs off as it ages) */
  nextCheckAt: string | null
  /** When the record was last written: its pending timeout starts here */
  pendingSince: string | null
  reason: string | null
  createdAt: string
  indexedAt: string
}

export interface NftAvatarTable {
  /** One NFT avatar per account (the record key is literal:self) */
  did: string
  uri: string
  /** CAIP-2 chain id */
  chain: string
  /** Lowercase contract address */
  contract: string
  tokenId: string
  standard: string | null
  /** CAIP-10 wallet claimed to hold the NFT */
  wallet: string
  status: 'pending' | 'verified' | 'invalid'
  reason: string | null
  collectionName: string | null
  image: string | null
  checkedAt: string | null
  indexedAt: string
}

export interface GateRuleTable {
  /** URI of the net.krao.gate.rule record */
  uri: string
  /** Author; always the repo of the gated post */
  did: string
  /** The gated post */
  subject: string
  /** JSON array of gate conditions */
  conditions: string
  match: 'all' | 'any'
  service: string
  createdAt: string
  indexedAt: string
}

export interface GatedContentTable {
  /** The gated post */
  subject: string
  did: string
  text: string
  /** JSON array of app.bsky.richtext.facet */
  facets: string | null
  /** JSON array of {id, mimeType, alt?, aspectRatio?}, see gate-media.ts */
  media: string | null
  updatedAt: string
}

/** An image uploaded for gated content; never part of a public repo */
export interface GatedMediaTable {
  id: string
  did: string
  mimeType: string
  /** The bytes when `store` is 'db'; empty when they live elsewhere */
  data: Buffer
  size: number
  createdAt: string
  /** Where the bytes are: 'db' (this row) or 's3' */
  store: Generated<string>
}

/** S3 objects of deleted gated_media rows, waiting to be removed */
export interface GatedMediaTrashTable {
  id: string
  deletedAt: string
}

export interface CursorTable {
  id: string
  seq: number
  /** When the event at `seq` was indexed, for health checks */
  at: string | null
}

/** A firehose event whose handler kept failing, kept for a manual replay */
export interface FailedEventTable {
  id: Generated<number>
  /** Writes of one commit share its seq */
  seq: number
  did: string
  event: string
  uri: string | null
  error: string
  failedAt: string
}

/** A top-level post in the "latest" feed */
export interface FeedPostTable {
  uri: string
  cid: string
  did: string
  indexedAt: string
  /** The record's own createdAt, if valid; null for rows from before it was kept */
  createdAt: string | null
}

/** A like or repost of a post, counted by the "popular" feed */
export interface FeedInteractionTable {
  uri: string
  did: string
  subject: string
  kind: 'like' | 'repost'
  indexedAt: string
}

/** A follow by a Krao account, for account suggestions */
export interface FeedFollowTable {
  uri: string
  did: string
  subject: string
  indexedAt: string
}

/** A hashtag used in a post by a Krao account, for trending topics */
export interface FeedTagTable {
  uri: string
  did: string
  tag: string
  indexedAt: string
}

/** A starter pack made by a Krao account, for starter pack suggestions */
export interface FeedStarterPackTable {
  uri: string
  did: string
  indexedAt: string
}

/** A feed generator record that names this service */
export interface FeedGeneratorTable {
  uri: string
  did: string
}

/** A short link to a page of Krao's web app (see starter-packs.ts) */
export interface ShortLinkTable {
  code: string
  path: string
  createdAt: string
}

/**
 * An account its PDS reports as inactive (taken down, suspended,
 * deactivated): its Krao data is kept but not served until it is active.
 */
export interface HiddenActorTable {
  did: string
  status: string
  since: string
}

/** A moderator read gated content (net.krao.gate.moderation.getContent) */
export interface GateAccessLogTable {
  id: Generated<number>
  moderatorDid: string
  uri: string
  reason: string | null
  accessedAt: string
}

export type UnsafeDomainSource = 'list' | 'admin' | 'seed'

/** A phishing or wallet-draining domain (see safety.ts); covers subdomains */
export interface UnsafeDomainTable {
  /** Lowercase, punycode */
  domain: string
  source: UnsafeDomainSource
  reason: string | null
  addedAt: string
}

/** Small settings of the safety list: its whitelist, fuzzy list, sync state */
export interface SafetyStateTable {
  key: string
  value: string
}

/** A change an admin made to the unsafe domain list */
export interface SafetyAuditLogTable {
  id: Generated<number>
  adminDid: string
  action: string
  domain: string
  reason: string | null
  at: string
}

/** A host a post by a Krao account links to (facets, external embeds) */
export interface PostLinkTable {
  uri: string
  did: string
  host: string
  indexedAt: string
}

/** A post linking to an unsafe domain: kept out of Popular and trending */
export interface UnsafePostTable {
  uri: string
  did: string
  domain: string
  flaggedAt: string
}

export interface DatabaseSchema {
  gate_access_log: GateAccessLogTable
  unsafe_domain: UnsafeDomainTable
  safety_state: SafetyStateTable
  safety_audit_log: SafetyAuditLogTable
  post_link: PostLinkTable
  unsafe_post: UnsafePostTable
  wallet: WalletTable
  tip: TipTable
  nft_avatar: NftAvatarTable
  gate_rule: GateRuleTable
  feed_post: FeedPostTable
  feed_interaction: FeedInteractionTable
  feed_follow: FeedFollowTable
  feed_tag: FeedTagTable
  feed_starter_pack: FeedStarterPackTable
  feed_generator: FeedGeneratorTable
  short_link: ShortLinkTable
  gated_content: GatedContentTable
  gated_media: GatedMediaTable
  gated_media_trash: GatedMediaTrashTable
  cursor: CursorTable
  failed_event: FailedEventTable
  hidden_actor: HiddenActorTable
}

/** SQL condition: `column` (a DID) is not a hidden (inactive) account */
export const visibleDid = (column: string) =>
  sql<boolean>`${sql.ref(column)} not in (select did from hidden_actor)`

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
  '002-gated-media-store': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .alterTable('gated_media')
        .addColumn('store', 'varchar', (col) => col.notNull().defaultTo('db'))
        .execute()
      await db.schema
        .createTable('gated_media_trash')
        .addColumn('id', 'varchar', (col) => col.primaryKey())
        .addColumn('deletedAt', 'varchar', (col) => col.notNull())
        .execute()
      // Every way a row goes away queues its object, see purgeMediaTrash
      await sql`create trigger gated_media_trash_on_delete after delete on gated_media when old.store = 's3' begin insert or ignore into gated_media_trash (id, deletedAt) values (old.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); end`.execute(
        db,
      )
    },
  },
  '003-gate-access-log': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('gate_access_log')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('moderatorDid', 'varchar', (col) => col.notNull())
        .addColumn('uri', 'varchar', (col) => col.notNull())
        .addColumn('reason', 'varchar')
        .addColumn('accessedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index gate_access_log_uri_idx on gate_access_log (uri, id)`.execute(
        db,
      )
    },
  },
  '004-safety': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('unsafe_domain')
        .addColumn('domain', 'varchar', (col) => col.notNull())
        .addColumn('source', 'varchar', (col) => col.notNull())
        .addColumn('reason', 'varchar')
        .addColumn('addedAt', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('unsafe_domain_pkey', ['domain', 'source'])
        .execute()
      await sql`create index unsafe_domain_source_idx on unsafe_domain (source)`.execute(
        db,
      )
      await db.schema
        .createTable('safety_state')
        .addColumn('key', 'varchar', (col) => col.primaryKey())
        .addColumn('value', 'varchar', (col) => col.notNull())
        .execute()
      await db.schema
        .createTable('safety_audit_log')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('adminDid', 'varchar', (col) => col.notNull())
        .addColumn('action', 'varchar', (col) => col.notNull())
        .addColumn('domain', 'varchar', (col) => col.notNull())
        .addColumn('reason', 'varchar')
        .addColumn('at', 'varchar', (col) => col.notNull())
        .execute()
      await db.schema
        .createTable('post_link')
        .addColumn('uri', 'varchar', (col) => col.notNull())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('host', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('post_link_pkey', ['uri', 'host'])
        .execute()
      await sql`create index post_link_host_idx on post_link (host)`.execute(db)
      await sql`create index post_link_did_idx on post_link (did)`.execute(db)
      await sql`create index post_link_time_idx on post_link (indexedAt)`.execute(
        db,
      )
      await db.schema
        .createTable('unsafe_post')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('domain', 'varchar', (col) => col.notNull())
        .addColumn('flaggedAt', 'varchar', (col) => col.notNull())
        .execute()
      // Address poisoning checks look up wallets by their first and last
      // characters (see address-check.ts, which must use these expressions)
      await sql`create index wallet_evm_ends_idx on wallet (substr(evmAddress, 1, 6), substr(evmAddress, -4))`.execute(
        db,
      )
    },
  },
}

export async function migrateDb(db: Database): Promise<void> {
  await runMigrations(db, migrations)
}

async function initialSchema(db: Database): Promise<void> {
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
  await addColumnIfMissing(db, 'wallet', 'evmAddress', 'varchar')
  // Rows from before the column: eip155:<chain>:<address>
  await sql`update wallet set evmAddress = lower(substr(substr(account, 8), instr(substr(account, 8), ':') + 1)) where evmAddress is null and account like 'eip155:%'`.execute(
    db,
  )
  await sql`create index if not exists wallet_evm_address_idx on wallet (evmAddress, status)`.execute(
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
  await addColumnIfMissing(db, 'tip', 'nextCheckAt', 'varchar')
  await addColumnIfMissing(db, 'tip', 'pendingSince', 'varchar')
  await sql`create index if not exists tip_subject_idx on tip (subject)`.execute(
    db,
  )
  await sql`create index if not exists tip_recipient_idx on tip (recipient)`.execute(
    db,
  )
  await sql`create index if not exists tip_tx_idx on tip (txHash)`.execute(db)
  // A transaction can back only one verified tip. Older versions could verify
  // two at once: keep the first and demote the rest before adding the index.
  await sql`update tip set status = 'invalid', reason = 'Transaction already used by another tip' where status = 'verified' and rowid not in (select min(rowid) from tip where status = 'verified' group by txHash)`.execute(
    db,
  )
  await sql`create unique index if not exists tip_tx_verified_idx on tip (txHash) where status = 'verified'`.execute(
    db,
  )
  await sql`create index if not exists tip_status_idx on tip (status)`.execute(
    db,
  )
  await db.schema
    .createTable('nft_avatar')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('uri', 'varchar', (col) => col.notNull())
    .addColumn('chain', 'varchar', (col) => col.notNull())
    .addColumn('contract', 'varchar', (col) => col.notNull())
    .addColumn('tokenId', 'varchar', (col) => col.notNull())
    .addColumn('standard', 'varchar')
    .addColumn('wallet', 'varchar', (col) => col.notNull())
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('reason', 'varchar')
    .addColumn('collectionName', 'varchar')
    .addColumn('image', 'varchar')
    .addColumn('checkedAt', 'varchar')
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('gate_rule')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('subject', 'varchar', (col) => col.notNull())
    .addColumn('conditions', 'varchar', (col) => col.notNull())
    .addColumn('match', 'varchar', (col) => col.notNull())
    .addColumn('service', 'varchar', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists gate_rule_subject_idx on gate_rule (subject)`.execute(
    db,
  )
  await db.schema
    .createTable('gated_content')
    .ifNotExists()
    .addColumn('subject', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('text', 'varchar', (col) => col.notNull())
    .addColumn('facets', 'varchar')
    .addColumn('updatedAt', 'varchar', (col) => col.notNull())
    .execute()
  // Added after gated_content shipped, so older databases get it here too
  await sql`alter table gated_content add column media varchar`
    .execute(db)
    .catch(() => {})
  await db.schema
    .createTable('gated_media')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('mimeType', 'varchar', (col) => col.notNull())
    .addColumn('data', 'blob', (col) => col.notNull())
    .addColumn('size', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists gated_media_did_idx on gated_media (did)`.execute(
    db,
  )
  await db.schema
    .createTable('cursor')
    .ifNotExists()
    .addColumn('id', 'varchar', (col) => col.primaryKey())
    .addColumn('seq', 'integer', (col) => col.notNull())
    .execute()
  // The first version keyed failed_event by seq, which the writes of one
  // commit share. Its rows are only for manual replay: start it over.
  const failedEventCols = await sql<{
    name: string
  }>`pragma table_info(failed_event)`.execute(db)
  if (
    failedEventCols.rows.length &&
    !failedEventCols.rows.some((c) => c.name === 'id')
  ) {
    await db.schema.dropTable('failed_event').execute()
  }
  await addColumnIfMissing(db, 'cursor', 'at', 'varchar')
  await db.schema
    .createTable('hidden_actor')
    .ifNotExists()
    .addColumn('did', 'varchar', (col) => col.primaryKey())
    .addColumn('status', 'varchar', (col) => col.notNull())
    .addColumn('since', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('failed_event')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('seq', 'integer', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('event', 'varchar', (col) => col.notNull())
    .addColumn('uri', 'varchar')
    .addColumn('error', 'varchar', (col) => col.notNull())
    .addColumn('failedAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists nft_avatar_checked_idx on nft_avatar (checkedAt)`.execute(
    db,
  )
  await db.schema
    .createTable('feed_post')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('cid', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  // Added after feed_post shipped, so older databases get it here too
  await sql`alter table feed_post add column createdAt varchar`
    .execute(db)
    .catch(() => {})
  await sql`create index if not exists feed_post_order_idx on feed_post (indexedAt, cid)`.execute(
    db,
  )
  await sql`create index if not exists feed_post_did_idx on feed_post (did)`.execute(
    db,
  )
  await db.schema
    .createTable('feed_interaction')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('subject', 'varchar', (col) => col.notNull())
    .addColumn('kind', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists feed_interaction_subject_idx on feed_interaction (subject)`.execute(
    db,
  )
  await sql`create index if not exists feed_interaction_did_idx on feed_interaction (did)`.execute(
    db,
  )
  await db.schema
    .createTable('feed_follow')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('subject', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await sql`create index if not exists feed_follow_did_idx on feed_follow (did)`.execute(
    db,
  )
  await sql`create index if not exists feed_follow_subject_idx on feed_follow (subject)`.execute(
    db,
  )
  await db.schema
    .createTable('feed_tag')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.notNull())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('tag', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .addPrimaryKeyConstraint('feed_tag_pkey', ['uri', 'tag'])
    .execute()
  await sql`create index if not exists feed_tag_time_idx on feed_tag (indexedAt)`.execute(
    db,
  )
  await db.schema
    .createTable('feed_starter_pack')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .addColumn('indexedAt', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('feed_generator')
    .ifNotExists()
    .addColumn('uri', 'varchar', (col) => col.primaryKey())
    .addColumn('did', 'varchar', (col) => col.notNull())
    .execute()
  await db.schema
    .createTable('short_link')
    .ifNotExists()
    .addColumn('code', 'varchar', (col) => col.primaryKey())
    .addColumn('path', 'varchar', (col) => col.notNull().unique())
    .addColumn('createdAt', 'varchar', (col) => col.notNull())
    .execute()
}

/**
 * Add a column to a table made by an older version. createTable's
 * ifNotExists leaves existing tables alone, so new columns need this.
 */
async function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: 'varchar' | 'integer',
) {
  const cols = await sql<{ name: string }>`pragma table_info(${sql.raw(
    table,
  )})`.execute(db)
  if (!cols.rows.some((c) => c.name === column)) {
    await db.schema.alterTable(table).addColumn(column, type).execute()
  }
}
