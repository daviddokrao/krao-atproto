import { timingSafeEqual } from 'node:crypto'
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect'
import { expressConnectMiddleware } from '@connectrpc/connect-express'
import express from 'express'
import { sql } from 'kysely'
import type { AppviewClient } from './appview.js'
import { catchAsyncErrors, errorHandler } from './async-routes.js'
import type { Platform } from './db.js'
import { parseKraoEvent, pushKraoEvent } from './krao-events.js'
import { Service } from './proto/courier_connect.js'
import { AppPlatform } from './proto/courier_pb.js'
import type { LogSender } from './senders.js'
import type { PushService } from './service.js'

export type ServerOptions = {
  /** Key the AppView sends as its courier API key */
  courierKey: string
  /** Token of Krao's services for /internal/notify */
  internalToken: string
  /** The log senders, when no push provider is configured (development) */
  logSenders?: LogSender[]
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const bearer = (header: string | null | undefined) =>
  header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

const PLATFORMS: Partial<Record<AppPlatform, Platform>> = {
  [AppPlatform.IOS]: 'ios',
  [AppPlatform.ANDROID]: 'android',
  [AppPlatform.WEB]: 'web',
}

const isDid = (s: string) => s.startsWith('did:') && s.length <= 2048

/** The courier protocol the AppView speaks (see proto/courier.proto) */
export const courierRoutes =
  (push: PushService, courierKey: string) => (router: ConnectRouter) => {
    const auth = (ctx: HandlerContext) => {
      if (!sameSecret(bearer(ctx.requestHeader.get('authorization')), courierKey)) {
        throw new ConnectError('invalid api key', Code.Unauthenticated)
      }
    }
    router.service(Service, {
      async ping(_req, ctx) {
        auth(ctx)
        return {}
      },
      async registerDeviceToken(req, ctx) {
        auth(ctx)
        const platform = PLATFORMS[req.platform]
        if (
          !platform ||
          !isDid(req.did) ||
          !req.token ||
          req.token.length > 4096 ||
          req.appId.length > 256
        ) {
          throw new ConnectError('invalid token request', Code.InvalidArgument)
        }
        await push.registerToken({
          did: req.did,
          token: req.token,
          platform,
          appId: req.appId,
          ageRestricted: req.ageRestricted,
        })
        return {}
      },
      async unregisterDeviceToken(req, ctx) {
        auth(ctx)
        await push.unregisterToken(req.did, req.token)
        return {}
      },
      async setAgeRestricted(req, ctx) {
        auth(ctx)
        await push.setAgeRestricted(req.did, req.ageRestricted)
        return {}
      },
      async pushNotifications(req, ctx) {
        auth(ctx)
        // The AppView sends these itself only to sync read state (badges)
        for (const n of req.notifications) {
          if (!isDid(n.recipientDid)) continue
          if (n.id && !(await push.claim(`c:${n.id}`))) continue
          const data: Record<string, string> = {}
          for (const [k, v] of Object.entries(n.additional?.toJson() ?? {})) {
            if (typeof v === 'string') data[k] = v
          }
          await push.deliver(n.recipientDid, {
            title: n.title,
            body: n.message,
            data,
            collapseKey: n.collapseKey || undefined,
            threadId: n.threadId || undefined,
            silent: n.clientControlled,
          })
        }
        return {}
      },
    })
  }

export function createApp(
  push: PushService,
  appview: AppviewClient,
  opts: ServerOptions,
): express.Express {
  const app = express()
  catchAsyncErrors(app)
  app.get('/_health', async (_req, res) => {
    try {
      await sql`select 1`.execute(push.db)
      res.json({ ok: true })
    } catch {
      res.status(503).json({ ok: false, error: 'Database' })
    }
  })
  const internal = (req: express.Request, res: express.Response) => {
    if (sameSecret(bearer(req.headers.authorization), opts.internalToken)) {
      return true
    }
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  app.post(
    '/internal/notify',
    express.json({ limit: '64kb' }),
    async (req, res) => {
      if (!internal(req, res)) return
      const evt = parseKraoEvent(req.body)
      if (!evt) {
        res.status(400).json({ error: 'InvalidRequest' })
        return
      }
      const delivered = await pushKraoEvent(push, appview, evt)
      res.json({ delivered })
    },
  )
  if (opts.logSenders) {
    // Development only: what would have reached devices
    app.get('/internal/recent', (req, res) => {
      if (!internal(req, res)) return
      res.json({
        sent: opts.logSenders!.flatMap((s) => s.recent),
      })
    })
  }
  app.use(
    expressConnectMiddleware({
      routes: courierRoutes(push, opts.courierKey),
    }),
  )
  app.use(errorHandler)
  return app
}
