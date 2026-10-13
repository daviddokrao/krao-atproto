import { Readable } from 'node:stream'
import type { Express, Request, Response } from 'express'
import { fetch } from 'undici'

/**
 * GIFs, replacing Bluesky's gifs.bsky.app proxy:
 * - `/gifs/t/*` and `/gifs/k/*` relay GIF media from Tenor and Klipy, so
 *   viewers' browsers never contact them directly. Only those two hosts can
 *   be reached, so this is not an open proxy.
 * - `/klipy/v2/:method` forwards GIF search to Klipy's Tenor-compatible API
 *   with Krao's API key, which never reaches clients.
 */

const MEDIA_HOSTS = {
  t: 'https://media.tenor.com',
  k: 'https://static.klipy.com',
} as const

const KLIPY_API = 'https://api.klipy.com/v2'
const KLIPY_METHODS = new Set(['search', 'featured', 'autocomplete'])

/** Response headers worth passing on for media (incl. ranges for video) */
const MEDIA_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
]

export function addGifRoutes(app: Express, klipyApiKey?: string) {
  for (const [prefix, origin] of Object.entries(MEDIA_HOSTS)) {
    app.get(`/gifs/${prefix}/*`, (req, res) => relayMedia(req, res, origin))
  }

  app.get('/klipy/v2/:method', async (req, res) => {
    if (!klipyApiKey) {
      res.status(503).json({ error: 'GifSearchUnavailable' })
      return
    }
    if (!KLIPY_METHODS.has(req.params.method)) {
      res.status(404).json({ error: 'NotFound' })
      return
    }
    const url = new URL(`${KLIPY_API}/${req.params.method}`)
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string' && k !== 'key') url.searchParams.set(k, v)
    }
    url.searchParams.set('key', klipyApiKey)
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) })
      res.status(upstream.status)
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'public, max-age=300')
      res.send(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      res.status(502).json({ error: 'UpstreamFailure' })
    }
  })
}

async function relayMedia(req: Request, res: Response, origin: string) {
  // Keep the path as requested (eg Tenor ids); setting only the pathname
  // means it can never change the host
  const path = req.originalUrl.replace(/^\/gifs\/[tk]\//, '').split('?')[0]
  if (!path || path.startsWith('/')) {
    res.status(400).end()
    return
  }
  const url = new URL(origin)
  url.pathname = `/${path}`
  try {
    const range = req.header('range')
    const upstream = await fetch(url, {
      headers: range ? { range } : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    res.status(upstream.status)
    for (const name of MEDIA_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) res.setHeader(name, value)
    }
    res.setHeader('cache-control', 'public, max-age=86400')
    if (!upstream.body) {
      res.end()
      return
    }
    Readable.fromWeb(upstream.body as never)
      .on('error', () => res.destroy())
      .pipe(res)
  } catch {
    res.status(502).end()
  }
}
