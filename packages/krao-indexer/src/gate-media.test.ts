import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  GATED_MEDIA_DAILY_FILES,
  MediaSigner,
  addGatedMediaRoute,
  deleteOrphanedMedia,
  insertGatedMedia,
  maxBytesFor,
  mediaIdFromUrl,
  parseRange,
  readBounded,
  sniffImageType,
  sniffMediaType,
  withinUploadQuota,
} from './gate-media.js'
import { deleteGateDataForDid, putGatedContent } from './gate.js'
import { MemoryMediaStore, purgeMediaTrash } from './media-store.js'

const bytes = (...b: number[]) => Uint8Array.from(b)

describe('sniffImageType', () => {
  it('recognises images by their bytes', () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(
      sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe('image/png')
    expect(sniffImageType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(
      'image/webp',
    )
  })

  it('refuses anything else, whatever it claims to be', () => {
    expect(sniffImageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeNull()
    expect(sniffImageType(bytes())).toBeNull()
  })
})

describe('sniffMediaType', () => {
  it('accepts MP4 and WebM video as well as images', () => {
    expect(sniffMediaType(Buffer.from('\0\0\0\x18ftypmp42'))).toBe('video/mp4')
    expect(sniffMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01))).toBe(
      'video/webm',
    )
    expect(sniffMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffMediaType(Buffer.from('#!/bin/sh'))).toBeNull()
  })

  it('allows bigger videos than images', () => {
    expect(maxBytesFor('video/mp4')).toBeGreaterThan(maxBytesFor('image/png'))
  })
})

describe('parseRange', () => {
  it('reads single byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
  })

  it('refuses ranges outside the body', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=20-10', 100)).toBe('invalid')
  })
})

describe('MediaSigner', () => {
  const signer = new MediaSigner('secret')
  const id = 'a'.repeat(32)
  const now = Date.parse('2026-10-14T12:00:00Z')

  const parts = (url: string) => {
    const u = new URL(url)
    return {
      id: mediaIdFromUrl(url),
      exp: u.searchParams.get('exp') ?? '',
      sig: u.searchParams.get('sig') ?? '',
    }
  }

  it('signs URLs that verify until they expire', () => {
    const p = parts(signer.url('https://idx.krao.net', id, now))
    expect(p.id).toBe(id)
    expect(signer.verify(id, p.exp, p.sig, now + 60_000)).toBe(true)
    expect(signer.verify(id, p.exp, p.sig, now + 11 * 60_000)).toBe(false)
  })

  it('rejects a signature for another media, a forged one, or another key', () => {
    const p = parts(signer.url('https://idx.krao.net', id, now))
    expect(signer.verify('b'.repeat(32), p.exp, p.sig, now)).toBe(false)
    expect(signer.verify(id, p.exp, 'forged', now)).toBe(false)
    expect(signer.verify(id, String(Number(p.exp) + 1), p.sig, now)).toBe(false)
    expect(new MediaSigner('other').verify(id, p.exp, p.sig, now)).toBe(false)
  })
})

describe('mediaIdFromUrl', () => {
  it('only accepts gate media paths with a hex id', () => {
    expect(mediaIdFromUrl(`https://x/gate/media/${'f'.repeat(32)}?sig=1`)).toBe(
      'f'.repeat(32),
    )
    expect(mediaIdFromUrl('https://x/gate/media/../../etc/passwd')).toBeNull()
    expect(mediaIdFromUrl('https://x/other/abc')).toBeNull()
    expect(mediaIdFromUrl('not a url')).toBeNull()
  })
})

describe('readBounded', () => {
  async function* chunks(...sizes: number[]) {
    for (const size of sizes) yield new Uint8Array(size)
  }

  it('reads up to the limit and refuses more', async () => {
    expect((await readBounded(chunks(3, 4), 7)).length).toBe(7)
    await expect(readBounded(chunks(3, 5), 7)).rejects.toThrow('TooLarge')
  })
})

