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
  /** 0 when the record says not to show the wallet's Basename/ENS name */
  showPrimaryName: number
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
  /** 1: the sender asked to be an anonymous supporter (see creator.ts) */
  anonymous: number
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
  /** 1 when the post is in Vietnamese (see language.ts), for "Tiếng Việt" */
  vi: number
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

export type UnsafeDomainSource = 'list' | 'admin' | 'admin_allow' | 'seed'

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

export type CommunityAccessMode = 'open' | 'approval' | 'condition' | 'verified'

/** A net.krao.community.profile record (see community.ts) */
export interface CommunityTable {
  uri: string
  /** Owner: the repo holding the record */
  did: string
  cid: string
  /** The record key */
  slug: string
  name: string
  description: string | null
  /** CID of the avatar blob */
  avatar: string | null
  /** JSON array of strings */
  rules: string
  accessMode: CommunityAccessMode
  /** JSON of the record's access object (conditions, match) */
  access: string
  chatJoinLink: string | null
  createdAt: string
  indexedAt: string
}

/** A net.krao.community.membership record */
export interface CommunityMembershipTable {
  uri: string
  did: string
  community: string
  /**
   * For 'condition' and 'verified' communities, the last check: 1 meets the
   * requirement, 0 does not, null not checked yet
   */
  eligible: number | null
  reason: string | null
  checkedAt: string | null
  createdAt: string
  indexedAt: string
}

/**
 * Moderator, approval, ban and hide records: written by the owner or a
 * moderator, which is checked when they are read (moderators come and go)
 */
export interface CommunityActionTable {
  uri: string
  /** Who wrote it */
  did: string
  community: string
  /** An account (moderator, approval, ban) or a post (hide) */
  subject: string
  reason: string | null
  createdAt: string
}

/** A net.krao.community.submission record: a post in a community feed */
export interface CommunitySubmissionTable {
  uri: string
  did: string
  community: string
  post: string
  postCid: string
  createdAt: string
  indexedAt: string
}

export type PollMode = 'account' | 'verified' | 'token'

/** A net.krao.poll.poll record (see poll.ts); never changed once indexed */
export interface PollTable {
  uri: string
  did: string
  post: string
  question: string | null
  /** JSON array of strings */
  options: string
  /** When the poll opened: its record's createdAt, or when it was published if earlier */
  startsAt: string
  endsAt: string
  mode: PollMode
  /** CAIP-19 asset, for token polls */
  asset: string | null
  /** Block whose balances weigh the votes of token polls, decimal */
  snapshotBlock: string | null
  resultsVisibility: 'always' | 'afterEnd'
  createdAt: string
  indexedAt: string
}

export type VoteStatus = 'counted' | 'ignored' | 'deleted'

/** A net.krao.poll.vote record */
export interface PollVoteTable {
  uri: string
  did: string
  poll: string
  option: number
  status: VoteStatus
  /** Decimal: 1 for account and verified polls, the balance for token polls */
  weight: string
  reason: string | null
  /** When the vote was published (the firehose event time) */
  votedAt: string
  indexedAt: string
}

/** A wallet whose snapshot balance weighed a vote: it weighs one vote per poll */
export interface PollVoteWalletTable {
  poll: string
  address: string
  vote: string
}

export type TokenQuote = 'USDC' | 'WETH' | 'usd'

/** A token of Krao's catalog (see token.ts) */
export interface TokenTable {
  /** The symbol in upper case, for lookups */
  key: string
  symbol: string
  name: string
  chain: string
  address: string
  decimals: number
  quote: TokenQuote
  /** Uniswap v3 pool of the token and the quote token; null until found */
  pool: string | null
  logo: string | null
  source: 'seed' | 'admin'
  /** 1: taken out by an admin (kept so that seed tokens stay out) */
  removed: number
  priceUsd: string | null
  updatedAt: string | null
  addedAt: string
}

/** A price sample of a catalog token */
export interface TokenPriceTable {
  key: string
  t: string
  priceUsd: string
}

/** A post by a Krao account mentioning a catalog token as a cashtag */
export interface PostCashtagTable {
  uri: string
  did: string
  key: string
  indexedAt: string
}

