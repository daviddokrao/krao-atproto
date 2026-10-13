import type { IdResolver } from '@atproto/identity'
import { type Event, Firehose } from '@atproto/sync'
import type { Database } from './db.js'
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
    idResolver: IdResolver,
    service: string,
    onError: (err: Error) => void,
  ) {
    this.firehose = new Firehose({
      idResolver,
      service,
      filterCollections: [WALLET_COLLECTION],
      excludeIdentity: true,
      excludeSync: true,
      getCursor: () => this.getCursor(),
      handleEvent: (evt) => this.handleEvent(evt),
      onError,
    })
  }

  start() {
    void this.firehose.start()
  }

  async destroy() {
    await this.firehose.destroy()
  }

  async handleEvent(evt: Event): Promise<void> {
    if (evt.event === 'create' || evt.event === 'update') {
      if (evt.collection === WALLET_COLLECTION) {
        await upsertWallet(
          this.db,
          walletRowFromRecord(evt.uri.toString(), evt.did, evt.record),
        )
      }
    } else if (evt.event === 'delete') {
      if (evt.collection === WALLET_COLLECTION) {
        await deleteWallet(this.db, evt.uri.toString())
      }
    } else if (evt.event === 'account') {
      if (evt.status === 'deleted') {
        await deleteWalletsForDid(this.db, evt.did)
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
