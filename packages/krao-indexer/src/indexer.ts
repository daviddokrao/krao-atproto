import type { IdResolver } from '@atproto/identity'
import { type Event, Firehose } from '@atproto/sync'
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
import { deleteOrphanedMedia } from './gate-media.js'
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
  // Separate rounds: slow NFT metadata must not hold up tips, and back
  private tipRound = new Round('tip', () => this.verifyPendingTips())
  private nftRound = new Round('NFT avatar', () => this.recheckNftAvatars())

  start() {
    void this.firehose.start()
    void this.syncHiddenActors().catch((err: unknown) =>
      console.error('Krao indexer: could not load inactive accounts', err),
    )
    // Re-check tips whose transactions were not confirmed yet
    this.verifyTimer = setInterval(() => this.kickVerification(), 5_000)
    // Gated content without a rule, then uploads nobody attached to a post
    this.cleanupTimer = setInterval(
      () =>
        void deleteContentWithoutRule(this.db)
          .then(() => deleteOrphanedMedia(this.db))
          .then(() => pruneOldDiscoveryData(this.db))
          .catch((err: unknown) =>
            console.error('Krao indexer: gated media cleanup failed', err),
          ),
      60 * 60 * 1000,
    )
  }

  async destroy() {
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
        if (repo.active === false && HIDDEN_STATUSES.has(repo.status ?? '')) {
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

  /** Run on-chain verification of tips and NFT avatars in the background */
  kickVerification() {
    this.tipRound.kick()
    this.nftRound.kick()
  }

  /** Resolves once the current verification rounds, if any, are done */
  async verificationIdle() {
    await Promise.all([this.tipRound.idle(), this.nftRound.idle()])
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
      await verifyTip(this.db, this.rpcs, tip).catch((err: unknown) =>
        console.error('Krao indexer: tip check failed', tip.uri, err),
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
    if (evt.event === 'create' || evt.event === 'update') {
      if (evt.collection === WALLET_COLLECTION) {
        await upsertWallet(
          this.db,
          walletRowFromRecord(evt.uri.toString(), evt.did, evt.record),
        )
        await markNftAvatarStale(this.db, evt.did)
      } else if (evt.collection === TIP_COLLECTION) {
        const row = tipRowFromRecord(evt.uri.toString(), evt.did, evt.record)
        await upsertTip(this.db, row)
        // Verified by the background worker: a slow RPC must not stall indexing
        this.freshTips.add(row.uri)
        this.tipRound.kick()
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
        await deleteWallet(this.db, evt.uri.toString())
        await markNftAvatarStale(this.db, evt.did)
      } else if (evt.collection === TIP_COLLECTION) {
        await deleteTip(this.db, evt.uri.toString())
      } else if (evt.collection === NFT_AVATAR_COLLECTION) {
        await deleteNftAvatar(this.db, evt.did)
      } else if (evt.collection === GATE_RULE_COLLECTION) {
        await deleteGateRule(this.db, evt.uri.toString())
      } else if (evt.collection === POST_COLLECTION) {
        await deleteFeedPost(this.db, evt.uri.toString())
        await deletePostTags(this.db, evt.uri.toString())
        await deleteGateDataForSubject(this.db, evt.uri.toString())
      } else if (evt.collection === FOLLOW_COLLECTION) {
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
        await deleteWalletsForDid(this.db, evt.did)
        await deleteTipsForDid(this.db, evt.did)
        await deleteNftAvatar(this.db, evt.did)
        await deleteGateDataForDid(this.db, evt.did)
        await deleteFeedDataForDid(this.db, evt.did)
        await deleteDiscoveryDataForDid(this.db, evt.did)
      }
    }
  }

  /** Whether the account's posts belong in the feed (see FeedIndexingOptions) */
  private async isFeedAuthor(did: string): Promise<boolean> {
    if (!this.feed.did) return false
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