describe('with a database', () => {
  let db: Database

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('caps the number of uploads per account per day', async () => {
    for (let i = 0; i < GATED_MEDIA_DAILY_FILES; i++) {
      await insertGatedMedia(db, 'did:a', 'image/png', Buffer.alloc(10))
    }
    expect(await withinUploadQuota(db, 'did:a', 10)).toBe(false)
    expect(await withinUploadQuota(db, 'did:b', 10)).toBe(true)
    // A day later the quota is back
    expect(
      await withinUploadQuota(db, 'did:a', 10, Date.now() + 25 * 3_600_000),
    ).toBe(true)
  })

  it('deletes day-old uploads that no gated content uses', async () => {
    const used = await insertGatedMedia(
      db,
      'did:a',
      'image/png',
      Buffer.alloc(1),
    )
    const orphan = await insertGatedMedia(
      db,
      'did:a',
      'image/png',
      Buffer.alloc(1),
    )
    await putGatedContent(db, {
      subject: 'at://did:a/app.bsky.feed.post/1',
      did: 'did:a',
      text: '',
      facets: undefined,
      media: [{ id: used, mimeType: 'image/png' }],
    })
    expect(await deleteOrphanedMedia(db)).toBe(0)
    expect(await deleteOrphanedMedia(db, Date.now() + 25 * 3_600_000)).toBe(1)
    const left = await db.selectFrom('gated_media').select('id').execute()
    expect(left.map((r) => r.id)).toEqual([used])
    expect(left.map((r) => r.id)).not.toContain(orphan)
  })

  describe('with a blob store', () => {
    it('keeps the bytes in the store and serves ranges from it', async () => {
      const blobs = new MemoryMediaStore()
      const data = Buffer.from('0123456789')
      const id = await insertGatedMedia(db, 'did:a', 'video/mp4', data, blobs)
      const row = await db
        .selectFrom('gated_media')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.store).toBe('s3')
      expect(row.data.length).toBe(0)
      expect(row.size).toBe(10)
      expect(blobs.objects.get(id)).toEqual(data)

      const app = express()
      const signer = new MediaSigner('secret')
      addGatedMediaRoute(app, db, signer, blobs)
      const server = app.listen(0)
      await once(server, 'listening')
      try {
        const { port } = server.address() as AddressInfo
        const url = signer.url(`http://localhost:${port}`, id)
        const res = await fetch(url, { headers: { range: 'bytes=2-5' } })
        expect(res.status).toBe(206)
        expect(await res.text()).toBe('2345')
        // Without a store, s3 media cannot be served
        const bare = express()
        addGatedMediaRoute(bare, db, signer)
        const other = bare.listen(0)
        await once(other, 'listening')
        const otherPort = (other.address() as AddressInfo).port
        const res2 = await fetch(
          signer.url(`http://localhost:${otherPort}`, id),
        )
        expect(res2.status).toBe(404)
        other.close()
      } finally {
        server.close()
      }
    })

    it('removes the bytes of every deleted row', async () => {
      const blobs = new MemoryMediaStore()
      const orphan = await insertGatedMedia(
        db,
        'did:a',
        'image/png',
        Buffer.alloc(1),
        blobs,
      )
      const owned = await insertGatedMedia(
        db,
        'did:b',
        'image/png',
        Buffer.alloc(1),
        blobs,
      )
      const kept = await insertGatedMedia(
        db,
        'did:c',
        'image/png',
        Buffer.alloc(1),
      )
      expect(await deleteOrphanedMedia(db, Date.now() + 25 * 3_600_000)).toBe(3)
      // Rows in the database itself need no purge
      expect(kept).toBeTruthy()
      expect(blobs.objects.size).toBe(2)
      expect(await purgeMediaTrash(db, blobs)).toBe(1 + 1)
      expect(blobs.objects.size).toBe(0)

      const again = await insertGatedMedia(
        db,
        'did:b',
        'image/png',
        Buffer.alloc(1),
        blobs,
      )
      await deleteGateDataForDid(db, 'did:b')
      expect(await purgeMediaTrash(db, blobs)).toBe(1)
      expect(blobs.objects.has(again)).toBe(false)
      expect([orphan, owned]).not.toContain(again)
    })
  })
})
