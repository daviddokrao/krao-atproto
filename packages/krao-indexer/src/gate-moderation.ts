import type express from 'express'
import { type IdResolver, getDidKeyFromMultibase } from '@atproto/identity'
import type { AtUriString, DatetimeString, UriString } from '@atproto/syntax'
import {
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  type Server,
  verifyJwt,
} from '@atproto/xrpc-server'
import type { Database } from './db.js'
import { type StoredGatedMedia, getGatedContent } from './gate.js'
import { net } from './lexicons/index.js'

/*
 * Moderators may read gated content (a report about a gated post must be
 * reviewable: CSAM and scams hide behind gates too). Only accounts and
 * moderation services named in KRAO_GATE_MODERATOR_DIDS may; every read is
 * logged in gate_access_log, which moderators can list.
 */

export type GateModerationOptions = {
  idResolver: IdResolver
  /** Audience of the tokens (the gate service's DID) */
  gateDid: string
  /** Moderator accounts and moderation services (a live set) */
  moderators: Set<string>
  /** KRAO_GATE_MODERATION_ACCESS: whether moderators may read content */
  enabled: boolean
  /** A signed URL for gated media */
  mediaUrl: (req: express.Request, id: string) => string
}

/**
 * The key that signed a moderator's token. Ozone signs as
 * `<did>#atproto_labeler` with its labeler key (#atproto_label in its DID
 * document); accounts sign with their #atproto key.
 */
export async function moderatorKey(
  idResolver: IdResolver,
  iss: string,
  forceRefresh: boolean,
) {
  const [did, serviceId] = iss.split('#')
  if (serviceId !== 'atproto_labeler') {
    return idResolver.did.resolveAtprotoKey(did, forceRefresh)
  }
  const doc = await idResolver.did.resolve(did, forceRefresh)
  const method = doc?.verificationMethod?.find(
    (m) => typeof m !== 'string' && m.id.endsWith('#atproto_label'),
  )
  const key =
    method && typeof method !== 'string' && method.publicKeyMultibase
      ? getDidKeyFromMultibase({
          type: method.type,
          publicKeyMultibase: method.publicKeyMultibase,
        })
      : undefined
  if (!key) throw new AuthRequiredError('Moderation service key not found')
  return key
}

/** Checks a moderator's service auth token; others get a 403 */
export function moderatorAuth(
  opts: Pick<GateModerationOptions, 'idResolver' | 'gateDid' | 'moderators'>,
  lxm: string,
) {
  return async ({ req }: { req: express.Request }) => {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) {
      throw new AuthRequiredError('Service auth token required')
    }
    const payload = await verifyJwt(
      header.slice('Bearer '.length),
      opts.gateDid,
      lxm,
      (iss, forceRefresh) => moderatorKey(opts.idResolver, iss, forceRefresh),
    )
    const did = payload.iss.split('#')[0]
    if (!opts.moderators.has(did)) {
      throw new ForbiddenError('Only Krao moderators may call this')
    }
    return { credentials: { did } }
  }
}

export async function logGateAccess(
  db: Database,
  entry: { moderatorDid: string; uri: string; reason?: string },
) {
  await db
    .insertInto('gate_access_log')
    .values({
      moderatorDid: entry.moderatorDid,
      uri: entry.uri,
      reason: entry.reason ?? null,
      accessedAt: new Date().toISOString(),
    })
    .execute()
}

export function addGateModerationRoutes(
  server: Server,
  db: Database,
  opts: GateModerationOptions,
) {
  const moderation = net.krao.gate.moderation

  server.add(moderation.getContent, {
    auth: moderatorAuth(opts, moderation.getContent.$lxm),
    handler: async ({ params, auth, req }) => {
      if (!opts.enabled) {
        throw new ForbiddenError(
          'Moderator access to gated content is turned off',
        )
      }
      const moderator = (auth.credentials as { did: string }).did
      const content = await getGatedContent(db, params.uri)
      // Logged before anything is shown, and also when there is nothing
      await logGateAccess(db, {
        moderatorDid: moderator,
        uri: params.uri,
        reason: params.reason,
      })
      if (!content) {
        throw new InvalidRequestError(
          'No gated content for this post',
          'NotFound',
        )
      }
      return {
        encoding: 'application/json' as const,
        body: {
          uri: params.uri,
          text: content.text,
          facets: content.facets ? JSON.parse(content.facets) : undefined,
          media: content.media
            ? (JSON.parse(content.media) as StoredGatedMedia[]).map((m) => ({
                url: opts.mediaUrl(req, m.id) as UriString,
                mimeType: m.mimeType,
                alt: m.alt,
                aspectRatio: m.aspectRatio,
              }))
            : undefined,
        },
      }
    },
  })

  server.add(moderation.listAccessLog, {
    auth: moderatorAuth(opts, moderation.listAccessLog.$lxm),
    handler: async ({ params }) => {
      const limit = params.limit ?? 50
      let query = db
        .selectFrom('gate_access_log')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(limit)
      if (params.uri) query = query.where('uri', '=', params.uri)
      if (params.moderator) {
        query = query.where('moderatorDid', '=', params.moderator)
      }
      if (params.cursor) query = query.where('id', '<', Number(params.cursor))
      const rows = await query.execute()
      return {
        encoding: 'application/json' as const,
        body: {
          entries: rows.map((r) => ({
            id: r.id,
            moderator: r.moderatorDid as `did:${string}:${string}`,
            uri: r.uri as AtUriString,
            reason: r.reason ?? undefined,
            accessedAt: r.accessedAt as DatetimeString,
          })),
          cursor:
            rows.length === limit
              ? String(rows[rows.length - 1].id)
              : undefined,
        },
      }
    },
  })
}
