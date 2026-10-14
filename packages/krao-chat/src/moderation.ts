import { sql } from 'kysely'
import { type IdResolver, getDidKeyFromMultibase } from '@atproto/identity'
import {
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  type MethodAuthContext,
  type Server,
  verifyJwt,
} from '@atproto/xrpc-server'
import type { ConvoTable, Database } from './db.js'
import { chat } from './lexicons/index.js'
import type { ChatService } from './service.js'

/*
 * chat.bsky.moderation.*: what Ozone needs to review reported messages and
 * restrict accounts. Only the moderation services named in the config
 * (their DIDs sign the service auth tokens) may call these methods.
 */

const DAY_MS = 24 * 60 * 60 * 1000

const json = (body: unknown) => ({
  encoding: 'application/json' as const,
  body: body as never,
})

/** Whether a moderator has turned chat off for `did` */
export async function isChatDisabled(db: Database, did: string) {
  const row = await db
    .selectFrom('actor_access')
    .select('allowAccess')
    .where('did', '=', did)
    .executeTakeFirst()
  return row ? !row.allowAccess : false
}

export function addModerationMethods(
  server: Server,
  service: ChatService,
  opts: {
    idResolver: IdResolver
    serviceDid: string
    /** DIDs of the moderation services (eg Krao's Ozone) */
    moderatorDids: string[]
  },
) {
  const { db } = service
  const moderators = new Set(opts.moderatorDids)

  /*
   * Ozone signs as `<did>#atproto_labeler`, with its labeler key
   * (#atproto_label in its DID doc), not its #atproto key.
   */
  const moderatorKey = async (iss: string, forceRefresh: boolean) => {
    const [did, serviceId] = iss.split('#')
    if (serviceId !== 'atproto_labeler') {
      return opts.idResolver.did.resolveAtprotoKey(did, forceRefresh)
    }
    const doc = await opts.idResolver.did.resolve(did, forceRefresh)
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

  const modAuth = async ({ req }: MethodAuthContext) => {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) {
      throw new AuthRequiredError('Service auth token required')
    }
    const nsid = (req.url ?? '').split('?')[0].replace(/^\/xrpc\//, '')
    const payload = await verifyJwt(
      header.slice('Bearer '.length),
      opts.serviceDid,
      nsid,
      (iss, forceRefresh) => moderatorKey(iss, forceRefresh),
    )
    const iss = payload.iss.split('#')[0]
    if (!moderators.has(iss)) {
      throw new ForbiddenError('Only moderation services may call this')
    }
    return { credentials: { did: iss } }
  }

  /** A convo as moderators see it: no viewer state, no member list */
  const modConvoView = async (convo: ConvoTable) => {
    if (convo.kind === 'direct') {
      return {
        id: convo.id,
        rev: convo.rev,
        kind: { $type: 'chat.bsky.moderation.defs#directConvo' },
      }
    }
    const [{ count }] = await db
      .selectFrom('member')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('convoId', '=', convo.id)
      .where('state', '=', 'active')
      .execute()
    const [{ requests }] = await db
      .selectFrom('join_request')
      .select((eb) => eb.fn.countAll<number>().as('requests'))
      .where('convoId', '=', convo.id)
      .execute()
    return {
      id: convo.id,
      rev: convo.rev,
      kind: {
        $type: 'chat.bsky.moderation.defs#groupConvo',
        createdAt: convo.createdAt,
        joinRequestCount: Math.min(Number(requests), 21),
        lockStatus: convo.lockStatus,
        memberCount: Number(count),
        memberLimit: convo.memberLimit,
        name: convo.name ?? '',
      },
    }
  }

  const getConvoRow = async (convoId: string) => {
    const convo = await db
      .selectFrom('convo')
      .selectAll()
      .where('id', '=', convoId)
      .executeTakeFirst()
    if (!convo) throw new InvalidRequestError('Convo not found', 'InvalidConvo')
    return convo
  }

  server.add(chat.bsky.moderation.getConvo, {
    auth: modAuth,
    handler: async ({ params }) =>
      json({ convo: await modConvoView(await getConvoRow(params.convoId)) }),
  })

  server.add(chat.bsky.moderation.getConvos, {
    auth: modAuth,
    handler: async ({ params }) => {
      const rows = await db
        .selectFrom('convo')
        .selectAll()
        .where('id', 'in', params.convoIds)
        .execute()
      return json({ convos: await Promise.all(rows.map(modConvoView)) })
    },
  })

  server.add(chat.bsky.moderation.getConvoMembers, {
    auth: modAuth,
    handler: async ({ params }) => {
      await getConvoRow(params.convoId)
      const offset = params.cursor ? Number(params.cursor) : 0
      if (!Number.isInteger(offset) || offset < 0) {
        throw new InvalidRequestError('Malformed cursor')
      }
      const limit = params.limit ?? 50
      const rows = await db
        .selectFrom('member')
        .select('did')
        .where('convoId', '=', params.convoId)
        .where('state', '=', 'active')
        .orderBy('did')
        .limit(limit)
        .offset(offset)
        .execute()
      const profiles = await service.appview.getProfiles(rows.map((r) => r.did))
      return json({
        members: rows.map((r) =>
          service.profileView(r.did, profiles.get(r.did)),
        ),
        cursor: rows.length === limit ? String(offset + limit) : undefined,
      })
    },
  })

  /*
   * The reported message with the user messages around it. System messages
   * in that range come along, as the lexicon describes.
   */
  server.add(chat.bsky.moderation.getMessageContext, {
    auth: modAuth,
    handler: async ({ params }) => {
      let qb = db
        .selectFrom('message')
        .selectAll()
        .where('id', '=', params.messageId)
      if (params.convoId) qb = qb.where('convoId', '=', params.convoId)
      const target = await qb.executeTakeFirst()
      if (!target) {
        throw new InvalidRequestError('Message not found', 'MessageNotFound')
      }
      const around = async (dir: 'before' | 'after', count: number) => {
        const rows = await db
          .selectFrom('message')
          .selectAll()
          .where('convoId', '=', target.convoId)
          .where('rev', dir === 'before' ? '<' : '>', target.rev)
          .orderBy('rev', dir === 'before' ? 'desc' : 'asc')
          .limit(count * 4 + 20)
          .execute()
        // Count only user messages towards the limit
        const kept = []
        let users = 0
        for (const row of rows) {
          if (!row.system) {
            if (users === count) break
            users++
          }
          kept.push(row)
        }
        return dir === 'before' ? kept.reverse() : kept
      }
      const rows = [
        ...(await around('before', params.before ?? 5)),
        target,
        ...(await around('after', params.after ?? 5)),
      ]
      // Moderators see everything: no viewer, so nothing is hidden
      const views = await service.messageViews(rows, '')
      return json({
        messages: views.filter(
          (v) => v.$type !== 'chat.bsky.convo.defs#deletedMessageView',
        ),
      })
    },
  })

  server.add(chat.bsky.moderation.getActorMetadata, {
    auth: modAuth,
    handler: async ({ params }) => {
      const now = Date.now()
      const metadata = async (since?: number) => {
        const from = since ? new Date(since).toISOString() : ''
        const convoIds = db
          .selectFrom('member')
          .select('convoId')
          .where('did', '=', params.actor)
        const [sent] = await db
          .selectFrom('message')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('senderDid', '=', params.actor)
          .where('sentAt', '>=', from)
          .execute()
        const [received] = await db
          .selectFrom('message')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('convoId', 'in', convoIds)
          .where('senderDid', '!=', params.actor)
          .where('system', 'is', null)
          .where('sentAt', '>=', from)
          .execute()
        const [convos] = await db
          .selectFrom('convo')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('id', 'in', convoIds)
          .where('createdAt', '>=', from)
          .execute()
        // Started: owned groups, and direct convos whose first message is theirs
        const [started] = await db
          .selectFrom('convo')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('id', 'in', convoIds)
          .where('createdAt', '>=', from)
          .where((eb) =>
            eb.or([
              eb('ownerDid', '=', params.actor),
              eb(
                sql<string>`(select senderDid from message m where m.convoId = convo.id and m.system is null order by m.rev asc limit 1)`,
                '=',
                params.actor,
              ),
            ]),
          )
          .execute()
        return {
          messagesSent: Number(sent.n),
          messagesReceived: Number(received.n),
          convos: Number(convos.n),
          convosStarted: Number(started.n),
        }
      }
      return json({
        day: await metadata(now - DAY_MS),
        month: await metadata(now - 30 * DAY_MS),
        all: await metadata(),
      })
    },
  })

  server.add(chat.bsky.moderation.updateActorAccess, {
    auth: modAuth,
    handler: async ({ input }) => {
      const row = {
        did: input.body.actor,
        allowAccess: input.body.allowAccess ? 1 : 0,
        ref: input.body.ref ?? null,
        updatedAt: new Date().toISOString(),
      }
      await db
        .insertInto('actor_access')
        .values(row)
        .onConflict((oc) => oc.column('did').doUpdateSet(row))
        .execute()
    },
  })
}
