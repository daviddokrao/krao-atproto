import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'

const RETRY_MS = 60_000

/**
 * Follows a PDS firehose for account deletions only (no commits), so the
 * device tokens of a deleted account go even when no app asked for it (eg an
 * admin deleted the account). The cursor is kept: none is missed across restarts.
 * A cleanup that fails is kept in a pending list and retried until it works.
 */
export class AccountDeletions {
  private firehose: Firehose
  private timer?: NodeJS.Timeout
  private retrying = false

  constructor(
    private opts: {
      /** The PDS firehose, eg wss://pds.krao.net */
      service: string
      plcUrl: string
      getCursor: () => Promise<number | undefined>
      setCursor: (seq: number) => Promise<void>
      /** Deletions whose cleanup failed, kept across restarts */
      getPending: () => Promise<string[]>
      setPending: (dids: string[]) => Promise<void>
      onDeleted: (did: string) => Promise<void>
    },
  ) {
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
          await this.cleanUp(evt.did)
        }
        await opts.setCursor(evt.seq)
      },
      onError: (err) => {
        console.error('krao-push: firehose error', err)
      },
    })
  }

  /** Cleans up now, or keeps the DID for a later retry */
  async cleanUp(did: string) {
    try {
      await this.opts.onDeleted(did)
    } catch (err) {
      console.error(`krao-push: cleanup of ${did} failed, will retry`, err)
      const pending = new Set(await this.opts.getPending())
      pending.add(did)
      await this.opts.setPending([...pending])
    }
  }

  /** Retries the pending cleanups; those that work leave the list */
  async retryPending() {
    if (this.retrying) return
    this.retrying = true
    try {
      const pending = await this.opts.getPending()
      if (!pending.length) return
      const failed: string[] = []
      for (const did of pending) {
        try {
          await this.opts.onDeleted(did)
        } catch {
          failed.push(did)
        }
      }
      // Deletions that failed meanwhile were added to the stored list
      const now = new Set(await this.opts.getPending())
      for (const did of pending) if (!failed.includes(did)) now.delete(did)
      await this.opts.setPending([...now])
    } finally {
      this.retrying = false
    }
  }

  start() {
    void this.firehose.start()
    this.timer = setInterval(() => {
      this.retryPending().catch((err: unknown) => {
        console.error('krao-push: cleanup retry failed', err)
      })
    }, RETRY_MS)
    this.timer.unref()
  }

  async destroy() {
    clearInterval(this.timer)
    await this.firehose.destroy()
  }
}
