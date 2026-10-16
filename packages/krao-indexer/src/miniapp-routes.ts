import type express from 'express'
import sharp from 'sharp'
import type { IdResolver } from '@atproto/identity'
import { InvalidRequestError, type Server } from '@atproto/xrpc-server'
import type { Database, MiniAppTable } from './db.js'
import { moderatorAuth } from './gate-moderation.js'
import { net } from './lexicons/index.js'
import {
  MiniAppError,
  approveMiniApp,
  getMiniApp,
  hiddenDids,
  listApprovedMiniApps,
  listPendingMiniApps,
  miniAppView,
  revokeMiniApp,
} from './miniapp.js'
import { readLimited } from './safe-fetch.js'
import type { SafetyList } from './safety.js'

/*
 * Mini Apps: public lookups (net.krao.miniapp.getApp, listApproved), the
 * review methods of the safety admins (net.krao.miniapp.admin.*, logged in
 * safety_audit_log), and their icons through /miniapp-icon.
 */

export type MiniAppRouteOptions = {
  idResolver: IdResolver
  gateDid: string
  /** Who reviews Mini Apps (a live set): the safety admins */
  admins: Set<string>
  /** The unsafe domain list: an app on it counts as revoked */
  safety?: SafetyList
  /** This service's URL, for icon links */
  baseUrl: (req: express.Request) => string
}

const ICON_SIZE = 256
const ICON_MAX_BYTES = 1_000_000

export function addMiniAppRoutes(
  server: Server,
  db: Database,
  opts: MiniAppRouteOptions,
) {
  const miniapp = net.krao.miniapp
  const isUnsafe = (url: string) => !!opts.safety?.check(url).unsafe
  const json = <T>(body: T) => ({
    encoding: 'application/json' as const,
    body,
  })
  const views = async (rows: MiniAppTable[], req: express.Request) => {
    const hidden = await hiddenDids(
      db,
      rows.map((r) => r.did),
    )
    return rows.map((row) =>
      miniAppView(row, { hidden, isUnsafe, baseUrl: opts.baseUrl(req) }),
    )
  }
  const adminAuth = (lxm: string) =>
    moderatorAuth(
      {
        idResolver: opts.idResolver,
        gateDid: opts.gateDid,
        moderators: opts.admins,
      },
      lxm,
    )
  const mapErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof MiniAppError) {
        throw new InvalidRequestError(
          err.message,
          err.code === 'InvalidRequest' ? undefined : err.code,
        )
      }
      throw err
    }
  }

  server.add(miniapp.getApp, async ({ params, req }) => {
    const row = await getMiniApp(db, params.uri)
    if (!row) throw new InvalidRequestError('Mini App not found', 'NotFound')
    const [app] = await views([row], req)
    return json({ app } as never)
  })

  server.add(miniapp.listApproved, async ({ params, req }) =>
    mapErrors(async () => {
      const page = await listApprovedMiniApps(db, {
        limit: params.limit ?? 25,
        cursor: params.cursor,
        isUnsafe,
      })
      return json({
        apps: await views(page.rows, req),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      } as never)
    }),
  )

  server.add(miniapp.admin.listPending, {
    auth: adminAuth(miniapp.admin.listPending.$lxm),
    handler: async ({ params, req }) =>
      mapErrors(async () => {
        const page = await listPendingMiniApps(db, {
          limit: params.limit ?? 25,
          cursor: params.cursor,
        })
        return json({
          apps: await views(page.rows, req),
          ...(page.cursor ? { cursor: page.cursor } : {}),
        } as never)
      }),
  })

  server.add(miniapp.admin.approve, {
    auth: adminAuth(miniapp.admin.approve.$lxm),
    handler: async ({ auth, input, req }) =>
      mapErrors(async () => {
        const admin = (auth.credentials as { did: string }).did
        const row = await approveMiniApp(db, admin, input.body, isUnsafe)
        console.info(`Krao indexer: ${admin} approved Mini App ${row.uri}`)
        const [app] = await views([row], req)
        return json({ app } as never)
      }),
  })

  server.add(miniapp.admin.revoke, {
    auth: adminAuth(miniapp.admin.revoke.$lxm),
    handler: async ({ auth, input, req }) =>
      mapErrors(async () => {
        const admin = (auth.credentials as { did: string }).did
        const row = await revokeMiniApp(db, admin, input.body)
        console.info(`Krao indexer: ${admin} revoked Mini App ${row.uri}`)
        const [app] = await views([row], req)
        return json({ app } as never)
      }),
  })
}

/**
 * GET /miniapp-icon?uri=<at-uri>: the app's icon as a 256px PNG. The blob is
 * read from Krao's PDS (the one this indexer follows), never from a host
 * the record names, so clients load icons from Krao only.
 */
export function addMiniAppIconRoute(
  app: express.Express,
  db: Database,
  opts: { pdsUrl?: string },
) {
  const cache = new Map<string, Buffer>()
  app.get('/miniapp-icon', async (req, res) => {
    const { uri } = req.query
    const row = typeof uri === 'string' ? await getMiniApp(db, uri) : undefined
    if (!row?.iconCid || !opts.pdsUrl) {
      res.status(404).json({ error: 'NotFound', message: 'No icon' })
      return
    }
    const key = `${row.did}/${row.iconCid}`
    try {
      let png = cache.get(key)
      if (!png) {
        const url = new URL('/xrpc/com.atproto.sync.getBlob', opts.pdsUrl)
        url.searchParams.set('did', row.did)
        url.searchParams.set('cid', row.iconCid)
        const blob = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (!blob.ok) throw new Error(`getBlob: HTTP ${blob.status}`)
        // Global fetch's Response, read the same way as safeFetch's
        png = await sharp(await readLimited(blob as never, ICON_MAX_BYTES))
          .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover' })
          .png()
          .toBuffer()
        if (cache.size >= 500) cache.clear()
        cache.set(key, png)
      }
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'public, max-age=86400')
      res.send(png)
    } catch (err) {
      console.error('Krao indexer: Mini App icon failed', row.uri, err)
      res
        .status(502)
        .json({ error: 'UpstreamFailure', message: 'Could not read the icon' })
    }
  })
}
