import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'

/**
 * Follows a PDS firehose for account deletions only (no commits), so the
 * device tokens of a deleted account go even when no app asked for it. The
 * cursor is kept: none is missed across restarts.
 */
export class AccountDeletions {
  private firehose: Firehose

  constructor(opts: {
    /** The PDS firehose, eg wss://pds.krao.net */
    service: string
    plcUrl: string
    getCursor: () => Promise<number | undefined>
    setCursor: (seq: number) => Promise<void>
    onDeleted: (did: string) => Promise<void>
  }) {
    this.firehose = new Firehose({
      // Account events need no keys; commits, which would, are left out
      idResolver: new IdResolver({ plcUrl: opts.plcUrl }),
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
        console.error('krao-push: firehose error', err)
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
