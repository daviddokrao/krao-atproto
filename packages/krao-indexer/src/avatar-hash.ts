import sharp from 'sharp'
import { readLimited } from './safe-fetch.js'

/*
 * Perceptual hashes of avatars (M35, impersonation checks): a 64-bit dHash
 * (each bit: is a pixel brighter than its right neighbour, on a 9x8
 * grayscale thumbnail). Re-encoding, resizing and small edits change few
 * bits; "similar" is a Hamming distance of at most 10.
 */

export const SIMILAR_AVATAR_DISTANCE = 10
/** Largest avatar blob read (Bluesky caps avatars at 1 MB) */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const MAX_PIXELS = 4096 * 4096

/** The dHash of an image, as 16 hex digits */
export async function dHash(image: Buffer): Promise<string> {
  const { data } = await sharp(image, { limitInputPixels: MAX_PIXELS })
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  let bits = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x]
      const right = data[y * 9 + x + 1]
      bits = (bits << 1n) | (left > right ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(16, '0')
}

/** Bits that differ between two hashes */
export function hammingDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (diff) {
    count += Number(diff & 1n)
    diff >>= 1n
  }
  return count
}

export function similarAvatars(a?: string | null, b?: string | null) {
  return !!a && !!b && hammingDistance(a, b) <= SIMILAR_AVATAR_DISTANCE
}

/**
 * Reads an avatar blob from Krao's PDS (com.atproto.sync.getBlob), at most
 * AVATAR_MAX_BYTES within 10 seconds, and hashes it
 */
export async function fetchAvatarHash(
  pdsUrl: string,
  did: string,
  cid: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const url = new URL('/xrpc/com.atproto.sync.getBlob', pdsUrl)
  url.searchParams.set('did', did)
  url.searchParams.set('cid', cid)
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`getBlob: HTTP ${res.status}`)
  return dHash(await readLimited(res as never, AVATAR_MAX_BYTES))
}
