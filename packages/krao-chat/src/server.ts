import cors from 'cors'
import express, { type Express } from 'express'
import type { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  InvalidRequestError,
  type MethodAuthContext,
  createServer,
  verifyJwt,
} from '@atproto/xrpc-server'
import { addGroupRoutes } from './group.js'
import { chat } from './lexicons/index.js'
import { addModerationMethods } from './moderation.js'
import {
  ChatService,
  GROUP_MEMBER_LIMIT,
  type MessageInput,
} from './service.js'

/**
 * Handler bodies are built as plain JSON in the lexicons' shapes (see
 * service.ts); the server validates them against the lexicons.
 */
export const json = (body: unknown) => ({
  encoding: 'application/json' as const,
  body: body as never,
})

const DEFAULT_PREFS = {
  chat: { include: 'all', push: true },
  chatRequest: { include: 'all', push: true },
}

export type ChatAuth = ({ req }: MethodAuthContext) => Promise<{
  credentials: { did: string }
}>

export function createApp(opts: {
  service: ChatService
  idResolver: IdResolver
  serviceDid: string
  publicUrl?: string
  /** Moderation services (eg Krao's Ozone) allowed to call chat.bsky.moderation.* */
  moderatorDids?: string[]
}): Express {
  const { service, idResolver, serviceDid } = opts
  const server = createServer([], {})

  /*
   * Users reach the chat service through their PDS, which forwards each call
   * with a service auth token addressed to this service and the method.
   */
  const auth: ChatAuth = async ({ req }) => {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) {
      throw new AuthRequiredError('Service auth token required')
    }
    const nsid = (req.url ?? '').split('?')[0].replace(/^\/xrpc\//, '')
    const payload = await verifyJwt(
      header.slice('Bearer '.length),
      serviceDid,
      nsid,
      (iss, forceRefresh) =>
        idResolver.did.resolveAtprotoKey(iss.split('#')[0], forceRefresh),
    )
    return { credentials: { did: payload.iss.split('#')[0] } }
  }

  const otherMember = (viewer: string, members: readonly string[]) => {
    const others = [...new Set(members)].filter((did) => did !== viewer)
    if (others.length !== 1) {
      throw new InvalidRequestError(
        'Direct convos have exactly one other member',
      )
    }
    return others[0]
  }

  const convo = chat.bsky.convo

  server.add(convo.getConvoForMembers, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const viewer = credentials.did
      const other = otherMember(viewer, params.members)
      let existing = await service.findDirectConvo(viewer, other)
      if (existing) {
        // Coming back to a convo one left reopens it
        await service.db
          .updateTable('member')
          .set({ state: 'active' })
          .where('convoId', '=', existing.id)
          .where('did', '=', viewer)
          .execute()
      } else {
        await service.assertCanMessage(viewer, other)
        await service.createDirectConvo(viewer, other)
        existing = await service.findDirectConvo(viewer, other)
      }
      return json({ convo: await service.convoView(existing!, viewer) })
    },
  })

  server.add(convo.getConvoAvailability, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const viewer = credentials.did
      const other = otherMember(viewer, params.members)
      const existing = await service.findDirectConvo(viewer, other)
      const otherRow = existing && (await service.getMember(existing.id, other))
      let canChat = true
      try {
        await service.assertCanMessage(viewer, other, {
          recipientAccepted: otherRow?.status === 'accepted',
        })
      } catch {
        canChat = false
      }
      const member = existing && (await service.getMember(existing.id, viewer))
      return json({
        canChat,
        ...(existing && member?.state === 'active'
          ? { convo: await service.convoView(existing, viewer) }
          : {}),
      })
    },
  })

  server.add(convo.getConvo, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const { convo: row } = await service.getConvoForViewer(
        params.convoId,
        credentials.did,
      )
      return json({ convo: await service.convoView(row, credentials.did) })
    },
  })

  server.add(convo.getConvoMembers, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const { convo: row } = await service.getConvoForViewer(
        params.convoId,
        credentials.did,
      )
      const members = await service.memberViews(
        row,
        await service.listMembers(row.id),
      )
      return json({ members })
    },
  })

  server.add(convo.listConvos, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      return json(
        await service.listConvos(credentials.did, {
          limit: params.limit ?? 50,
          cursor: params.cursor,
          status: params.status,
          readState: params.readState,
          kind: params.kind,
          lockStatus: params.lockStatus,
        }),
      )
    },
  })

  server.add(convo.listConvoRequests, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const { convos, cursor } = await service.listConvos(credentials.did, {
        limit: params.limit ?? 50,
        cursor: params.cursor,
        status: 'request',
      })
      const pending = cursor
        ? []
        : await service.pendingJoinRequests(credentials.did)
      // requests is a union: each item names its type
      const requests = [
        ...convos.map((c) => ({
          $type: 'chat.bsky.convo.defs#convoView',
          ...c,
        })),
        ...pending,
      ]
      return json({ requests, cursor })
    },
  })

  server.add(convo.getUnreadCounts, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      const counts = { accepted: 0, request: 0 }
      const { convos } = await service.listConvos(credentials.did, {
        limit: 10_000,
      })
      for (const c of convos) {
        const isGroup =
          (c.kind as { $type?: string })?.$type ===
          'chat.bsky.convo.defs#groupConvo'
        if (isGroup && params.includeGroupChats === false) continue
        if ((c.unreadCount as number) > 0 && !c.muted) {
          counts[c.status === 'request' ? 'request' : 'accepted']++
        }
      }
      return json({
        unreadAcceptedConvos: counts.accepted,
        unreadRequestConvos: counts.request,
      })
    },
  })

  server.add(convo.getLog, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      return json(await service.getLog(credentials.did, params.cursor))
    },
  })

  server.add(convo.getMessages, {
    auth,
    handler: async ({ auth: { credentials }, params }) => {
      return json(
        await service.getMessages(params.convoId, credentials.did, {
          limit: params.limit ?? 50,
          cursor: params.cursor,
        }),
      )
    },
  })

  server.add(convo.sendMessage, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      return json(
        await service.sendMessage(
          input.body.convoId,
          credentials.did,
          input.body.message as unknown as MessageInput,
        ),
      )
    },
  })

  server.add(convo.sendMessageBatch, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const items = []
      for (const item of input.body.items) {
        items.push(
          await service.sendMessage(
            item.convoId,
            credentials.did,
            item.message as unknown as MessageInput,
          ),
        )
      }
      return json({ items })
    },
  })

  server.add(convo.deleteMessageForSelf, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      return json(
        await service.deleteForSelf(
          input.body.convoId,
          credentials.did,
          input.body.messageId,
        ),
      )
    },
  })

  server.add(convo.updateRead, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      await service.markRead(
        input.body.convoId,
        credentials.did,
        input.body.messageId,
      )
      const { convo: row } = await service.getConvoForViewer(
        input.body.convoId,
        credentials.did,
      )
      return json({ convo: await service.convoView(row, credentials.did) })
    },
  })

  server.add(convo.updateAllRead, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convos } = await service.listConvos(credentials.did, {
        limit: 10_000,
        status: input.body.status,
      })
      let updatedCount = 0
      for (const c of convos) {
        if ((c.unreadCount as number) > 0) {
          await service.markRead(c.id as string, credentials.did)
          updatedCount++
        }
      }
      return json({ updatedCount })
    },
  })

  server.add(convo.acceptConvo, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { member } = await service.getConvoForViewer(
        input.body.convoId,
        credentials.did,
      )
      if (member.status === 'accepted') return json({})
      return json({
        rev: await service.acceptConvo(input.body.convoId, credentials.did),
      })
    },
  })

  server.add(convo.leaveConvo, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const rev = await service.leaveConvo(input.body.convoId, credentials.did)
      return json({ convoId: input.body.convoId, rev })
    },
  })

  server.add(convo.muteConvo, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo: row } = await service.getConvoForViewer(
        input.body.convoId,
        credentials.did,
      )
      await service.setMuted(row.id, credentials.did, true)
      return json({ convo: await service.convoView(row, credentials.did) })
    },
  })

  server.add(convo.unmuteConvo, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const { convo: row } = await service.getConvoForViewer(
        input.body.convoId,
        credentials.did,
      )
      await service.setMuted(row.id, credentials.did, false)
      return json({ convo: await service.convoView(row, credentials.did) })
    },
  })

  server.add(convo.addReaction, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      return json({
        message: await service.react(
          input.body.convoId,
          credentials.did,
          input.body.messageId,
          input.body.value,
          true,
        ),
      })
    },
  })

  server.add(convo.removeReaction, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      return json({
        message: await service.react(
          input.body.convoId,
          credentials.did,
          input.body.messageId,
          input.body.value,
          false,
        ),
      })
    },
  })

  server.add(chat.bsky.actor.getStatus, {
    auth,
    handler: async () => {
      return json({
        chatDisabled: false,
        canCreateGroups: true,
        groupMemberLimit: GROUP_MEMBER_LIMIT,
      })
    },
  })

  server.add(chat.bsky.actor.deleteAccount, {
    auth,
    handler: async ({ auth: { credentials } }) => {
      await service.deleteAccount(credentials.did)
      return json({})
    },
  })

  server.add(chat.bsky.notification.getPreferences, {
    auth,
    handler: async ({ auth: { credentials } }) => {
      const row = await service.db
        .selectFrom('prefs')
        .select('prefs')
        .where('did', '=', credentials.did)
        .executeTakeFirst()
      return json({
        preferences: row ? JSON.parse(row.prefs) : DEFAULT_PREFS,
      })
    },
  })

  server.add(chat.bsky.notification.putPreferences, {
    auth,
    handler: async ({ auth: { credentials }, input }) => {
      const row = await service.db
        .selectFrom('prefs')
        .select('prefs')
        .where('did', '=', credentials.did)
        .executeTakeFirst()
      const preferences = {
        ...(row ? JSON.parse(row.prefs) : DEFAULT_PREFS),
        ...(input.body.chat ? { chat: input.body.chat } : {}),
        ...(input.body.chatRequest
          ? { chatRequest: input.body.chatRequest }
          : {}),
      }
      await service.db
        .insertInto('prefs')
        .values({ did: credentials.did, prefs: JSON.stringify(preferences) })
        .onConflict((oc) =>
          oc.column('did').doUpdateSet({ prefs: JSON.stringify(preferences) }),
        )
        .execute()
      return json({ preferences })
    },
  })

  addGroupRoutes(server, service, auth)
  addModerationMethods(server, service, {
    idResolver,
    serviceDid,
    moderatorDids: opts.moderatorDids ?? [],
  })

  const app = express()
  app.set('trust proxy', true)
  app.use(cors())
  // Plain landing text so uptime checks on the bare host get a 200
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Krao chat service. Health: /_health')
  })
  app.get('/_health', (_req, res) => {
    res.json({ ok: true, did: serviceDid })
  })
  if (opts.publicUrl && serviceDid.startsWith('did:web:')) {
    app.get('/.well-known/did.json', (_req, res) => {
      res.json({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: serviceDid,
        service: [
          {
            id: '#bsky_chat',
            type: 'BskyChatService',
            serviceEndpoint: opts.publicUrl,
          },
        ],
      })
    })
  }
  app.use(server.router)
  return app
}
