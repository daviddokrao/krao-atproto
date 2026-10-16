import type { EvmRpcForChain } from '@krao/wallet'
import type { IdResolver } from '@atproto/identity'
import { type Cid, type LexMap, lexParse } from '@atproto/lex'
import { type Event, Firehose } from '@atproto/sync'
import { AtUri } from '@atproto/syntax'
import type { EvmRpc } from './chain.js'
import type { Database } from './db.js'
import {
  FEED_GENERATOR_COLLECTION,
  LIKE_COLLECTION,
  POST_COLLECTION,
  REPOST_COLLECTION,
  deleteFeedDataForDid,
  deleteFeedGenerator,
  deleteFeedInteraction,
  deleteFeedPost,
  pruneOldDiscoveryData,
  feedInteractionRowFromRecord,
  feedPostRowFromRecord,
  upsertFeedGenerator,
  upsertFeedInteraction,
  upsertFeedPost,
} from './feed.js'
import {
  FOLLOW_COLLECTION,
  STARTER_PACK_COLLECTION,
  deleteStarterPack,
  upsertStarterPack,
  deleteDiscoveryDataForDid,
  deleteFeedFollow,
  deletePostTags,
  feedFollowRowFromRecord,
  postTags,
  setPostTags,
  upsertFeedFollow,
} from './discovery.js'
import {
  COMMUNITY_COLLECTION,
  COMMUNITY_COLLECTIONS,
  APPROVAL_COLLECTION,
  MEMBERSHIP_COLLECTION,
  MODERATOR_COLLECTION,
  SUBMISSION_COLLECTION,
  actionRowFromRecord,
  communityRowFromRecord,
  deleteCommunity,
  deleteCommunityDataForDid,
  deleteCommunityRecord,
  deleteSubmissionsForPost,
  isActionCollection,
  isRewardableJoin,
  membershipRowFromRecord,
  recheckMemberships,
  submissionRowFromRecord,
  upsertAction,
  upsertCommunity,
  upsertMembership,
  upsertSubmission,
} from './community.js'
import {
  deleteFollowerLossesForDid,
  pruneFollowerLosses,
  recordFollowerLoss,
} from './creator.js'
import { deleteOrphanedMedia } from './gate-media.js'
import type { HumanCheck } from './human.js'
import {
  type NameRpc,
  deletePrimaryName,
  markPrimaryNameStale,
  markPrimaryNamesStaleForAddresses,
  refreshPrimaryNames,
} from './names.js'
import {
  type AccountEvent,
  type RewardsEventSender,
  deleteAccountEventsForDid,
  deliverAccountEvents,
  pruneSentActivityDays,
  queueAccountEvent,
  queueActivityDay,
  queueWalletLinked,
  vnDay,
} from './rewards-events.js'
import {
  PAYMENT_COLLECTION,
  PLAN_COLLECTION,
  deleteMembershipDataForDid,
  deletePayment,
  deletePlan,
  getPaymentsByUri,
  getPendingPayments,
  paymentRowFromRecord,
  planRowFromRecord,
  upsertPayment,
  upsertPlan,
  verifyPayment,
} from './membership.js'
import { type MediaBlobStore, purgeMediaTrash } from './media-store.js'
import {
  POLL_COLLECTION,
  VOTE_COLLECTION,
  deletePoll,
  deletePollDataForDid,
  deletePollsForPost,
  deleteVote,
  indexPoll,
  indexVote,
  pollRowFromRecord,
} from './poll.js'
import type { PushClient } from './push-client.js'
import {
  type SafetyList,
  deletePostLinks,
  postLinkHosts,
  setPostLinks,
} from './safety.js'
import {
  type TokenCatalog,
  deleteCashtagsForDid,
  deletePostCashtags,
} from './token.js'
import {
  GATE_RULE_COLLECTION,
  deleteContentWithoutRule,
  deleteGateDataForDid,
  deleteGateDataForSubject,
  deleteGateRule,
  gateRuleRowFromRecord,
  upsertGateRule,
} from './gate.js'
import {
  NFT_AVATAR_COLLECTION,
  deleteNftAvatar,
  getNftAvatarsToRecheck,
  markNftAvatarStale,
  nftAvatarRowFromRecord,
  upsertNftAvatar,
  verifyNftAvatar,
} from './nft.js'
import {
  TIP_COLLECTION,
  deleteTip,
  deleteTipsForDid,
  getPendingTips,
  getTipsByUri,
  tipRowFromRecord,
  upsertTip,
  verifyTip,
} from './tips.js'
import {
  WALLET_COLLECTION,
  deleteWallet,
  deleteWalletsForDid,
  getWalletOwners,
  upsertWallet,
  walletRowFromRecord,
} from './wallets.js'