/** A net.krao.membership.plan record (see membership.ts) */
export interface MembershipPlanTable {
  uri: string
  /** The creator: the repo holding the record */
  did: string
  cid: string
  name: string
  description: string | null
  /** USDC base units, decimal */
  priceUsdc: string
  /** JSON array of strings */
  perks: string
  /** 1: open to new members (and within the 3 active plans an account may have) */
  active: number
  createdAt: string
  indexedAt: string
}

/** A net.krao.membership.payment record, checked on chain like a tip */
export interface MembershipPaymentTable {
  uri: string
  /** The member: the repo holding the record */
  did: string
  creator: string
  plan: string
  chain: string
  /** Lowercase transaction hash */
  txHash: string
  status: TipStatus
  reason: string | null
  /** USDC base units moved to the creator, once verified */
  amount: string | null
  /** Block time of the transaction, once verified */
  blockTime: string | null
  /** The 30 days this payment pays for, once verified (see membershipPeriods) */
  periodStart: string | null
  periodEnd: string | null
  nextCheckAt: string | null
  pendingSince: string | null
  /** When the record was published (firehose event time): the 24h rule counts from here */
  publishedAt: string
  createdAt: string
  indexedAt: string
}

/** A member of a creator: the verified payments of one account to another, summed up */
export interface CreatorMemberTable {
  creator: string
  member: string
  /** Start of the unbroken run of paid periods that ends at expiresAt */
  since: string
  expiresAt: string
  /** Start of the member's first paid period */
  firstAt: string
  updatedAt: string
}

/** A follow by a Krao account that was removed, for follower changes */
export interface FollowerLossTable {
  subject: string
  followedAt: string
  lostAt: string
}

/** An account's verified Basename/ENS name, as last checked (see names.ts) */
export interface PrimaryNameTable {
  did: string
  name: string | null
  source: string | null
  address: string | null
  /** Last check that got an answer */
  checkedAt: string | null
  /** Last check, answered or not */
  attemptedAt: string | null
  /** 1 when the account's wallets changed since */
  stale: number
}

/** Account events for the rewards service (see rewards-events.ts) */
export interface RewardsOutboxTable {
  /** `<type>:<did>`: once per account; `activity.day:<did>:<day>` once a day */
  id: string
  type:
    | 'wallet.linked'
    | 'post.first'
    | 'community.joined'
    | 'tip.first'
    | 'activity.day'
  did: string
  /** For activity.day: the day (YYYY-MM-DD, Vietnam time) */
  day: string | null
  createdAt: string
  sentAt: string | null
  attempts: number
  nextAttemptAt: string
  error: string | null
}

/**
 * Wallets that already earned an account its wallet.linked reward (see
 * rewards-events.ts): kept after unlinking and account deletion, so one
 * wallet cannot earn for account after account. No DID is kept.
 */
export interface RewardedWalletTable {
  /** The EVM address (any chain), or the account id for other chains */
  wallet: string
  createdAt: string
}

/**
 * An NFT collection Krao's admins approved for the on-chain profile tab (see
 * onchain.ts)
 */
export interface NftCollectionTable {
  /** CAIP-2 chain id */
  chain: string
  /** Lowercase contract address */
  contract: string
  name: string | null
  /** What the contract is: 'erc721-enumerable', 'erc721' or 'erc1155' */
  standard: string
  addedBy: string
  addedAt: string
}

/**
 * A Mini App record (net.krao.miniapp.app, see miniapp.ts). Its review is
 * tied to the CID: an approval counts only while `approvedCid` is the
 * current `cid`; a revocation holds for every version until approved again.
 */
export interface MiniAppTable {
  uri: string
  did: string
  cid: string
  name: string
  description: string | null
  url: string
  origin: string
  /** The icon blob's CID and type, when it has a usable one */
  iconCid: string | null
  iconMime: string | null
  /** JSON arrays */
  permissions: string
  chains: string | null
  /** Why the record breaks the rules; null when it is valid */
  invalidReason: string | null
  approvedCid: string | null
  approvedAt: string | null
  approvedBy: string | null
  revokedAt: string | null
  revokedReason: string | null
  createdAt: string
  indexedAt: string
}

/** Admin actions waiting for the rewards service's shared log (M35) */
export interface AdminAuditOutboxTable {
  id: Generated<number>
  /** Sent along: the rewards service keeps each key once */
  key: string
  service: string
  actor: string
  action: string
  subject: string | null
  /** JSON object */
  details: string | null
  createdAt: string
  sentAt: string | null
  attempts: number
  nextAttemptAt: string
  error: string | null
}

