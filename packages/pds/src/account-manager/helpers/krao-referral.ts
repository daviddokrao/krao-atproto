import { currentDatetimeString } from '@atproto/lex'
import { InvalidRequestError } from '@atproto/xrpc-server'
import type { KraoRewardsConfig } from '../../config/config.js'
import { pdsLogger } from '../../logger.js'
import type { AccountDb } from '../db/index.js'

/*
 * Krao referral codes. With a Krao rewards service configured, the invite
 * code of a sign-up is a referral code that the service checks; the PDS's own
 * invite_code table is not used. Each sign-up is written to an outbox in the
 * account's transaction and reported to the service from there.
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

  /** Reports undelivered sign-ups to the rewards service */
  async deliver() {
    if (this.delivering) return
    this.delivering = true
    try {
      const rows = await this.db.db
        .selectFrom('krao_referral_outbox')
        .selectAll()
        .where('deliveredAt', 'is', null)
        .where(
          'createdAt',
          '<=',
          new Date(Date.now() - SETTLE_MS).toISOString(),
        )
        .orderBy('createdAt')
        .limit(BATCH)
        .execute()
      for (const row of rows) {
        try {
          const res = await fetch(
            new URL('/internal/referrals', this.cfg.url),
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.cfg.token}`,
              },
              body: JSON.stringify({
                did: row.did,
                code: row.code,
                createdAt: row.createdAt,
              }),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            },
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          await this.db.db
            .updateTable('krao_referral_outbox')
            .set({ deliveredAt: currentDatetimeString(), lastError: null })
            .where('did', '=', row.did)
            .execute()
        } catch (err) {
          await this.db.db
            .updateTable('krao_referral_outbox')
            .set({
              attempts: row.attempts + 1,
              lastError: String(err).slice(0, 500),
            })
            .where('did', '=', row.did)
            .execute()
          pdsLogger.warn(
            { err, did: row.did },
            'krao referral delivery failed, will retry',
          )
          // The service is likely down: try the rest on the next round
          break
        }
      }
    } finally {
      this.delivering = false
    }
  }
}
