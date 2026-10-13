import sharp from 'sharp'
import { readLimited, readPrefix, safeFetch } from './safe-fetch.js'

/**
 * Link previews for the composer, replacing Bluesky's cardyb service with the
 * same API: `/v1/extract?url=` returns the page's title, description and an
 * image URL, and `/v1/image?url=` serves that image through this service so
 * browsers can read it (most sites send no CORS headers).
 */

const MAX_HTML_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_SIDE = 1200
const USER_AGENT = 'Mozilla/5.0 (compatible; KraoLinkPreview/1.0)'

/** cardyb's response shape, which the app parses */
export type LinkMeta = {
  error: string
  likely_type: 'html' | 'image' | 'other'
  url: string
  title?: string
  description?: string
  image?: string
}

const cache = new Map<string, { at: number; meta: LinkMeta }>()
const CACHE_MS = 10 * 60 * 1000

export async function extractLinkMeta(
  url: string,
  imageProxyUrl: (imageUrl: string) => string,
): Promise<LinkMeta> {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.meta
  const meta = await extractUncached(url, imageProxyUrl)
  if (cache.size > 1000) cache.clear()
  cache.set(url, { at: Date.now(), meta })
  return meta
}

async function extractUncached(
  url: string,
  imageProxyUrl: (imageUrl: string) => string,
): Promise<LinkMeta> {
  try {
    const { res, url: finalUrl } = await safeFetch(url, {
      allowHttp: true,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' },
    })
    if (!res.ok) {
      await res.body?.cancel()
      return failure(url, `Request failed: ${res.status}`)
    }
    const type = res.headers.get('content-type') ?? ''
    if (type.startsWith('image/')) {
      await res.body?.cancel()
      return {
        error: '',
        likely_type: 'image',
        url: finalUrl,
        image: imageProxyUrl(finalUrl),
      }
    }
    if (!type.includes('html')) {
      await res.body?.cancel()
      return { error: '', likely_type: 'other', url: finalUrl }
    }
    const html = (await readPrefix(res, MAX_HTML_BYTES)).toString('utf8')
    const tags = parseMetaTags(html)
    const image = tags['og:image'] ?? tags['twitter:image']
    const imageUrl = image ? safeAbsoluteUrl(image, finalUrl) : undefined
    return {
      error: '',
      likely_type: 'html',
      url: finalUrl,
      title: tags['og:title'] ?? tags['twitter:title'] ?? parseTitle(html),
      description:
        tags['og:description'] ??
        tags['twitter:description'] ??
        tags['description'],
      image: imageUrl ? imageProxyUrl(imageUrl) : undefined,
    }
  } catch (err) {
    // undici reports connection errors (eg a blocked address) as the cause
    const cause = (err as { cause?: Error }).cause
    return failure(url, cause?.message ?? (err as Error).message)
  }
}

function failure(url: string, error: string): LinkMeta {
  return { error: error || 'Failed to fetch link', likely_type: 'other', url }
}

/** A link preview image, re-encoded as JPEG so nothing active passes through */
export async function fetchPreviewImage(url: string): Promise<Buffer> {
  const { res } = await safeFetch(url, {
    allowHttp: true,
    headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
  })
  if (!res.ok) throw new Error(`Image request failed: ${res.status}`)
  if (!(res.headers.get('content-type') ?? '').startsWith('image/')) {
    await res.body?.cancel()
    throw new Error('Not an image')
  }
  const input = await readLimited(res, MAX_IMAGE_BYTES)
  return sharp(input, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer()
}

/** `<meta property|name="…" content="…">` values, first one wins */
export function parseMetaTags(html: string): Record<string, string> {
  const head = html.slice(0, html.search(/<\/head>/i) + 1 || undefined)
  const tags: Record<string, string> = {}
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(tag, 'property') ?? attr(tag, 'name')
    const content = attr(tag, 'content')
    if (!key || content === undefined) continue
    const name = key.toLowerCase()
    if (!(name in tags)) tags[name] = decodeEntities(content).trim()
  }
  return tags
}

function parseTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  const title = match ? decodeEntities(match[1]).trim() : ''
  return title || undefined
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi,
    (entity, code: string) => {
      const lower = code.toLowerCase()
      if (lower.startsWith('#')) {
        const point = lower.startsWith('#x')
          ? parseInt(lower.slice(2), 16)
          : parseInt(lower.slice(1), 10)
        return point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity
      }
      return (
        (
          {
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'",
            nbsp: ' ',
          } as Record<string, string>
        )[lower] ?? entity
      )
    },
  )
}

function safeAbsoluteUrl(href: string, base: string): string | undefined {
  try {
    const url = new URL(href, base)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}