const CURSOR_ID = 'firehose'

/**
 * Account states whose data is not served. Others a relay may report
 * (desynchronized, throttled) say nothing about the account itself.
 */
const HIDDEN_STATUSES = new Set(['takendown', 'suspended', 'deactivated'])

/** Delays before retrying an event whose handler failed */
const EVENT_RETRY_DELAYS_MS = [200, 1_000, 5_000]

/** Invalid NFT avatars are re-checked this many times less often */
const INVALID_NFT_RECHECK_FACTOR = 6

/** Activity days remembered as queued, to spare the database a write */
const ACTIVITY_MEMORY = 50_000

export type FeedIndexingOptions = {
  /** DID of the feed generator service; posts are only indexed when set */
  did?: string
  /**
   * Only index posts by accounts hosted on this PDS (eg https://pds.krao.net),
   * for firehoses that carry the whole network. Unset, every post counts.
   */
  pdsUrl?: string
}

/** Consumes a repo firehose and indexes net.krao.* records. */
export class FirehoseIndexer {
  private firehose: Firehose
  private pdsByDid = new Map<string, string | undefined>()

  constructor(
    private db: Database,
    private rpcs: Map<string, EvmRpc>,
    private idResolver: IdResolver,
    private service: string,
    onError: (err: Error) => void,
    private nftRecheckMs = 10 * 60 * 1000,
    private feed: FeedIndexingOptions = {},
  ) {
    this.firehose = new Firehose({
      idResolver,
      service,
      filterCollections: [
        WALLET_COLLECTION,
        TIP_COLLECTION,
        NFT_AVATAR_COLLECTION,
        GATE_RULE_COLLECTION,
        // Always: a deleted post takes its gated content with it
        POST_COLLECTION,
        ...COMMUNITY_COLLECTIONS,
        POLL_COLLECTION,
        VOTE_COLLECTION,
        PLAN_COLLECTION,
        PAYMENT_COLLECTION,
        ...(feed.did
          ? [
              FEED_GENERATOR_COLLECTION,
              LIKE_COLLECTION,
              REPOST_COLLECTION,
              FOLLOW_COLLECTION,
              STARTER_PACK_COLLECTION,
            ]
          : []),
      ],
      excludeIdentity: true,
      excludeSync: true,
      getCursor: () => this.getCursor(),
      handleEvent: (evt) => this.handleEvent(evt),
      onError,
    })
  }

  private verifyTimer?: NodeJS.Timeout
  private cleanupTimer?: NodeJS.Timeout
  /** Tips indexed since the last round, checked before the backlog */
  private freshTips = new Set<string>()
  /** Membership payments indexed since the last round, likewise */
  private freshPayments = new Set<string>()
  // Separate rounds: slow NFT metadata must not hold up tips, and back.
  // Tips and membership payments share one: one transaction backs only one
  // of them, which checking them one at a time keeps true.
  private tipRound = new Round('tip', async () => {
    await this.verifyPendingTips()
    await this.verifyPendingPayments()
  })
  private nftRound = new Round('NFT avatar', () => this.recheckNftAvatars())
  private membershipRound = new Round('community membership', () =>
    this.recheckMemberships(),
  )
  private nameRound = new Round('primary name', () =>
    this.refreshPrimaryNames(),
  )
  private rewardsRound = new Round('rewards event', () =>
    this.deliverRewardsEvents(),
  )

  start() {
    void this.firehose.start()
    void this.syncHiddenActorsWithRetry()
    // Re-check tips whose transactions were not confirmed yet
    this.verifyTimer = setInterval(() => this.kickVerification(), 5_000)
    // Gated content without a rule, then uploads nobody attached to a post
    this.cleanupTimer = setInterval(
      () =>
        void deleteContentWithoutRule(this.db)
          .then(() => deleteOrphanedMedia(this.db))
          .then(() => purgeMediaTrash(this.db, this.mediaBlobs))
          .then(() => pruneOldDiscoveryData(this.db))
          .then(() => pruneFollowerLosses(this.db))
          .then(() => pruneSentActivityDays(this.db))
          .catch((err: unknown) =>
            console.error('Krao indexer: gated media cleanup failed', err),
          ),
      60 * 60 * 1000,
    )
  }

