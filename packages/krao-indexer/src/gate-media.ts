import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Express } from 'express'
import type { Database } from './db.js'

/*
 * Media for token-gated posts. It lives only in the gate service, never as a
 * repo blob, because repos and their blobs are public. Authors upload it with
 * net.krao.gate.uploadMedia and reference it from putContent; viewers get it
 * through getContent, which checks their wallets and then hands out URLs that
 * carry a short-lived signature (an <img> tag cannot send service auth).
 */

/** Largest gated image accepted */
export const GATED_MEDIA_MAX_BYTES = 5 * 1024 * 1024
/** How long a signed media URL from getContent stays valid */
const MEDIA_URL_TTL_MS = 10 * 60 * 1000
/** Path the media is served under, followed by the media id */
export const GATED_MEDIA_PATH = '/gate/media/'

/** The image type of `bytes` from its magic number, or null if not an image we accept */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) =>
    sig.every((b, i) => bytes[at + i] === b)
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'
  }
  return null
}

/** Reads an upload, refusing anything over `max` bytes */
export async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  max: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > max) throw new Error('TooLarge')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export async function insertGatedMedia(
  db: Database,
  did: string,
  mimeType: string,
  data: Buffer,
): Promise<string> {
  const id = randomBytes(16).toString('hex')
  await db
    .insertInto('gated_media')
    .values({
      id,
      did,
      mimeType,
      data,
      size: data.length,
      createdAt: new Date().toISOString(),
    })
    .execute()
  return id
}

/** Media owned by `did`, keyed by id; ids of other accounts are left out */
export async function ownedGatedMedia(
  db: Database,
  did: string,
  ids: string[],
) {
  if (!ids.length) return new Map<string, string>()
  const rows = await db
    .selectFrom('gated_media')
    .select(['id', 'mimeType'])
    .where('did', '=', did)
    .where('id', 'in', ids)
    .execute()
  return new Map(rows.map((r) => [r.id, r.mimeType]))
}

export async function deleteGatedMediaForDid(db: Database, did: string) {
  await db.deleteFrom('gated_media').where('did', '=', did).execute()
}

/** The media id in a gate media URL (signature and query ignored), or null */
export function mediaIdFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    if (!pathname.startsWith(GATED_MEDIA_PATH)) return null
    const id = pathname.slice(GATED_MEDIA_PATH.length)
    return /^[0-9a-f]{32}$/.test(id) ? id : null
  } catch {
    return null
  }
}

export class MediaSigner {
  private secret: Buffer

  constructor(secret?: string) {
    // Without a configured secret, URLs simply stop working on restart
    this.secret = secret ? Buffer.from(secret) : randomBytes(32)
  }

  private sign(id: string, exp: number) {
    return createHmac('sha256', this.secret)
      .update(`${id}.${exp}`)
      .digest('base64url')
  }

  /** A URL for `id` that works for {@link MEDIA_URL_TTL_MS} */
  url(base: string, id: string, now = Date.now()): string {
    const exp = now + MEDIA_URL_TTL_MS
    const url = new URL(`${GATED_MEDIA_PATH}${id}`, base)
    url.searchParams.set('exp', String(exp))
    url.searchParams.set('sig', this.sign(id, exp))
    return url.toString()
  }

  verify(id: string, exp: string, sig: string, now = Date.now()): boolean {
    const expMs = Number(exp)
    if (!Number.isFinite(expMs) || expMs < now) return false
    const expected = Buffer.from(this.sign(id, expMs))
    const given = Buffer.from(sig)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }
}

/** Serves gated media to holders of a signed URL from getContent */
export function addGatedMediaRoute(
  app: Express,
  db: Database,
  signer: MediaSigner,
) {
  app.get(`${GATED_MEDIA_PATH}:id`, async (req, res) => {
    const { id } = req.params
    const { exp, sig } = req.query
    if (
      typeof exp !== 'string' ||
      typeof sig !== 'string' ||
      !signer.verify(id, exp, sig)
    ) {
      res
        .status(403)
        .json({ error: 'Forbidden', message: 'Invalid or expired link' })
      return
    }
    const row = await db
      .selectFrom('gated_media')
      .select(['mimeType', 'data'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) {
      res.status(404).json({ error: 'NotFound' })
      return
    }
    res.set({
      'content-type': row.mimeType,
      // Viewers only; shared caches must not keep gated content
      'cache-control': 'private, max-age=600',
      'x-content-type-options': 'nosniff',
    })
    res.send(row.data)
  })
}
