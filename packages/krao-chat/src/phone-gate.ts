import { InvalidRequestError, UpstreamFailureError } from '@atproto/xrpc-server'

/*
 * Decree 147: with KRAO_CHAT_PHONE_REQUIRED, starting convos and sending
 * messages needs a phone number verified with Krao's rewards service (the
 * same check the PDS makes for posts). Answers are cached, yes for longer
 * than no; if the service cannot be reached, sending fails.
 */

const VERIFIED_TTL_MS = 10 * 60_000
const UNVERIFIED_TTL_MS = 15_000
const CACHE_MAX = 50_000

export type PhoneGateConfig = {
  /** Krao's rewards service and its internal token */
  rewardsUrl: string
  token: string
  /** Read on every call, so it may change at runtime */
  required: boolean
}

export class PhoneGate {
  private cache = new Map<string, { verified: boolean; until: number }>()

  constructor(
    public cfg: PhoneGateConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Throws PhoneVerificationRequired for an unverified account */
  async assertVerified(did: string) {
    if (!this.cfg.required) return
    if (await this.isVerified(did)) return
    throw new InvalidRequestError(
      'Verify your phone number before sending messages',
      'PhoneVerificationRequired',
    )
  }

  async isVerified(did: string): Promise<boolean> {
    const now = Date.now()
    const cached = this.cache.get(did)
    if (cached && cached.until > now) return cached.verified
    let verified: boolean
    try {
      const url = new URL('/internal/phone-status', this.cfg.rewardsUrl)
      url.searchParams.set('did', did)
      const res = await this.fetchFn(url, {
        headers: { authorization: `Bearer ${this.cfg.token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      verified =
        ((await res.json()) as { verified?: unknown }).verified === true
    } catch (err) {
      console.error('Krao chat: phone status check failed', err)
      throw new UpstreamFailureError(
        'Messages cannot be sent right now, please try again later',
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
