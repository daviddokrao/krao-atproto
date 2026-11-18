/**
 * Reads from Krao's AppView: profiles (for member views and chat settings),
 * relationships (follows and blocks, for who may message whom) and posts (for
 * record embeds). Only public, unauthenticated queries are used.
 */

export type AppviewProfile = {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  associated?: {
    chat?: { allowIncoming?: string; allowGroupInvites?: string }
    [key: string]: unknown
  }
  labels?: unknown[]
  createdAt?: string
  verification?: unknown
}

export type Relationship = {
  /** Whether the actor follows the other account */
  following: boolean
  /** Whether the other account follows the actor */
  followedBy: boolean
  /** Whether the actor blocks the other account */
  blocking: boolean
  /** Whether the other account blocks the actor */
  blockedBy: boolean
}

const PROFILE_TTL_MS = 30_000
const PROFILE_CACHE_MAX = 10_000
const FETCH_TIMEOUT_MS = 5_000

export class Appview {
  private profiles = new Map<
    string,
    { at: number; profile: AppviewProfile | null }
  >()

  constructor(private url: string) {}

  private async get<T>(
    nsid: string,
    params: Record<string, string | string[]>,
  ) {
    const url = new URL(`/xrpc/${nsid}`, this.url)
    for (const [k, v] of Object.entries(params)) {
      for (const x of [v].flat()) url.searchParams.append(k, x)
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${nsid} failed: ${res.status}`)
    return (await res.json()) as T
  }

  /** Profiles by DID; accounts the AppView does not know map to null */
  async getProfiles(
    dids: string[],
  ): Promise<Map<string, AppviewProfile | null>> {
    const now = Date.now()
    const out = new Map<string, AppviewProfile | null>()
    const missing: string[] = []
    for (const did of new Set(dids)) {
      const cached = this.profiles.get(did)
      if (cached && now - cached.at < PROFILE_TTL_MS)
        out.set(did, cached.profile)
      else missing.push(did)
    }
    for (let i = 0; i < missing.length; i += 25) {
      const batch = missing.slice(i, i + 25)
      const { profiles } = await this.get<{ profiles: AppviewProfile[] }>(
        'app.bsky.actor.getProfiles',
        { actors: batch },
      )
      const found = new Map(profiles.map((p) => [p.did, p]))
      if (this.profiles.size > PROFILE_CACHE_MAX) this.profiles.clear()
      for (const did of batch) {
        const profile = found.get(did) ?? null
        this.profiles.set(did, { at: now, profile })
        out.set(did, profile)
      }
    }
    return out
  }

  async getProfile(did: string): Promise<AppviewProfile | null> {
    return (await this.getProfiles([did])).get(did) ?? null
  }

  /** How `actor` relates to each of `others` */
  async getRelationships(
    actor: string,
    others: string[],
  ): Promise<Map<string, Relationship>> {
    const out = new Map<string, Relationship>()
    if (!others.length) return out
    const { relationships } = await this.get<{
      relationships: Array<{
        did: string
        following?: string
        followedBy?: string
        blocking?: string
        blockedBy?: string
        blockingByList?: string
        blockedByList?: string
        notFound?: boolean
      }>
    }>('app.bsky.graph.getRelationships', { actor, others })
    for (const r of relationships) {
      if (r.notFound) continue
      out.set(r.did, {
        following: !!r.following,
        followedBy: !!r.followedBy,
        blocking: !!(r.blocking || r.blockingByList),
        blockedBy: !!(r.blockedBy || r.blockedByList),
      })
    }
    return out
  }

  /** Post views by URI, for record embeds */
  async getPosts(
    uris: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < uris.length; i += 25) {
      const { posts } = await this.get<{
        posts: Array<Record<string, unknown>>
      }>('app.bsky.feed.getPosts', { uris: uris.slice(i, i + 25) })
      for (const post of posts) out.set(post.uri as string, post)
    }
    return out
  }
}
