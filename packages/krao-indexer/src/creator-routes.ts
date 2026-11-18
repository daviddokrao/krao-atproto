import type express from 'express'
import type { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  InvalidRequestError,
  type Server,
  verifyJwt,
} from '@atproto/xrpc-server'
import { SUPPORTER_WINDOW_MS, creatorStats, topSupporters } from './creator.js'
import type { Database } from './db.js'
import { net } from './lexicons/index.js'
import {
  type ChainClock,
  type MembershipState,
  getMembership,
  getPlans,
  listCreatorMembers,
  listMemberCreators,
  planMemberCounts,
} from './membership.js'

/*
 * net.krao.membership.* and net.krao.creator.* queries. Plans and top
 * supporters are public; a membership is only shown to the member, and the
 * member list and dashboard only to the creator (service auth).
 */

export type CreatorRouteOptions = {
  idResolver: IdResolver
  /** Audience of service auth tokens (the gate service's DID) */
  gateDid: string
  /** The time memberships are judged by */
  clock: ChainClock
  /** A handle or DID as a DID; throws when it does not resolve */
  resolveDid: (actor: string) => Promise<string>
  /** Krao's AppView, for follower counts */
  appviewUrl?: string
  /** Whether this indexer indexes follows (follower changes) */
  follows: boolean
}

export function addCreatorRoutes(
  server: Server,
  db: Database,
  opts: CreatorRouteOptions,
) {
  const verify = async (req: express.Request, lxm: string) => {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) return undefined
    const payload = await verifyJwt(
      header.slice('Bearer '.length),
      opts.gateDid,
      lxm,
      (iss, forceRefresh) =>
        opts.idResolver.did.resolveAtprotoKey(iss.split('#')[0], forceRefresh),
    )
    return payload.iss.split('#')[0]
  }
  /** Service auth when a token is sent; anonymous otherwise */
  const optionalAuth =
    (lxm: string) =>
    async ({ req }: { req: express.Request }) => ({
      credentials: { did: await verify(req, lxm) },
    })
  const requiredAuth =
    (lxm: string) =>
    async ({ req }: { req: express.Request }) => {
      const did = await verify(req, lxm)
      if (!did) throw new AuthRequiredError('Service auth token required')
      return { credentials: { did } }
    }
  const callerOf = (auth: { credentials: unknown }) =>
    (auth.credentials as { did?: string }).did
  const json = <T>(body: T) => ({
    encoding: 'application/json' as const,
    body,
  })
  const malformedCursor = () => {
    throw new InvalidRequestError('Malformed cursor')
  }
  const membershipView = (m: MembershipState) => ({
    creator: m.creator,
    member: m.member,
    plan: m.plan,
    status: m.status,
    since: m.since,
    ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
    ...(m.reason ? { reason: m.reason } : {}),
  })
  const views = async (pairs: { creator: string; member: string }[]) => {
    const now = await opts.clock.now()
    const states = await Promise.all(
      pairs.map((p) => getMembership(db, p.creator, p.member, now)),
    )
    return states.filter((s): s is MembershipState => !!s).map(membershipView)
  }

  const membership = net.krao.membership
  server.add(membership.getPlans, {
    auth: optionalAuth(membership.getPlans.$lxm),
    handler: async ({ params, auth }) => {
      const creator = await opts.resolveDid(params.creator)
      const rows = await getPlans(db, creator, callerOf(auth) === creator)
      const counts = await planMemberCounts(
        db,
        rows.map((r) => r.uri),
        await opts.clock.now(),
      )
      return json({
        plans: rows.map((row) => {
          const perks = JSON.parse(row.perks) as string[]
          return {
            uri: row.uri,
            cid: row.cid,
            creator: row.did,
            name: row.name,
            ...(row.description ? { description: row.description } : {}),
            priceUsdc: row.priceUsdc,
            ...(perks.length ? { perks } : {}),
            active: row.active === 1,
            memberCount: counts.get(row.uri) ?? 0,
          }
        }),
      } as never)
    },
  })

  server.add(membership.getStatus, {
    auth: requiredAuth(membership.getStatus.$lxm),
    handler: async ({ params, auth }) => {
      const caller = callerOf(auth) as string
      const creator = await opts.resolveDid(params.creator)
      const [view] = await views([{ creator, member: caller }])
      return json((view ? { membership: view } : {}) as never)
    },
  })

  server.add(membership.listMyMemberships, {
    auth: requiredAuth(membership.listMyMemberships.$lxm),
    handler: async ({ params, auth }) => {
      const caller = callerOf(auth) as string
      const page = await listMemberCreators(
        db,
        caller,
        params.limit ?? 50,
        params.cursor,
      ).catch(malformedCursor)
      return json({
        memberships: await views(
          page.items.map((creator) => ({ creator, member: caller })),
        ),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      } as never)
    },
  })

  // The caller's own members: no creator parameter, so nobody else's list
  server.add(membership.listMembers, {
    auth: requiredAuth(membership.listMembers.$lxm),
    handler: async ({ params, auth }) => {
      const caller = callerOf(auth) as string
      const status: 'active' | 'expired' | undefined =
        params.status === 'active'
          ? 'active'
          : params.status === 'expired'
            ? 'expired'
            : undefined
      const page = await listCreatorMembers(db, caller, {
        status,
        now: await opts.clock.now(),
        limit: params.limit ?? 50,
        cursor: params.cursor,
      }).catch(malformedCursor)
      return json({
        members: await views(
          page.items.map((member) => ({ creator: caller, member })),
        ),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      } as never)
    },
  })

  const creator = net.krao.creator
  server.add(creator.getTopSupporters, async ({ params }) => {
    const actor = await opts.resolveDid(params.actor)
    const now = Date.now()
    const chainNow = await opts.clock.now()
    return json({
      supporters: await topSupporters(db, actor, {
        since: now - SUPPORTER_WINDOW_MS,
        chainSince: chainNow - SUPPORTER_WINDOW_MS,
        limit: params.limit ?? 10,
      }),
    } as never)
  })

  server.add(creator.getStats, {
    auth: requiredAuth(creator.getStats.$lxm),
    handler: async ({ auth }) => {
      const caller = callerOf(auth) as string
      const [chainNow, followersNow] = await Promise.all([
        opts.clock.now(),
        followersCount(opts.appviewUrl, caller),
      ])
      return json(
        (await creatorStats(db, caller, {
          now: Date.now(),
          chainNow,
          followersNow,
          follows: opts.follows,
        })) as never,
      )
    },
  })
}

/** The account's follower count from the AppView; undefined if it does not answer */
async function followersCount(
  appviewUrl: string | undefined,
  did: string,
): Promise<number | undefined> {
  if (!appviewUrl) return undefined
  try {
    const url = new URL('/xrpc/app.bsky.actor.getProfile', appviewUrl)
    url.searchParams.set('actor', did)
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { followersCount?: unknown }
    return typeof body.followersCount === 'number'
      ? body.followersCount
      : undefined
  } catch {
    return undefined
  }
}
