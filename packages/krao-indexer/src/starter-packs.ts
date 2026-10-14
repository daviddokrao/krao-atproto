import { randomBytes } from 'node:crypto'
import express, { type Express } from 'express'
import sharp from 'sharp'
import type { Database } from './db.js'

/**
 * Starter pack sharing, replacing Bluesky's go.bsky.app (bskylink) and
 * ogcard.cdn.bsky.app:
 * - `POST /s/link {path}` and `GET /s/:code` shorten links to pages of
 *   Krao's web app, with bskylink's API (JSON when asked, else a redirect).
 * - `GET /ogcard/start/:did/:rkey` renders a starter pack's share card.
 */

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_PATH_LENGTH = 512

/**
 * Where a short link may lead: a path on Krao's web app only. URL parsing
 * treats `\` like `/` and drops tabs and newlines, so `/\evil.com` would
 * otherwise resolve to another site (an open redirect on Krao's domain).
 */
export function shortLinkTarget(path: unknown, webUrl: string): string | null {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > MAX_PATH_LENGTH ||
    /[\\\x00-\x1f\x7f]/.test(path)
  ) {
    return null
  }
  const base = new URL(webUrl)
  const url = new URL(path, base)
  return url.origin === base.origin ? url.toString() : null
}

function newCode(length = 8) {
  return Array.from(
    randomBytes(length),
    (b) => CODE_ALPHABET[b % CODE_ALPHABET.length],
  ).join('')
}

export function addStarterPackRoutes(
  app: Express,
  db: Database,
  opts: {
    /** Krao's web app, where short links lead */
    webUrl: string
    /** Public URL of this service, for the short links it hands out */
    publicUrl?: string
    appviewUrl?: string
  },
) {
  app.post('/s/link', express.json({ limit: '4kb' }), async (req, res) => {
    const path = (req.body as { path?: unknown } | undefined)?.path
    if (typeof path !== 'string' || !shortLinkTarget(path, opts.webUrl)) {
      res.status(400).json({ error: 'InvalidPath' })
      return
    }
    const existing = await db
      .selectFrom('short_link')
      .select('code')
      .where('path', '=', path)
      .executeTakeFirst()
    let code = existing?.code
    if (!code) {
      code = newCode()
      await db
        .insertInto('short_link')
        .values({ code, path, createdAt: new Date().toISOString() })
        .execute()
    }
    const base = opts.publicUrl ?? `${req.protocol}://${req.get('host')}`
    res.json({ url: `${base}/s/${code}` })
  })

  app.get('/s/:code', async (req, res) => {
    const row = await db
      .selectFrom('short_link')
      .select('path')
      .where('code', '=', req.params.code)
      .executeTakeFirst()
    if (!row) {
      res.status(404).json({ error: 'NotFound' })
      return
    }
    // Checked again: links stored before this check existed
    const url = shortLinkTarget(row.path, opts.webUrl)
    if (!url) {
      res.status(404).json({ error: 'NotFound' })
      return
    }
    if (req.accepts(['html', 'json']) === 'json') {
      res.json({ url })
    } else {
      res.redirect(302, url)
    }
  })

  app.get('/ogcard/start/:did/:rkey', async (req, res) => {
    const { did, rkey } = req.params
    if (!opts.appviewUrl || !/^did:[a-z]+:[\w.:%-]+$/.test(did)) {
      res.status(400).end()
      return
    }
    try {
      const url = new URL(
        '/xrpc/app.bsky.graph.getStarterPack',
        opts.appviewUrl,
      )
      url.searchParams.set(
        'starterPack',
        `at://${did}/app.bsky.graph.starterpack/${rkey}`,
      )
      const upstream = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!upstream.ok) {
        res.status(404).end()
        return
      }
      const { starterPack } = (await upstream.json()) as {
        starterPack: {
          record: { name?: string; description?: string }
          creator: { handle: string; displayName?: string }
          list?: { listItemCount?: number }
        }
      }
      const png = await renderStarterPackCard({
        name: starterPack.record.name ?? 'Starter pack',
        description: starterPack.record.description,
        creator:
          starterPack.creator.displayName || `@${starterPack.creator.handle}`,
        members: starterPack.list?.listItemCount,
      })
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.send(png)
    } catch {
      res.status(502).end()
    }
  })
}

const escapeXml = (text: string) =>
  text.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[c] as string,
  )

const truncate = (text: string, max: number) =>
  [...text].length > max ? [...text].slice(0, max - 1).join('') + '…' : text

/** A 1200×630 share card in Krao's colors */
export async function renderStarterPackCard(card: {
  name: string
  description?: string
  creator: string
  members?: number
}): Promise<Buffer> {
  const name = escapeXml(truncate(card.name, 28))
  const description = card.description
    ? escapeXml(truncate(card.description.replace(/\s+/g, ' '), 90))
    : ''
  const creator = escapeXml(truncate(card.creator, 40))
  const members = card.members !== undefined ? ` · ${card.members} người` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#0E8C6E"/>
  <circle cx="1080" cy="120" r="36" fill="#FFC233"/>
  <text x="80" y="140" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#FFC233" font-weight="bold">Krao · Starter pack</text>
  <text x="80" y="300" font-family="DejaVu Sans, sans-serif" font-size="72" fill="#FFFFFF" font-weight="bold">${name}</text>
  <text x="80" y="380" font-family="DejaVu Sans, sans-serif" font-size="32" fill="#E6F4EF">${description}</text>
  <text x="80" y="540" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#FFFFFF">bởi ${creator}${escapeXml(members)}</text>
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}
