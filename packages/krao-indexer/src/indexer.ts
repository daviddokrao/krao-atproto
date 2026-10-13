import type { IdResolver } from '@atproto/identity'
import { type Event, Firehose } from '@atproto/sync'
import type { EvmRpc } from './chain.js'
import type { Database } from './db.js'
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

/** Consumes a repo firehose and indexes io.krao.* records. */
export class FirehoseIndexer {
  private firehose: Firehose

  constructor(
    private db: Database,
    private rpcs: Map<string, EvmRpc>,
    idResolver: IdResolver,
    service: string,
    onError: (err: Error) => void,
    private nftRecheckMs = 10 * 60 * 1000,
  ) {
    this.firehose = new Firehose({
      idResolver,
      service,
      filterCollections: [
        WALLET_COLLECTION,
        TIP_COLLECTION,
        NFT_AVATAR_COLLECTION,
        GATE_RULE_COLLECTION,
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
      }
    } else if (evt.event === 'account') {
      if (evt.status === 'deleted') {
        await deleteWalletsForDid(this.db, evt.did)
        await deleteTipsForDid(this.db, evt.did)
        await deleteNftAvatar(this.db, evt.did)
        await deleteGateDataForDid(this.db, evt.did)
      }
    }
    await this.setCursor(evt.seq)
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
