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
  feedInteractionRowFromRecord,
  feedPostRowFromRecord,
  upsertFeedGenerator,
  upsertFeedInteraction,
  upsertFeedPost,
} from './feed.js'
import {
  FOLLOW_COLLECTION,
  deleteDiscoveryDataForDid,
  deleteFeedFollow,
  deletePostTags,
  feedFollowRowFromRecord,
  postTags,
  setPostTags,
  upsertFeedFollow,
} from './discovery.js'
import {
  GATE_RULE_COLLECTION,
  deleteGateDataForDid,
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
    service: string,
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
        ...(feed.did
          ? [
              POST_COLLECTION,
              FEED_GENERATOR_COLLECTION,
              LIKE_COLLECTION,
              REPOST_COLLECTION,
              FOLLOW_COLLECTION,
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

  start() {
    void this.firehose.start()
    // Re-check tips whose transactions were not confirmed yet
    this.verifyTimer = setInterval(() => {
      void this.verifyPendingTips()
      void this.recheckNftAvatars()
    }, 5_000)
  }

  async destroy() {
    clearInterval(this.verifyTimer)
    await this.firehose.destroy()
  }

  /**
   * NFTs can be sold or moved at any time, so avatars are re-checked: pending
   * ones on every tick, verified ones every `nftRecheckMs`.
   */
  async recheckNftAvatars() {
    const due = new Date(Date.now() - this.nftRecheckMs).toISOString()
    for (const row of await getNftAvatarsToRecheck(this.db, due)) {
      await verifyNftAvatar(this.db, this.rpcs, row)
    }
  }

  async verifyPendingTips() {
    for (const tip of await getPendingTips(this.db)) {
      await verifyTip(this.db, this.rpcs, tip)
    }
  }

  async handleEvent(evt: Event): Promise<void> {
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
        await verifyTip(this.db, this.rpcs, row)
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
        await verifyNftAvatar(this.db, this.rpcs, row)
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
      } else if (evt.collection === FOLLOW_COLLECTION) {
        await deleteFeedFollow(this.db, evt.uri.toString())
      } else if (
        evt.collection === LIKE_COLLECTION ||
        evt.collection === REPOST_COLLECTION
      ) {
        await deleteFeedInteraction(this.db, evt.uri.toString())
      } else if (evt.collection === FEED_GENERATOR_COLLECTION) {
        await deleteFeedGenerator(this.db, evt.uri.toString())
      }
    } else if (evt.event === 'account') {
      if (evt.status === 'deleted') {
        await deleteWalletsForDid(this.db, evt.did)
        await deleteTipsForDid(this.db, evt.did)
        await deleteNftAvatar(this.db, evt.did)
        await deleteGateDataForDid(this.db, evt.did)
        await deleteFeedDataForDid(this.db, evt.did)
        await deleteDiscoveryDataForDid(this.db, evt.did)
      }
    }
    await this.setCursor(evt.seq)
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
    await this.db
      .insertInto('cursor')
      .values({ id: CURSOR_ID, seq })
      .onConflict((oc) => oc.column('id').doUpdateSet({ seq }))
      .execute()
  }
}
