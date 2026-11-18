/*
 * "Verified" communities and polls take accounts that verified a phone
 * number or passed KYC with Krao's rewards service (the same test as its
 * "human" badge, without the opt-in). Answers are cached, yes for longer
 * than no, like the PDS and chat phone checks.
 */

const VERIFIED_TTL_MS = 10 * 60_000
const UNVERIFIED_TTL_MS = 15_000
const CACHE_MAX = 50_000

export interface HumanCheck {
  /** Throws when the answer cannot be had (the service is down) */
  isHuman(did: string): Promise<boolean>
}

export class RewardsHumanCheck implements HumanCheck {
  private cache = new Map<string, { human: boolean; until: number }>()

  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async isHuman(did: string): Promise<boolean> {
    const now = Date.now()
    const cached = this.cache.get(did)
    if (cached && cached.until > now) return cached.human
    const url = new URL('/internal/human-status', this.url)
    url.searchParams.set('did', did)
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`human-status: HTTP ${res.status}`)
    const human = ((await res.json()) as { human?: unknown }).human === true
    if (this.cache.size > CACHE_MAX) this.cache.clear()
    this.cache.set(did, {
      human,
      until: now + (human ? VERIFIED_TTL_MS : UNVERIFIED_TTL_MS),
    })
    return human
  }
}
