import { describe, expect, it } from 'vitest'
import {
  MediaSigner,
  mediaIdFromUrl,
  readBounded,
  sniffImageType,
} from './gate-media.js'

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
