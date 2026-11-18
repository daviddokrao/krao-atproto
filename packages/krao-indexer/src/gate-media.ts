import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Express } from 'express'
import { sql } from 'kysely'
import type { Database } from './db.js'
import type { MediaBlobStore } from './media-store.js'

/*
 * Media for token-gated posts. It lives only in the gate service, never as a
 * repo blob, because repos and their blobs are public. Authors upload it with
 * net.krao.gate.uploadMedia and reference it from putContent; viewers get it
 * through getContent, which checks their wallets and then hands out URLs that
 * carry a short-lived signature (an <img> or <video> tag cannot send
 * service auth).
 */

/** Largest gated image accepted */
export const GATED_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Largest gated video accepted (MP4 or WebM, played as is) */
export const GATED_VIDEO_MAX_BYTES = 50 * 1024 * 1024
/** Largest upload of any kind; the type decides the real limit */
export const GATED_MEDIA_MAX_BYTES = GATED_VIDEO_MAX_BYTES
/** What one account may upload in a day */
export const GATED_MEDIA_DAILY_BYTES = 200 * 1024 * 1024
export const GATED_MEDIA_DAILY_FILES = 50
/** Uploads not attached to any gated content are deleted after this */
const ORPHAN_MEDIA_TTL_MS = 24 * 60 * 60 * 1000

/** How long a signed media URL from getContent stays valid */
const MEDIA_URL_TTL_MS = 10 * 60 * 1000
/** Path the media is served under, followed by the media id */
export const GATED_MEDIA_PATH = '/gate/media/'

/** The media type of `bytes` from its magic number, or null if we don't accept it */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const image = sniffImageType(bytes)
  if (image) return image
  const at = (sig: number[], offset = 0) =>
    sig.every((b, i) => bytes[offset + i] === b)
  // ISO base media: a box size, then "ftyp"
  if (at([0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4'
  // EBML header (Matroska/WebM)
  if (at([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  return null
}

/** Size limit for a sniffed media type */
export function maxBytesFor(mimeType: string): number {
  return mimeType.startsWith('video/')
    ? GATED_VIDEO_MAX_BYTES
    : GATED_IMAGE_MAX_BYTES
}

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
  blobs?: MediaBlobStore,
): Promise<string> {
  const id = randomBytes(16).toString('hex')
  // Bytes first: a row must never point at an object that is not there
  if (blobs) await blobs.put(id, data, mimeType)
  try {
    await db
      .insertInto('gated_media')
      .values({
        id,
        did,
        mimeType,
        data: blobs ? Buffer.alloc(0) : data,
        size: data.length,
        createdAt: new Date().toISOString(),
        store: blobs ? 's3' : 'db',
      })
      .execute()
  } catch (err) {
    await blobs?.delete([id]).catch(() => {})
    throw err
  }
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

/**
 * Whether `did` may upload `size` more bytes today. Uploads are stored in the
 * gate's own database, so they are capped per account.
 */
export async function withinUploadQuota(
  db: Database,
  did: string,
  size: number,
  now = Date.now(),
): Promise<boolean> {
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const row = await db
    .selectFrom('gated_media')
    .select([
      (eb) => eb.fn.countAll<number>().as('files'),
      (eb) => eb.fn.sum<number>('size').as('bytes'),
    ])
    .where('did', '=', did)
    .where('createdAt', '>=', since)
    .executeTakeFirst()
  const files = Number(row?.files ?? 0)
  const bytes = Number(row?.bytes ?? 0)
  return (
    files + 1 <= GATED_MEDIA_DAILY_FILES &&
    bytes + size <= GATED_MEDIA_DAILY_BYTES
  )
}

/**
 * Deletes uploads that no gated content refers to after a day: an author who
 * uploads and never saves, or replaces an image, would otherwise leave the
 * bytes behind forever. Returns how many were deleted.
 */
export async function deleteOrphanedMedia(
  db: Database,
  now = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - ORPHAN_MEDIA_TTL_MS).toISOString()
  // One statement: media ids live in each gated_content row's JSON array
  const result = await db
    .deleteFrom('gated_media')
    .where('createdAt', '<', cutoff)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('gated_content')
            .select(sql`1`.as('one'))
            .where(
              sql<boolean>`exists (select 1 from json_each(gated_content.media) where json_extract(json_each.value, '$.id') = gated_media.id)`,
            ),
        ),
      ),
    )
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}

/*
 * Uploads are checked against the quota and stored one at a time per
 * account; parallel requests would otherwise all pass the check before any
 * of them is counted.
 */
const uploadLocks = new Map<string, Promise<unknown>>()

export async function withUploadLock<T>(
  did: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = uploadLocks.get(did) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(fn)
  uploadLocks.set(did, run)
  try {
    return await run
  } finally {
    if (uploadLocks.get(did) === run) uploadLocks.delete(did)
  }
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
  blobs?: MediaBlobStore,
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
    // Size first: a range request reads only its slice, not the whole file
    const row = await db
      .selectFrom('gated_media')
      .select(['mimeType', 'size', 'store'])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row || (row.store !== 'db' && !blobs)) {
      if (row)
        console.error(`Krao gate: no store configured for ${row.store} media`)
      res.status(404).json({ error: 'NotFound' })
      return
    }
    const slice = async (start: number, length: number) => {
      if (row.store !== 'db' && blobs) return blobs.read(id, start, length)
      const part = await db
        .selectFrom('gated_media')
        .select(sql<Buffer>`substr(data, ${start + 1}, ${length})`.as('bytes'))
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      return part.bytes
    }
    res.set({
      'content-type': row.mimeType,
      // Viewers only; shared caches must not keep gated content
      'cache-control': 'private, max-age=600',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
    })
    // Browsers fetch video in ranges to start playing and to seek
    const range = parseRange(req.headers.range, row.size)
    if (range === 'invalid') {
      res.status(416).set('content-range', `bytes */${row.size}`).end()
      return
    }
    const { start, end } = range ?? { start: 0, end: row.size - 1 }
    if (range) {
      res.status(206).set('content-range', `bytes ${start}-${end}/${row.size}`)
    }
    res.set('content-length', String(end - start + 1))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    // In slices, so a request holds at most SEND_SLICE_BYTES in memory however
    // large the video or the range is
    for (let at = start; at <= end; at += SEND_SLICE_BYTES) {
      if (res.destroyed) return
      const chunk = await slice(at, Math.min(SEND_SLICE_BYTES, end - at + 1))
      if (!res.write(chunk)) {
        if (res.destroyed) return
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.on('drain', done)
          res.on('close', done)
        })
      }
    }
    res.end()
  })
}

/** Bytes read from the database and written per step when serving media */
const SEND_SLICE_BYTES = 1024 * 1024

/**
 * A single `bytes=start-end` range (end inclusive) within `size`, null when
 * there is no Range header, or 'invalid' when it cannot be satisfied.
 * Multiple ranges are not supported and get the whole body.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, from, to] = match
  let start: number
  let end: number
  if (from === '') {
    // Suffix range: the last N bytes
    if (to === '') return 'invalid'
    start = Math.max(size - Number(to), 0)
    end = size - 1
  } else {
    start = Number(from)
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}
