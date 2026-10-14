import { currentDatetimeString } from '@atproto/lex'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { KraoRewardsConfig } from '../../config/config.js'
import { pdsLogger } from '../../logger.js'
import type { AccountDb } from '../db/index.js'

/*
 * Krao referral codes. With a Krao rewards service configured, the invite
 * code of a sign-up is a referral code that the service checks; the PDS's own
 * invite_code table is not used. Each sign-up is written to an outbox in the
 * account's transaction and reported to the service from there. Takedowns
 * are reported the same way, so the service can take back their points.
 */

const RETRY_MS = 30_000
const BATCH = 50
const TIMEOUT_MS = 5_000
/*
 * Rows wait this long before delivery: account creation may still fail after
 * the row is written (sequencing), and deleting the account drops the row
 */
const SETTLE_MS = 10_000
const DELIVER_SOON_MS = SETTLE_MS + 2_000
/** Delivered rows are kept this long, then pruned */
const KEEP_DELIVERED_MS = 30 * 24 * 60 * 60 * 1000

/*
 * The service answered, and asking again will not change its answer. Only a
 * 400 means that: a 404 more likely comes from a wrong URL or an older build.
 */
class RejectedError extends Error {}
const REJECTED_STATUSES = new Set([400])

export class KraoReferral {
  private timer?: NodeJS.Timeout
  private delivering = false

  constructor(
    private db: AccountDb,
    private cfg: KraoRewardsConfig,
  ) {}