export interface DatabaseSchema {
  admin_audit_outbox: AdminAuditOutboxTable
  miniapp: MiniAppTable
  nft_collection: NftCollectionTable
  primary_name: PrimaryNameTable
  rewarded_wallet: RewardedWalletTable
  rewards_outbox: RewardsOutboxTable
  membership_plan: MembershipPlanTable
  membership_payment: MembershipPaymentTable
  creator_member: CreatorMemberTable
  follower_loss: FollowerLossTable
  token: TokenTable
  token_price: TokenPriceTable
  post_cashtag: PostCashtagTable
  community: CommunityTable
  community_membership: CommunityMembershipTable
  community_moderator: CommunityActionTable
  community_approval: CommunityActionTable
  community_ban: CommunityActionTable
  community_hide: CommunityActionTable
  community_submission: CommunitySubmissionTable
  poll: PollTable
  poll_vote: PollVoteTable
  poll_vote_wallet: PollVoteWalletTable
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
  '005-communities-polls': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('community')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('cid', 'varchar', (col) => col.notNull())
        .addColumn('slug', 'varchar', (col) => col.notNull())
        .addColumn('name', 'varchar', (col) => col.notNull())
        .addColumn('description', 'varchar')
        .addColumn('avatar', 'varchar')
        .addColumn('rules', 'varchar', (col) => col.notNull())
        .addColumn('accessMode', 'varchar', (col) => col.notNull())
        .addColumn('access', 'varchar', (col) => col.notNull())
        .addColumn('chatJoinLink', 'varchar')
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index community_did_idx on community (did)`.execute(db)
      await sql`create index community_time_idx on community (indexedAt)`.execute(
        db,
      )
      await db.schema
        .createTable('community_membership')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('community', 'varchar', (col) => col.notNull())
        .addColumn('eligible', 'integer')
        .addColumn('reason', 'varchar')
        .addColumn('checkedAt', 'varchar')
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index community_membership_idx on community_membership (community, did)`.execute(
        db,
      )
      await sql`create index community_membership_did_idx on community_membership (did)`.execute(
        db,
      )
      await sql`create index community_membership_checked_idx on community_membership (checkedAt)`.execute(
        db,
      )
      for (const table of [
        'community_moderator',
        'community_approval',
        'community_ban',
        'community_hide',
      ]) {
        await db.schema
          .createTable(table)
          .addColumn('uri', 'varchar', (col) => col.primaryKey())
          .addColumn('did', 'varchar', (col) => col.notNull())
          .addColumn('community', 'varchar', (col) => col.notNull())
          .addColumn('subject', 'varchar', (col) => col.notNull())
          .addColumn('reason', 'varchar')
          .addColumn('createdAt', 'varchar', (col) => col.notNull())
          .execute()
        await sql`create index ${sql.raw(`${table}_idx`)} on ${sql.raw(
          table,
        )} (community, subject)`.execute(db)
        await sql`create index ${sql.raw(`${table}_did_idx`)} on ${sql.raw(
          table,
        )} (did)`.execute(db)
      }
      await db.schema
        .createTable('community_submission')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('community', 'varchar', (col) => col.notNull())
        .addColumn('post', 'varchar', (col) => col.notNull())
        .addColumn('postCid', 'varchar', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      // A post is in a community feed once, however often it is submitted
      await sql`create unique index community_submission_post_idx on community_submission (community, post)`.execute(
        db,
      )
      await sql`create index community_submission_feed_idx on community_submission (community, indexedAt, uri)`.execute(
        db,
      )
      await sql`create index community_submission_did_idx on community_submission (did)`.execute(
        db,
      )
      await sql`create index community_submission_by_post_idx on community_submission (post)`.execute(
        db,
      )
      await db.schema
        .createTable('poll')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('post', 'varchar', (col) => col.notNull())
        .addColumn('question', 'varchar')
        .addColumn('options', 'varchar', (col) => col.notNull())
        .addColumn('startsAt', 'varchar', (col) => col.notNull())
        .addColumn('endsAt', 'varchar', (col) => col.notNull())
        .addColumn('mode', 'varchar', (col) => col.notNull())
        .addColumn('asset', 'varchar')
        .addColumn('snapshotBlock', 'varchar')
        .addColumn('resultsVisibility', 'varchar', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index poll_post_idx on poll (post)`.execute(db)
      await sql`create index poll_did_idx on poll (did)`.execute(db)
      await db.schema
        .createTable('poll_vote')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('poll', 'varchar', (col) => col.notNull())
        .addColumn('option', 'integer', (col) => col.notNull())
        .addColumn('status', 'varchar', (col) => col.notNull())
        .addColumn('weight', 'varchar', (col) => col.notNull())
        .addColumn('reason', 'varchar')
        .addColumn('votedAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      // One vote per account and poll: the first valid one (a deleted vote
      // keeps its place, so votes cannot be changed by deleting them)
      await sql`create unique index poll_vote_once_idx on poll_vote (poll, did) where status in ('counted', 'deleted')`.execute(
        db,
      )
      await sql`create index poll_vote_poll_idx on poll_vote (poll, status)`.execute(
        db,
      )
      await sql`create index poll_vote_did_idx on poll_vote (did)`.execute(db)
      await db.schema
        .createTable('poll_vote_wallet')
        .addColumn('poll', 'varchar', (col) => col.notNull())
        .addColumn('address', 'varchar', (col) => col.notNull())
        .addColumn('vote', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('poll_vote_wallet_pkey', ['poll', 'address'])
        .execute()
      await sql`create index poll_vote_wallet_vote_idx on poll_vote_wallet (vote)`.execute(
        db,
      )
    },
  },
  '006-tokens': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('token')
        .addColumn('key', 'varchar', (col) => col.primaryKey())
        .addColumn('symbol', 'varchar', (col) => col.notNull())
        .addColumn('name', 'varchar', (col) => col.notNull())
        .addColumn('chain', 'varchar', (col) => col.notNull())
        .addColumn('address', 'varchar', (col) => col.notNull())
        .addColumn('decimals', 'integer', (col) => col.notNull())
        .addColumn('quote', 'varchar', (col) => col.notNull())
        .addColumn('pool', 'varchar')
        .addColumn('logo', 'varchar')
        .addColumn('source', 'varchar', (col) => col.notNull())
        .addColumn('removed', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('priceUsd', 'varchar')
        .addColumn('updatedAt', 'varchar')
        .addColumn('addedAt', 'varchar', (col) => col.notNull())
        .execute()
      await db.schema
        .createTable('token_price')
        .addColumn('key', 'varchar', (col) => col.notNull())
        .addColumn('t', 'varchar', (col) => col.notNull())
        .addColumn('priceUsd', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('token_price_pkey', ['key', 't'])
        .execute()
      await sql`create index token_price_time_idx on token_price (t)`.execute(
        db,
      )
      await db.schema
        .createTable('post_cashtag')
        .addColumn('uri', 'varchar', (col) => col.notNull())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('key', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('post_cashtag_pkey', ['uri', 'key'])
        .execute()
      await sql`create index post_cashtag_feed_idx on post_cashtag (key, indexedAt, uri)`.execute(
        db,
      )
      await sql`create index post_cashtag_did_idx on post_cashtag (did)`.execute(
        db,
      )
    },
  },
  '007-memberships': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .alterTable('tip')
        .addColumn('anonymous', 'integer', (col) => col.notNull().defaultTo(0))
        .execute()
      await db.schema
        .createTable('membership_plan')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('cid', 'varchar', (col) => col.notNull())
        .addColumn('name', 'varchar', (col) => col.notNull())
        .addColumn('description', 'varchar')
        .addColumn('priceUsdc', 'varchar', (col) => col.notNull())
        .addColumn('perks', 'varchar', (col) => col.notNull())
        .addColumn('active', 'integer', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index membership_plan_did_idx on membership_plan (did)`.execute(
        db,
      )
      await db.schema
        .createTable('membership_payment')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('creator', 'varchar', (col) => col.notNull())
        .addColumn('plan', 'varchar', (col) => col.notNull())
        .addColumn('chain', 'varchar', (col) => col.notNull())
        .addColumn('txHash', 'varchar', (col) => col.notNull())
        .addColumn('status', 'varchar', (col) => col.notNull())
        .addColumn('reason', 'varchar')
        .addColumn('amount', 'varchar')
        .addColumn('blockTime', 'varchar')
        .addColumn('periodStart', 'varchar')
        .addColumn('periodEnd', 'varchar')
        .addColumn('nextCheckAt', 'varchar')
        .addColumn('pendingSince', 'varchar')
        .addColumn('publishedAt', 'varchar', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      // As for tips: a transaction backs one verified payment
      await sql`create unique index membership_payment_tx_verified_idx on membership_payment (txHash) where status = 'verified'`.execute(
        db,
      )
      await sql`create index membership_payment_tx_idx on membership_payment (txHash)`.execute(
        db,
      )
      await sql`create index membership_payment_pair_idx on membership_payment (creator, did)`.execute(
        db,
      )
      await sql`create index membership_payment_did_idx on membership_payment (did, indexedAt)`.execute(
        db,
      )
      await sql`create index membership_payment_plan_idx on membership_payment (plan, periodEnd)`.execute(
        db,
      )
      await sql`create index membership_payment_status_idx on membership_payment (status, nextCheckAt)`.execute(
        db,
      )
      await db.schema
        .createTable('creator_member')
        .addColumn('creator', 'varchar', (col) => col.notNull())
        .addColumn('member', 'varchar', (col) => col.notNull())
        .addColumn('since', 'varchar', (col) => col.notNull())
        .addColumn('expiresAt', 'varchar', (col) => col.notNull())
        .addColumn('firstAt', 'varchar', (col) => col.notNull())
        .addColumn('updatedAt', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('creator_member_pkey', ['creator', 'member'])
        .execute()
      await sql`create index creator_member_expiry_idx on creator_member (creator, expiresAt, member)`.execute(
        db,
      )
      await sql`create index creator_member_member_idx on creator_member (member)`.execute(
        db,
      )
      await db.schema
        .createTable('follower_loss')
        .addColumn('subject', 'varchar', (col) => col.notNull())
        .addColumn('followedAt', 'varchar', (col) => col.notNull())
        .addColumn('lostAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index follower_loss_idx on follower_loss (subject, lostAt)`.execute(
        db,
      )
      await sql`create index follower_loss_time_idx on follower_loss (lostAt)`.execute(
        db,
      )
      // Dashboards count recent tips per recipient
      await sql`create index tip_recipient_time_idx on tip (recipient, createdAt)`.execute(
        db,
      )
    },
  },
  /*
   * Growth (M32): Basename/ENS names of accounts (every account with a
   * verified EVM wallet is checked once), the rewards outbox, and Vietnamese
   * posts for the "Tiếng Việt" feed (posts indexed before stay out: their
   * text is not kept).
   */
  '008-growth': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .alterTable('wallet')
        .addColumn('showPrimaryName', 'integer', (col) =>
          col.notNull().defaultTo(1),
        )
        .execute()
      await db.schema
        .alterTable('feed_post')
        .addColumn('vi', 'integer', (col) => col.notNull().defaultTo(0))
        .execute()
      await sql`create index feed_post_vi_idx on feed_post (indexedAt, cid) where vi = 1`.execute(
        db,
      )
      await db.schema
        .createTable('primary_name')
        .addColumn('did', 'varchar', (col) => col.primaryKey())
        .addColumn('name', 'varchar')
        .addColumn('source', 'varchar')
        .addColumn('address', 'varchar')
        .addColumn('checkedAt', 'varchar')
        .addColumn('attemptedAt', 'varchar')
        .addColumn('stale', 'integer', (col) => col.notNull())
        .execute()
      await sql`insert into primary_name (did, stale) select distinct did, 1 from wallet where status = 'verified' and evmAddress is not null`.execute(
        db,
      )
      await db.schema
        .createTable('rewards_outbox')
        .addColumn('id', 'varchar', (col) => col.primaryKey())
        .addColumn('type', 'varchar', (col) => col.notNull())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('sentAt', 'varchar')
        .addColumn('attempts', 'integer', (col) => col.notNull())
        .addColumn('nextAttemptAt', 'varchar', (col) => col.notNull())
        .addColumn('error', 'varchar')
        .execute()
      await sql`create index rewards_outbox_due_idx on rewards_outbox (nextAttemptAt) where sentAt is null`.execute(
        db,
      )
      await sql`create index rewards_outbox_did_idx on rewards_outbox (did)`.execute(
        db,
      )
    },
  },
  /*
   * Wallets that earned a wallet.linked reward, so that unlinking a wallet
   * and linking it to another account earns nothing. Filled with the
   * wallets of accounts already queued.
   */
  '009-rewarded-wallet': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('rewarded_wallet')
        .addColumn('wallet', 'varchar', (col) => col.primaryKey())
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`insert or ignore into rewarded_wallet (wallet, createdAt) select coalesce(w.evmAddress, w.account), o.createdAt from wallet w join rewards_outbox o on o.did = w.did and o.type = 'wallet.linked' where w.status = 'verified'`.execute(
        db,
      )
    },
  },
  /*
   * Growth, part 2 (M33): activity days in the rewards outbox, approved NFT
   * collections for the on-chain profile tab, and lookups of an account's
   * support (tips it sent, payments it received)
   */
  '010-onchain-profile': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .alterTable('rewards_outbox')
        .addColumn('day', 'varchar')
        .execute()
      await sql`create index rewards_outbox_sent_idx on rewards_outbox (type, sentAt)`.execute(
        db,
      )
      await db.schema
        .createTable('nft_collection')
        .addColumn('chain', 'varchar', (col) => col.notNull())
        .addColumn('contract', 'varchar', (col) => col.notNull())
        .addColumn('name', 'varchar')
        .addColumn('standard', 'varchar', (col) => col.notNull())
        .addColumn('addedBy', 'varchar', (col) => col.notNull())
        .addColumn('addedAt', 'varchar', (col) => col.notNull())
        .addPrimaryKeyConstraint('nft_collection_pkey', ['chain', 'contract'])
        .execute()
      await sql`create index tip_sender_time_idx on tip (did, createdAt)`.execute(
        db,
      )
      await sql`create index membership_payment_creator_time_idx on membership_payment (creator, createdAt)`.execute(
        db,
      )
    },
  },
  /** M34: Mini Apps and their review */
  '011-miniapps': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('miniapp')
        .addColumn('uri', 'varchar', (col) => col.primaryKey())
        .addColumn('did', 'varchar', (col) => col.notNull())
        .addColumn('cid', 'varchar', (col) => col.notNull())
        .addColumn('name', 'varchar', (col) => col.notNull())
        .addColumn('description', 'varchar')
        .addColumn('url', 'varchar', (col) => col.notNull())
        .addColumn('origin', 'varchar', (col) => col.notNull())
        .addColumn('iconCid', 'varchar')
        .addColumn('iconMime', 'varchar')
        .addColumn('permissions', 'varchar', (col) => col.notNull())
        .addColumn('chains', 'varchar')
        .addColumn('invalidReason', 'varchar')
        .addColumn('approvedCid', 'varchar')
        .addColumn('approvedAt', 'varchar')
        .addColumn('approvedBy', 'varchar')
        .addColumn('revokedAt', 'varchar')
        .addColumn('revokedReason', 'varchar')
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('indexedAt', 'varchar', (col) => col.notNull())
        .execute()
      await sql`create index miniapp_did_idx on miniapp (did)`.execute(db)
      await sql`create index miniapp_approved_idx on miniapp (approvedAt, uri)`.execute(
        db,
      )
      await sql`create index miniapp_indexed_idx on miniapp (indexedAt, uri)`.execute(
        db,
      )
    },
  },
  /** M35: admin actions for the shared admin log at the rewards service */
  '012-admin-audit': {
    up: async (db: Kysely<any>) => {
      await db.schema
        .createTable('admin_audit_outbox')
        .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
        .addColumn('key', 'varchar', (col) => col.notNull())
        .addColumn('service', 'varchar', (col) => col.notNull())
        .addColumn('actor', 'varchar', (col) => col.notNull())
        .addColumn('action', 'varchar', (col) => col.notNull())
        .addColumn('subject', 'varchar')
        .addColumn('details', 'varchar')
        .addColumn('createdAt', 'varchar', (col) => col.notNull())
        .addColumn('sentAt', 'varchar')
        .addColumn('attempts', 'integer', (col) => col.notNull())
        .addColumn('nextAttemptAt', 'varchar', (col) => col.notNull())
        .addColumn('error', 'varchar')
        .execute()
      await sql`create index admin_audit_outbox_due_idx on admin_audit_outbox (nextAttemptAt) where sentAt is null`.execute(
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
