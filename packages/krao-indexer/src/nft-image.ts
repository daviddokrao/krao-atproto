import sharp from 'sharp'
import { readLimited, safeFetch } from './safe-fetch.js'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const AVATAR_SIZE = 512

/**
 * Fetch an NFT image and convert it to a square PNG suitable for a profile
 * avatar (AT Protocol avatars must be PNG or JPEG, and many NFT images are
 * SVGs served without CORS headers, so clients can't convert them).
 *
 * The URL comes from on-chain metadata, which anyone can set, so only public
 * https URLs and inline data images are fetched.
 */
export async function fetchNftImageAsPng(url: string): Promise<Buffer> {
  let input: Buffer
  if (url.startsWith('data:image/')) {
    const [meta, data] = url.split(',', 2)
    input = meta.includes(';base64')
      ? Buffer.from(data, 'base64')
      : Buffer.from(decodeURIComponent(data), 'utf8')
  } else {
    const { res } = await safeFetch(url, { timeoutMs: 10_000 })
    if (!res.ok) throw new Error(`Image request failed: ${res.status}`)
    input = await readLimited(res, MAX_IMAGE_BYTES)
  }
  if (input.length > MAX_IMAGE_BYTES) throw new Error('Image is too large')
  return sharp(input, { density: 144 })
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
    .png()
    .toBuffer()
}