  /**
   * Throws InvalidInviteCode for an unknown, disabled or used up code. If the
   * service cannot be reached, sign-up fails: the code is required.
   */
  async ensureCodeIsValid(code: string) {
    const url = new URL('/internal/check-code', this.cfg.url)
    url.searchParams.set('code', code)
    let valid: unknown
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      valid = ((await res.json()) as { valid?: unknown }).valid
    } catch (err) {
      pdsLogger.error({ err }, 'krao referral check failed')
      throw new InvalidRequestError(
        'Sign-up is temporarily unavailable, please try again later',
      )
    }
    if (valid !== true) {
      throw new InvalidRequestError(
        'This referral code is invalid',
        'InvalidInviteCode',
      )
    }
  }

  /** Must run in the transaction that creates the account */
  async recordSignup(dbTxn: AccountDb, did: string, code: string) {
    dbTxn.assertTransaction()
    await dbTxn.db
      .insertInto('krao_referral_outbox')
      .values({
        did,
        code,
        createdAt: currentDatetimeString(),
        attempts: 0,
        lastError: null,
        deliveredAt: null,
        failedAt: null,
      })
      .execute()
  }

  start() {
    this.timer = setInterval(() => this.deliverInBackground(), RETRY_MS)
    this.timer.unref()
  }

  stop() {
    clearInterval(this.timer)
  }

  deliverSoon() {
    setTimeout(() => this.deliverInBackground(), DELIVER_SOON_MS).unref()
  }

  private deliverInBackground() {
    this.deliver().catch((err) => {
      pdsLogger.error({ err }, 'krao referral delivery failed')
    })
  }

  /** Must run in the transaction that takes the account down or lifts it */
  async recordTakedown(dbTxn: AccountDb, did: string, applied: boolean) {
    dbTxn.assertTransaction()
    await dbTxn.db
      .insertInto('krao_takedown_outbox')
      .values({
        did,
        applied: applied ? 1 : 0,
        createdAt: currentDatetimeString(),
        attempts: 0,
        lastError: null,
        deliveredAt: null,
        failedAt: null,
      })
      .execute()
  }

  /**
   * The account was deleted. Not in a transaction (account deletion runs
   * step by step); written after the account rows are gone.
   */
  async recordDeletion(did: string) {
    await this.db.db
      .insertInto('krao_takedown_outbox')
      .values({
        did,
        applied: 1,
        kind: 'deleted',
        createdAt: currentDatetimeString(),
        attempts: 0,
        lastError: null,
        deliveredAt: null,
        failedAt: null,
      })
      .execute()
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(new URL(path, this.cfg.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (REJECTED_STATUSES.has(res.status)) {
      throw new RejectedError(`HTTP ${res.status}: ${await res.text()}`)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  /** Reports undelivered sign-ups, then takedowns, to the rewards service */
  async deliver() {
    if (this.delivering) return
    this.delivering = true
    try {
      if (await this.deliverSignups()) await this.deliverTakedowns()
      await this.pruneDelivered()
    } finally {
      this.delivering = false
    }
  }

  /** Whether every due sign-up was delivered */
  private async deliverSignups() {
    const rows = await this.db.db
      .selectFrom('krao_referral_outbox')
      .selectAll()
      .where('deliveredAt', 'is', null)
      .where('failedAt', 'is', null)
      .where('createdAt', '<=', new Date(Date.now() - SETTLE_MS).toISOString())
      .orderBy('createdAt')
      .limit(BATCH)
      .execute()
    for (const row of rows) {
      try {
        await this.post('/internal/referrals', {
          did: row.did,
          code: row.code,
          createdAt: row.createdAt,
        })
        await this.db.db
          .updateTable('krao_referral_outbox')
          .set({ deliveredAt: currentDatetimeString(), lastError: null })
          .where('did', '=', row.did)
          .execute()
      } catch (err) {
        const rejected = err instanceof RejectedError
        await this.db.db
          .updateTable('krao_referral_outbox')
          .set({
            attempts: row.attempts + 1,
            lastError: String(err).slice(0, 500),
            failedAt: rejected ? currentDatetimeString() : null,
          })
          .where('did', '=', row.did)
          .execute()
        if (rejected) {
          pdsLogger.error(
            { err, did: row.did },
            'krao referral rejected by the rewards service, skipping it',
          )
          continue
        }
        pdsLogger.warn(
          { err, did: row.did },
          'krao referral delivery failed, will retry',
        )
        // The service is likely down: try the rest on the next round
        return false
      }
    }
    return true
  }

  private async deliverTakedowns() {
    const rows = await this.db.db
      .selectFrom('krao_takedown_outbox')
      .selectAll()
      .where('deliveredAt', 'is', null)
      .where('failedAt', 'is', null)
      // After the account's sign-up, so its points exist to take back
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('krao_referral_outbox')
              .select('did')
              .whereRef(
                'krao_referral_outbox.did',
                '=',
                'krao_takedown_outbox.did',
              )
              .where('krao_referral_outbox.deliveredAt', 'is', null)
              .where('krao_referral_outbox.failedAt', 'is', null),
          ),
        ),
      )
      .orderBy('id')
      .limit(BATCH)
      .execute()
    for (const row of rows) {
      try {
        if (row.kind === 'deleted') {
          await this.post('/internal/deletions', { did: row.did })
        } else {
          await this.post('/internal/takedowns', {
            did: row.did,
            applied: row.applied === 1,
          })
        }
        await this.db.db
          .updateTable('krao_takedown_outbox')
          .set({ deliveredAt: currentDatetimeString(), lastError: null })
          .where('id', '=', row.id)
          .execute()
      } catch (err) {
        const rejected = err instanceof RejectedError
        await this.db.db
          .updateTable('krao_takedown_outbox')
          .set({
            attempts: row.attempts + 1,
            lastError: String(err).slice(0, 500),
            failedAt: rejected ? currentDatetimeString() : null,
          })
          .where('id', '=', row.id)
          .execute()
        if (rejected) {
          pdsLogger.error(
            { err, did: row.did },
            'krao takedown rejected by the rewards service, skipping it',
          )
          continue
        }
        pdsLogger.warn(
          { err, did: row.did },
          'krao takedown delivery failed, will retry',
        )
        return
      }
    }
  }

  private async pruneDelivered() {
    const before = new Date(Date.now() - KEEP_DELIVERED_MS).toISOString()
    await this.db.db
      .deleteFrom('krao_referral_outbox')
      .where('deliveredAt', '<', before)
      .execute()
    await this.db.db
      .deleteFrom('krao_takedown_outbox')
      .where('deliveredAt', '<', before)
      .execute()
  }
}
