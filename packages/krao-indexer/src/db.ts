import SqliteDB from 'better-sqlite3'
import { type Generated, Kysely, SqliteDialect, sql } from 'kysely'

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
  data: Buffer
  size: number
  createdAt: string
}

export interface CursorTable {
  id: string
  seq: number
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

export interface DatabaseSchema {
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
  cursor: CursorTable
  failed_event: FailedEventTable
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
