import { InvalidRequestError, UpstreamFailureError } from '@atproto/xrpc-server'
import type { KraoRewardsConfig } from '../../config/config.js'
import { pdsLogger } from '../../logger.js'

/*
 * Krao: Decree 147 asks that accounts verify a phone number before they
 * post. With PDS_KRAO_PHONE_REQUIRED, writes of posts by accounts the Krao
 * rewards service does not list as verified are refused. Answers are cached
 * (yes for longer than no); if the service cannot be reached, posting fails.
 */

const POST_COLLECTION = 'app.bsky.feed.post'
const VERIFIED_TTL_MS = 10 * 60_000
const UNVERIFIED_TTL_MS = 15_000
const CACHE_MAX = 50_000
const TIMEOUT_MS = 5_000

export class KraoPhoneGate {
  private cache = new Map<string, { verified: boolean; until: number }>()

  /** `cfg.phoneRequired` is read on every write, so it may change at runtime */
  constructor(private cfg: KraoRewardsConfig) {}

  /** Throws PhoneVerificationRequired for a post by an unverified account */
  async assertCanWrite(did: string, collections: Iterable<string>) {
    if (!this.cfg.phoneRequired) return
    if (![...collections].includes(POST_COLLECTION)) return
    if (await this.isVerified(did)) return
    throw new InvalidRequestError(
      'Verify your phone number before posting',
      'PhoneVerificationRequired',
    )
  }

  async isVerified(did: string): Promise<boolean> {
    const now = Date.now()
    const cached = this.cache.get(did)
    if (cached && cached.until > now) return cached.verified
    let verified: boolean
    try {
      const url = new URL('/internal/phone-status', this.cfg.url)
      url.searchParams.set('did', did)
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      verified =
        ((await res.json()) as { verified?: unknown }).verified === true
    } catch (err) {
      pdsLogger.error({ err }, 'krao phone status check failed')
      throw new UpstreamFailureError(
        'Posting is temporarily unavailable, please try again later',
      )
    }
    if (this.cache.size > CACHE_MAX) this.cache.clear()
    this.cache.set(did, {
      verified,
      until: now + (verified ? VERIFIED_TTL_MS : UNVERIFIED_TTL_MS),
    })
    return verified
  }
}