  /** Where gated media bytes live when not in the database */
  mediaBlobs?: MediaBlobStore
  /** Tells tip recipients when set */
  push?: PushClient
  /** Flags posts that link to unsafe domains when set */
  safety?: SafetyList
  /** Indexes cashtags of catalog tokens in posts when set */
  tokens?: TokenCatalog
  /** Checks smart contract wallet links on chain when set */
  walletRpc?: EvmRpcForChain
  /**
   * Krao's verification (rewards service), for "verified" communities and
   * polls; without it nobody counts as verified
   */
  human?: HumanCheck
  /** How often memberships of condition and verified communities are re-checked */
  membershipRecheckMs = 10 * 60 * 1000
  /**
   * Where account events (first verified wallet, first post) go: the
   * rewards service. Unset, none are queued.
   */
  rewardsEvents?: RewardsEventSender
  /** Ethereum mainnet, for ENS names (Basenames use the Base RPC) */
  ensRpc?: NameRpc

  private destroyed = false

  async destroy() {
    this.destroyed = true
    clearInterval(this.verifyTimer)
    clearInterval(this.cleanupTimer)
    await this.firehose.destroy()
    await this.verificationIdle()
  }

  /**
   * Accounts the PDS already reports as inactive: account events from
   * before this indexer (or this table) existed are not replayed.
   */
  async syncHiddenActors() {
    const base = this.service.replace(/^ws/, 'http')
    let cursor: string | undefined
    do {
      const url = new URL('/xrpc/com.atproto.sync.listRepos', base)
      url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set('cursor', cursor)
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`listRepos: HTTP ${res.status}`)
      const page = (await res.json()) as {
        cursor?: string
        repos?: { did: string; active?: boolean; status?: string }[]
      }
      for (const repo of page.repos ?? []) {
        if (repo.active !== false) {
          // Reactivated while the indexer was not following
          await this.db
            .deleteFrom('hidden_actor')
            .where('did', '=', repo.did)
            .execute()
        } else if (HIDDEN_STATUSES.has(repo.status ?? '')) {
          await this.db
            .insertInto('hidden_actor')
            .values({
              did: repo.did,
              status: repo.status!,
              since: new Date().toISOString(),
            })
            .onConflict((oc) => oc.column('did').doNothing())
            .execute()
        }
      }
      cursor = page.repos?.length ? page.cursor : undefined
    } while (cursor)
  }

  /** syncHiddenActors, retried with backoff (the PDS may start later) */
  private async syncHiddenActorsWithRetry() {
    for (
      let delay = 5_000;
      !this.destroyed;
      delay = Math.min(delay * 2, 300_000)
    ) {
      try {
        await this.syncHiddenActors()
        return
      } catch (err) {
        console.error('Krao indexer: could not load inactive accounts', err)
        await new Promise((resolve) => setTimeout(resolve, delay).unref())
      }
    }
  }

  /** Run on-chain verification of tips and NFT avatars in the background */
  kickVerification() {
    this.tipRound.kick()
    this.nftRound.kick()
    this.membershipRound.kick()
    this.nameRound.kick()
    this.rewardsRound.kick()
  }

  /** Resolves once the current verification rounds, if any, are done */
  async verificationIdle() {
    await Promise.all([
      this.tipRound.idle(),
      this.nftRound.idle(),
      this.membershipRound.idle(),
      this.nameRound.idle(),
      this.rewardsRound.idle(),
    ])
  }

  /** Basename/ENS names of accounts whose wallets changed, and daily */
  async refreshPrimaryNames() {
    await refreshPrimaryNames(this.db, {
      base: this.rpcs.get('eip155:8453'),
      ens: this.ensRpc,
    })
  }

  /** Sends queued account events to the rewards service */
  async deliverRewardsEvents() {
    if (this.rewardsEvents) {
      await deliverAccountEvents(this.db, this.rewardsEvents)
    }
  }

  /** Queues an account event for the rewards service (once per account) */
  private async queueRewardsEvent(type: AccountEvent, did: string) {
    if (!this.rewardsEvents) return
    if (await queueAccountEvent(this.db, type, did)) this.rewardsRound.kick()
  }

  /** `did:day` of activity days queued lately */
  private activitySeen = new Set<string>()

  /**
   * A Krao account created a record at `time` (the firehose event's time):
   * the day it falls on (Vietnam time) is a day the account was active
   */
  private async noteActivity(did: string, time: string) {
    if (!this.rewardsEvents) return
    const at = Date.parse(time)
    const when = isNaN(at) ? Date.now() : at
    const key = `${did}:${vnDay(when)}`
    if (this.activitySeen.has(key)) return
    if (!(await this.isKraoAccount(did))) return
    if (await queueActivityDay(this.db, did, when)) this.rewardsRound.kick()
    if (this.activitySeen.size >= ACTIVITY_MEMORY) this.activitySeen.clear()
    this.activitySeen.add(key)
  }

  /**
   * `did` may have just become a member of `community`: its first such
   * community, if it counts (see isRewardableJoin), is rewarded
   */
  private async communityJoined(community: string, did: string) {
    if (!this.rewardsEvents) return
    // Membership rechecks call this for every eligible member: skip the
    // member count (a scan of the community) when it cannot matter
    const queued = await this.db
      .selectFrom('rewards_outbox')
      .select('id')
      .where('id', '=', `community.joined:${did}`)
      .executeTakeFirst()
    if (queued) return
    if (!(await this.isKraoAccount(did))) return
    if (!(await isRewardableJoin(this.db, community, did))) return
    await this.queueRewardsEvent('community.joined', did)
  }

  /** What community and poll checks need */
  get checks() {
    return {
      rpcs: this.rpcs,
      human: this.human,
      onEligible: (community: string, did: string) =>
        this.communityJoined(community, did),
    }
  }

  /** New memberships right away, others every `membershipRecheckMs` */
  async recheckMemberships() {
    const due = new Date(Date.now() - this.membershipRecheckMs).toISOString()
    await recheckMemberships(this.db, this.checks, due)
  }

  /**
   * NFTs can be sold or moved at any time, so avatars are re-checked: new
   * ones right away, others every `nftRecheckMs` (invalid ones less often).
   */
  async recheckNftAvatars() {
    const now = Date.now()
    const due = new Date(now - this.nftRecheckMs).toISOString()
    const invalidDue = new Date(
      now - this.nftRecheckMs * INVALID_NFT_RECHECK_FACTOR,
    ).toISOString()
    for (const row of await getNftAvatarsToRecheck(this.db, due, invalidDue)) {
      await verifyNftAvatar(this.db, this.rpcs, row).catch((err: unknown) =>
        console.error('Krao indexer: NFT avatar check failed', row.did, err),
      )
    }
  }

  /**
   * Tips indexed since the last round go first: the backlog of pending tips
   * (which may hold many that never confirm) must not hold up new ones.
   */
  async verifyPendingTips() {
    const fresh = [...this.freshTips]
    this.freshTips.clear()
    const rows = [
      ...(await getTipsByUri(this.db, fresh)),
      ...(await getPendingTips(this.db)).filter((t) => !fresh.includes(t.uri)),
    ]
    for (const tip of rows) {
      const status = await verifyTip(this.db, this.rpcs, tip).catch(
        (err: unknown) => {
          console.error('Krao indexer: tip check failed', tip.uri, err)
          return tip.status
        },
      )
      // The sender's first verified tip (for the analytics funnel)
      if (status === 'verified' && tip.status !== 'verified') {
        if (await this.isKraoAccount(tip.did)) {
          await this.queueRewardsEvent('tip.first', tip.did)
        }
      }
      // Only news: not tips found again when the firehose is replayed
      if (
        status === 'verified' &&
        tip.status !== 'verified' &&
        Date.now() - Date.parse(tip.indexedAt) < 24 * 60 * 60 * 1000
      ) {
        this.push?.notify({
          kind: 'tip',
          id: tip.uri,
          recipientDid: tip.recipient,
          senderDid: tip.did,
          ...(tip.subject ? { subject: tip.subject } : {}),
          ...(tip.message ? { message: tip.message } : {}),
        })
      }
    }
  }

  /** Membership payments, as verifyPendingTips does for tips */
  async verifyPendingPayments() {
    const fresh = [...this.freshPayments]
    this.freshPayments.clear()
    const rows = [
      ...(await getPaymentsByUri(this.db, fresh)),
      ...(await getPendingPayments(this.db)).filter(
        (p) => !fresh.includes(p.uri),
      ),
    ]
    for (const payment of rows) {
      await verifyPayment(this.db, this.rpcs, payment).catch((err: unknown) =>
        console.error('Krao indexer: payment check failed', payment.uri, err),
      )
    }
  }

  /**
   * Index one event. A failing handler is retried, then recorded in
   * `failed_event` so the cursor can move on without silently losing it.
   */
  async handleEvent(evt: Event): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.indexEvent(evt)
        break
      } catch (err) {
        const delay = EVENT_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) {
          console.error('Krao indexer: giving up on event', evt.seq, err)
          await this.recordFailedEvent(evt, err)
          break
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    await this.setCursor(evt.seq)
  }

  /**
   * Indexes the events in `failed_event` again, oldest first, from the
   * current state of the PDS this indexer follows: a record that still exists
   * is indexed as an update, one that is gone as a delete, and an account
   * event from the account's current status. Rows that index are removed;
   * rows that fail again keep their place with the new error.
   */
  async replayFailedEvents(
    limit = 100,
  ): Promise<{ replayed: number; failed: number; remaining: number }> {
    const rows = await this.db
      .selectFrom('failed_event')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit)
      .execute()
    let replayed = 0
    let failed = 0
    for (const row of rows) {
      try {
        const evt = await this.currentEvent(row)
        if (evt) await this.indexEvent(evt)
        await this.db
          .deleteFrom('failed_event')
          .where('id', '=', row.id)
          .execute()
        replayed++
      } catch (err) {
        await this.db
          .updateTable('failed_event')
          .set({
            error: String((err as Error)?.message ?? err).slice(0, 1000),
            failedAt: new Date().toISOString(),
          })
          .where('id', '=', row.id)
          .execute()
        failed++
      }
    }
    const left = await this.db
      .selectFrom('failed_event')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst()
    // Still in the table, including the rows that failed again
    return { replayed, failed, remaining: Number(left?.count ?? 0) }
  }

  /** The event to index now in place of a failed one (undefined: nothing) */
  private async currentEvent(row: {
    seq: number
    did: string
    event: string
    uri: string | null
  }): Promise<Event | undefined> {
    const base = this.service.replace(/^ws/, 'http')
    const time = new Date().toISOString()
    if (row.event === 'account') {
      const url = new URL('/xrpc/com.atproto.sync.getRepoStatus', base)
      url.searchParams.set('did', row.did)
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      const body = (await res.json().catch(() => ({}))) as {
        active?: boolean
        status?: string
        error?: string
      }
      if (!res.ok && body.error !== 'RepoNotFound') {
        throw new Error(`getRepoStatus: HTTP ${res.status}`)
      }
      return {
        seq: row.seq,
        time,
        event: 'account',
        did: row.did,
        active: res.ok ? body.active !== false : false,
        status: res.ok ? body.status : 'deleted',
      } as Event
    }
    if (!row.uri) return undefined
    const uri = new AtUri(row.uri)
    const url = new URL('/xrpc/com.atproto.repo.getRecord', base)
    url.searchParams.set('repo', uri.host)
    url.searchParams.set('collection', uri.collection)
    url.searchParams.set('rkey', uri.rkey)
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const body = (await res.json().catch(() => ({}))) as {
      cid?: string
      value?: unknown
      error?: string
    }
    const meta = {
      seq: row.seq,
      time,
      uri,
      did: row.did,
      collection: uri.collection,
      rkey: uri.rkey,
    }
    if (!res.ok) {
      if (body.error === 'RecordNotFound' || body.error === 'RepoNotFound') {
        return { ...meta, event: 'delete' } as unknown as Event
      }
      throw new Error(`getRecord: HTTP ${res.status}`)
    }
    // As the firehose has it: CIDs and bytes as objects, not JSON
    const parsed = lexParse<{ value: LexMap; cid: Cid }>(
      JSON.stringify({ value: body.value, cid: { $link: body.cid } }),
    )
    return {
      ...meta,
      event: 'update',
      record: parsed.value,
      cid: parsed.cid,
    } as unknown as Event
  }

  private async recordFailedEvent(evt: Event, err: unknown) {
    const uri = 'uri' in evt ? evt.uri.toString() : null
    await this.db
      .insertInto('failed_event')
      .values({
        seq: evt.seq,
        did: evt.did,
        event: evt.event,
        uri,
        error: String((err as Error)?.message ?? err).slice(0, 1000),
        failedAt: new Date().toISOString(),
      })
      .execute()
  }

  private async indexEvent(evt: Event): Promise<void> {
    // Any record an account creates makes it active that day (M33)
    if (evt.event === 'create') await this.noteActivity(evt.did, evt.time)
    if (evt.event === 'create' || evt.event === 'update') {
      if (evt.collection === WALLET_COLLECTION) {
        const row = await walletRowFromRecord(
          evt.uri.toString(),
          evt.did,
          evt.record,
          this.walletRpc,
        )
        await upsertWallet(this.db, row)
        await markNftAvatarStale(this.db, evt.did)
        await markPrimaryNameStale(this.db, evt.did)
        this.nameRound.kick()
        // The account's first verified wallet, unless another account
        // linked it first or it earned another account its reward before
        // (one wallet cannot earn for many accounts, even one at a time)
        if (
          this.rewardsEvents &&
          row.status === 'verified' &&
          (await this.isKraoAccount(evt.did)) &&
          (await getWalletOwners(this.db, row.account)).includes(evt.did) &&
          (await queueWalletLinked(
            this.db,
            evt.did,
            row.evmAddress ?? row.account,
          ))
        ) {
          this.rewardsRound.kick()
        }
      } else if (evt.collection === TIP_COLLECTION) {
        const row = tipRowFromRecord(evt.uri.toString(), evt.did, evt.record)
        await upsertTip(this.db, row)
        // Verified by the background worker: a slow RPC must not stall indexing
        this.freshTips.add(row.uri)
        this.tipRound.kick()
      } else if (evt.collection === PLAN_COLLECTION) {
        const row = planRowFromRecord(
          evt.uri.toString(),
          evt.did,
          evt.cid.toString(),
          evt.record,
        )
        if (row) await upsertPlan(this.db, row)
        else await deletePlan(this.db, evt.uri.toString())
      } else if (evt.collection === PAYMENT_COLLECTION) {
        const row = paymentRowFromRecord(
          evt.uri.toString(),
          evt.did,
          evt.record,
          evt.time,
        )
        if (row) {
          await upsertPayment(this.db, row)
          this.freshPayments.add(row.uri)
          this.tipRound.kick()
        } else {
          await deletePayment(this.db, evt.uri.toString())
        }
      } else if (evt.collection === GATE_RULE_COLLECTION) {
        const row = gateRuleRowFromRecord(
          evt.uri.toString(),
          evt.did,
          evt.record,
        )
        if (row) await upsertGateRule(this.db, row)
        else await deleteGateRule(this.db, evt.uri.toString())
      } else if (evt.collection === NFT_AVATAR_COLLECTION) {
        const row = nftAvatarRowFromRecord(
          evt.uri.toString(),
          evt.did,
          evt.record,
        )
        await upsertNftAvatar(this.db, row)
        this.nftRound.kick()
      } else if (evt.collection === POST_COLLECTION) {
        // Any post (replies too) of a Krao account: its first one is rewarded
        if (await this.isKraoAccount(evt.did)) {
          await this.queueRewardsEvent('post.first', evt.did)
        }
        if (await this.isFeedAuthor(evt.did)) {
          const row = feedPostRowFromRecord(
            evt.uri.toString(),
            evt.cid.toString(),
            evt.did,
            evt.record,
          )
          if (row) await upsertFeedPost(this.db, row)
          await setPostTags(
            this.db,
            evt.uri.toString(),
            evt.did,
            postTags(evt.record),
          )
          await setPostLinks(
            this.db,
            evt.uri.toString(),
            evt.did,
            postLinkHosts(evt.record),
            this.safety?.matcher,
          )
          await this.tokens?.indexPost(evt.uri.toString(), evt.did, evt.record)
        }
      } else if (evt.collection === STARTER_PACK_COLLECTION) {
        if (await this.isFeedAuthor(evt.did)) {
          await upsertStarterPack(this.db, evt.uri.toString(), evt.did)
        }
      } else if (evt.collection === FOLLOW_COLLECTION) {
        if (await this.isFeedAuthor(evt.did)) {
          const row = feedFollowRowFromRecord(
            evt.uri.toString(),
            evt.did,
            evt.record,
          )
          if (row) await upsertFeedFollow(this.db, row)
        }
      } else if (
        evt.collection === LIKE_COLLECTION ||
        evt.collection === REPOST_COLLECTION
      ) {
        if (await this.isFeedAuthor(evt.did)) {
          const row = feedInteractionRowFromRecord(
            evt.uri.toString(),
            evt.did,
            evt.collection,
            evt.record,
          )
          if (row) await upsertFeedInteraction(this.db, row)
        }
      } else if (COMMUNITY_COLLECTIONS.includes(evt.collection)) {
        await this.indexCommunityRecord(
          evt.collection,
          evt.uri.toString(),
          evt.cid.toString(),
          evt.did,
          evt.record,
        )
      } else if (evt.collection === POLL_COLLECTION) {
        const row = pollRowFromRecord(
          evt.uri.toString(),
          evt.did,
          evt.record,
          evt.time,
          this.rpcs,
        )
        if (row) await indexPoll(this.db, this.checks, row)
      } else if (evt.collection === VOTE_COLLECTION) {
        await indexVote(
          this.db,
          this.checks,
          evt.uri.toString(),
          evt.did,
          evt.record,
          evt.time,
        )
      } else if (evt.collection === FEED_GENERATOR_COLLECTION) {
        const record = (evt.record ?? {}) as Record<string, unknown>
        if (record.did === this.feed.did) {
          await upsertFeedGenerator(this.db, {
            uri: evt.uri.toString(),
            did: evt.did,
          })
        } else {
          await deleteFeedGenerator(this.db, evt.uri.toString())
        }
      }
    } else if (evt.event === 'delete') {
      if (evt.collection === WALLET_COLLECTION) {
        const gone = await this.db
          .selectFrom('wallet')
          .select('evmAddress')
          .where('uri', '=', evt.uri.toString())
          .executeTakeFirst()
        await deleteWallet(this.db, evt.uri.toString())
        await markNftAvatarStale(this.db, evt.did)
        await markPrimaryNameStale(this.db, evt.did)
        // Another account linking the same wallet may own it now
        await markPrimaryNamesStaleForAddresses(this.db, [
          gone?.evmAddress ?? null,
        ])
        this.nameRound.kick()
      } else if (evt.collection === TIP_COLLECTION) {
        await deleteTip(this.db, evt.uri.toString())
      } else if (evt.collection === PLAN_COLLECTION) {
        await deletePlan(this.db, evt.uri.toString())
      } else if (evt.collection === PAYMENT_COLLECTION) {
        await deletePayment(this.db, evt.uri.toString())
      } else if (evt.collection === NFT_AVATAR_COLLECTION) {
        await deleteNftAvatar(this.db, evt.did)
      } else if (evt.collection === GATE_RULE_COLLECTION) {
        await deleteGateRule(this.db, evt.uri.toString())
      } else if (evt.collection === POST_COLLECTION) {
        await deleteFeedPost(this.db, evt.uri.toString())
        await deletePostTags(this.db, evt.uri.toString())
        await deletePostLinks(this.db, evt.uri.toString())
        await deletePostCashtags(this.db, evt.uri.toString())
        await deleteGateDataForSubject(this.db, evt.uri.toString())
        await deleteSubmissionsForPost(this.db, evt.uri.toString())
        await deletePollsForPost(this.db, evt.uri.toString())
      } else if (evt.collection === COMMUNITY_COLLECTION) {
        await deleteCommunity(this.db, evt.uri.toString())
      } else if (COMMUNITY_COLLECTIONS.includes(evt.collection)) {
        await deleteCommunityRecord(this.db, evt.collection, evt.uri.toString())
      } else if (evt.collection === POLL_COLLECTION) {
        await deletePoll(this.db, evt.uri.toString())
      } else if (evt.collection === VOTE_COLLECTION) {
        await deleteVote(this.db, evt.uri.toString())
      } else if (evt.collection === FOLLOW_COLLECTION) {
        await recordFollowerLoss(this.db, evt.uri.toString())
        await deleteFeedFollow(this.db, evt.uri.toString())
      } else if (evt.collection === STARTER_PACK_COLLECTION) {
        await deleteStarterPack(this.db, evt.uri.toString())
      } else if (
        evt.collection === LIKE_COLLECTION ||
        evt.collection === REPOST_COLLECTION
      ) {
        await deleteFeedInteraction(this.db, evt.uri.toString())
      } else if (evt.collection === FEED_GENERATOR_COLLECTION) {
        await deleteFeedGenerator(this.db, evt.uri.toString())
      }
    } else if (evt.event === 'account') {
      if (evt.active) {
        await this.db
          .deleteFrom('hidden_actor')
          .where('did', '=', evt.did)
          .execute()
      } else if (HIDDEN_STATUSES.has(evt.status ?? '')) {
        // Taken down, suspended or deactivated: keep the data, stop serving it
        await this.db
          .insertInto('hidden_actor')
          .values({
            did: evt.did,
            status: evt.status ?? 'inactive',
            since: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.column('did').doUpdateSet({ status: evt.status ?? 'inactive' }),
          )
          .execute()
      }
      if (evt.status === 'deleted') {
        await this.db
          .deleteFrom('hidden_actor')
          .where('did', '=', evt.did)
          .execute()
        const gone = await this.db
          .selectFrom('wallet')
          .select('evmAddress')
          .where('did', '=', evt.did)
          .execute()
        await deleteWalletsForDid(this.db, evt.did)
        // Others linking the same wallets may own them now
        await markPrimaryNamesStaleForAddresses(
          this.db,
          gone.map((w) => w.evmAddress),
        )
        await deleteTipsForDid(this.db, evt.did)
        await deleteNftAvatar(this.db, evt.did)
        await deleteGateDataForDid(this.db, evt.did)
        await deleteFeedDataForDid(this.db, evt.did)
        await deleteCashtagsForDid(this.db, evt.did)
        await deleteDiscoveryDataForDid(this.db, evt.did)
        await deleteCommunityDataForDid(this.db, evt.did)
        await deletePollDataForDid(this.db, evt.did)
        await deleteMembershipDataForDid(this.db, evt.did)
        await deleteFollowerLossesForDid(this.db, evt.did)
        await deletePrimaryName(this.db, evt.did)
        await deleteAccountEventsForDid(this.db, evt.did)
      }
    }
  }

  /** A community record; one that breaks the rules is not (or no longer) indexed */
  private async indexCommunityRecord(
    collection: string,
    uri: string,
    cid: string,
    did: string,
    record: unknown,
  ) {
    if (collection === COMMUNITY_COLLECTION) {
      const row = communityRowFromRecord(uri, did, cid, record)
      if (row) await upsertCommunity(this.db, row)
      else await deleteCommunityRecord(this.db, collection, uri)
    } else if (collection === MEMBERSHIP_COLLECTION) {
      const row = membershipRowFromRecord(uri, did, record)
      if (row) {
        await upsertMembership(this.db, row)
        // Open communities: a member now. Condition and verified ones are
        // checked by the next round (onEligible)
        await this.communityJoined(row.community, did)
        this.membershipRound.kick()
      } else {
        await deleteCommunityRecord(this.db, collection, uri)
      }
    } else if (collection === SUBMISSION_COLLECTION) {
      const row = submissionRowFromRecord(uri, did, record)
      if (row) await upsertSubmission(this.db, row)
      else await deleteCommunityRecord(this.db, collection, uri)
    } else if (isActionCollection(collection)) {
      const row = actionRowFromRecord(collection, uri, did, record)
      if (row) {
        await upsertAction(this.db, collection, row)
        // Approved, or made a moderator: the subject may be a member now
        if (
          collection === APPROVAL_COLLECTION ||
          collection === MODERATOR_COLLECTION
        ) {
          await this.communityJoined(row.community, row.subject)
        }
      } else {
        await deleteCommunityRecord(this.db, collection, uri)
      }
    }
  }

  /** Whether the account's posts belong in the feed (see FeedIndexingOptions) */
  private async isFeedAuthor(did: string): Promise<boolean> {
    if (!this.feed.did) return false
    return this.isKraoAccount(did)
  }

  /**
   * Whether the account is hosted on Krao's PDS (FeedIndexingOptions.pdsUrl);
   * every account counts when it is not set (the firehose is Krao's PDS)
   */
  private async isKraoAccount(did: string): Promise<boolean> {
    if (!this.feed.pdsUrl) return true
    if (!this.pdsByDid.has(did)) {
      const data = await this.idResolver.did
        .resolveAtprotoData(did)
        .catch(() => undefined)
      // Accounts rarely move, and the cache only grows with active authors
      if (this.pdsByDid.size > 50_000) this.pdsByDid.clear()
      this.pdsByDid.set(did, data?.pds)
    }
    const pds = this.pdsByDid.get(did)
    return !!pds && new URL(pds).origin === new URL(this.feed.pdsUrl).origin
  }

  private async getCursor(): Promise<number | undefined> {
    const row = await this.db
      .selectFrom('cursor')
      .select('seq')
      .where('id', '=', CURSOR_ID)
      .executeTakeFirst()
    return row?.seq
  }

  private async setCursor(seq: number) {
    const at = new Date().toISOString()
    await this.db
      .insertInto('cursor')
      .values({ id: CURSOR_ID, seq, at })
      .onConflict((oc) => oc.column('id').doUpdateSet({ seq, at }))
      .execute()
  }
}

/**
 * Background work run one round at a time. A kick during a round queues
 * one more round, so records that arrived meanwhile are not left for the
 * next tick.
 */
class Round {
  private running?: Promise<void>
  private again = false

  constructor(
    private name: string,
    private work: () => Promise<void>,
  ) {}

  kick() {
    if (this.running) {
      this.again = true
      return
    }
    this.running = (async () => {
      do {
        this.again = false
        try {
          await this.work()
        } catch (err) {
          console.error(`Krao indexer: ${this.name} round failed`, err)
        }
      } while (this.again)
      // Cleared in the same tick the loop ends, so no kick falls in between
      this.running = undefined
    })()
  }

  async idle() {
    while (this.running) await this.running
  }
}
