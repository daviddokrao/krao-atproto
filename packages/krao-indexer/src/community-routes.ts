import type express from 'express'
import type { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  type Server,
  verifyJwt,
} from '@atproto/xrpc-server'
import {
  type CommunityAccess,
  type CommunityChecks,
  type CommunityRow,
  type ViewerState,
  getCommunities,
  getCommunity,
  getCommunityFeed,
  getMembers,
  getModerators,
  getPendingMembers,
  getViewerState,
  listAccountCommunities,
  listCommunities,
} from './community.js'
import type { Database } from './db.js'
import { net } from './lexicons/index.js'
import { getPoll, getPollsForPosts, pollViews } from './poll.js'
import { keyedLimit } from './rate-limit.js'

/*
 * net.krao.community.* and net.krao.poll.* queries. Lists and results are
 * public; the caller's own state (membership, eligibility, vote) only comes
 * with service auth, so nobody can learn from these methods whether another
 * account verified a phone or holds a token.
 */

type CommunityView = net.krao.community.defs.CommunityView
type PollView = net.krao.poll.defs.PollView

export type CommunityRouteOptions = {
  idResolver: IdResolver
  /** Audience of service auth tokens (the gate service's DID) */
  gateDid: string
  checks: CommunityChecks
}

export function addCommunityRoutes(
  server: Server,
  db: Database,
  opts: CommunityRouteOptions,
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
  // Live checks of 'condition' and 'verified' communities cost chain calls
  const liveLimit = keyedLimit(120, 60_000)

  const viewerView = (state: ViewerState) => ({
    state: state.state,
    ...(state.role ? { role: state.role } : {}),
    ...(state.eligible !== undefined ? { eligible: state.eligible } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.membership ? { membership: state.membership } : {}),
  })

  const communityView = async (
    row: CommunityRow,
    viewer?: ViewerState,
  ): Promise<CommunityView> => {
    const access = JSON.parse(row.access) as CommunityAccess
    const moderators = await getModerators(db, row)
    return {
      uri: row.uri,
      cid: row.cid,
      owner: row.did,
      slug: row.slug,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.avatar ? { avatar: row.avatar } : {}),
      rules: JSON.parse(row.rules) as string[],
      access: {
        mode: access.mode,
        ...(access.conditions ? { conditions: access.conditions } : {}),
        ...(access.match ? { match: access.match } : {}),
      },
      ...(row.chatJoinLink ? { chatJoinLink: row.chatJoinLink } : {}),
      memberCount: row.memberCount,
      ...(moderators.length ? { moderators } : {}),
      createdAt: row.createdAt,
      indexedAt: row.indexedAt,
      ...(viewer ? { viewer: viewerView(viewer) } : {}),
    } as unknown as CommunityView
  }

  const found = async (uri: string) => {
    const row = await getCommunity(db, uri)
    if (!row) throw new InvalidRequestError('Community not found', 'NotFound')
    return row
  }
  const malformedCursor = () => {
    throw new InvalidRequestError('Malformed cursor')
  }
  const json = <T>(body: T) => ({
    encoding: 'application/json' as const,
    body,
  })

  const community = net.krao.community
  server.add(community.getCommunity, {
    auth: optionalAuth(community.getCommunity.$lxm),
    handler: async ({ params, auth }) => {
      const row = await found(params.uri)
      const caller = callerOf(auth)
      let viewer: ViewerState | undefined
      if (caller) {
        liveLimit(caller)
        viewer = await getViewerState(db, opts.checks, row, caller, true)
      }
      return json({ community: await communityView(row, viewer) })
    },
  })

  server.add(community.listCommunities, async ({ params }) => {
    const page = await listCommunities(db, {
      query: params.query,
      sort: params.sort,
      limit: params.limit ?? 25,
      cursor: params.cursor,
    }).catch(malformedCursor)
    return json({
      communities: await Promise.all(
        page.communities.map((row) => communityView(row)),
      ),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    })
  })

  server.add(community.listMyCommunities, {
    auth: requiredAuth(community.listMyCommunities.$lxm),
    handler: async ({ params, auth }) => {
      const caller = callerOf(auth) as string
      const page = await listAccountCommunities(
        db,
        caller,
        params.limit ?? 50,
        params.cursor,
      ).catch(malformedCursor)
      const rows = await getCommunities(db, page.uris)
      const communities: CommunityView[] = []
      for (const row of rows) {
        // As last checked: listing many communities makes no chain calls
        const viewer = await getViewerState(db, opts.checks, row, caller, false)
        communities.push(await communityView(row, viewer))
      }
      return json({
        communities,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      })
    },
  })

  const memberView = (m: {
    did: string
    role: string
    membership?: string
    joinedAt?: string
  }) => ({
    did: m.did,
    role: m.role,
    ...(m.membership ? { membership: m.membership } : {}),
    ...(m.joinedAt ? { joinedAt: m.joinedAt } : {}),
  })

  server.add(community.getMembers, async ({ params }) => {
    const row = await found(params.community)
    const page = await getMembers(
      db,
      row,
      params.limit ?? 50,
      params.cursor,
    ).catch(malformedCursor)
    return json({
      members: page.members.map(memberView),
      ...(page.cursor ? { cursor: page.cursor } : {}),
    } as never)
  })

  server.add(community.getPendingMembers, {
    auth: requiredAuth(community.getPendingMembers.$lxm),
    handler: async ({ params, auth }) => {
      const row = await found(params.community)
      const caller = callerOf(auth) as string
      const state = await getViewerState(db, opts.checks, row, caller, false)
      if (
        state.state !== 'member' ||
        (state.role !== 'owner' && state.role !== 'moderator')
      ) {
        throw new ForbiddenError(
          'Only the owner and moderators see pending members',
          'NotModerator',
        )
      }
      const page = await getPendingMembers(
        db,
        row,
        params.limit ?? 50,
        params.cursor,
      ).catch(malformedCursor)
      return json({
        members: page.members.map(memberView),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      } as never)
    },
  })

  server.add(community.getFeed, async ({ params }) => {
    const row = await found(params.community)
    const page = await getCommunityFeed(
      db,
      row.uri,
      params.limit ?? 30,
      params.cursor,
    ).catch(malformedCursor)
    return json({
      feed: page.feed,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    } as never)
  })

  const poll = net.krao.poll
  server.add(poll.getResults, {
    auth: optionalAuth(poll.getResults.$lxm),
    handler: async ({ params, auth }) => {
      const row = await getPoll(db, params.uri)
      if (!row) throw new InvalidRequestError('Poll not found', 'NotFound')
      const [view] = await pollViews(db, [row], callerOf(auth))
      return json({ poll: view as unknown as PollView })
    },
  })

  server.add(poll.getPolls, {
    auth: optionalAuth(poll.getPolls.$lxm),
    handler: async ({ params, auth }) => {
      const rows = await getPollsForPosts(db, params.posts)
      return json({
        polls: (await pollViews(
          db,
          rows,
          callerOf(auth),
        )) as unknown as PollView[],
      })
    },
  })
}
