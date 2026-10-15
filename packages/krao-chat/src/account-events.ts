import type { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'

/**
 * Follows a PDS firehose for account deletions only (no commits), so the
 * data of a deleted account goes even when no app asked for it (eg an admin
 * deleted the account). The cursor is kept: none is missed across restarts.
 */
export class AccountDeletions {
  private firehose: Firehose

  constructor(opts: {
    /** The PDS firehose, eg wss://pds.krao.net */
    service: string
    idResolver: IdResolver
    getCursor: () => Promise<number | undefined>
    setCursor: (seq: number) => Promise<void>
    onDeleted: (did: string) => Promise<void>
  }) {
    this.firehose = new Firehose({
      idResolver: opts.idResolver,
      service: opts.service,
      excludeCommit: true,
      excludeIdentity: true,
      excludeSync: true,
      getCursor: opts.getCursor,
      handleEvent: async (evt) => {
        if (evt.event === 'account' && evt.status === 'deleted') {
          await opts.onDeleted(evt.did)
        }
        await opts.setCursor(evt.seq)
      },
      onError: (err) => {
        console.error('Krao chat: firehose error', err)
      },
    })
  }

  start() {
    void this.firehose.start()
  }

  async destroy() {
    await this.firehose.destroy()
  }
}
