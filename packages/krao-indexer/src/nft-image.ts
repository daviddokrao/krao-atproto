import { isIP } from 'node:net'
import sharp from 'sharp'

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
    assertPublicHttpsUrl(url)
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
    if (!res.ok) throw new Error(`Image request failed: ${res.status}`)
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_IMAGE_BYTES) throw new Error('Image is too large')
    input = Buffer.from(await res.arrayBuffer())
  }
  if (input.length > MAX_IMAGE_BYTES) throw new Error('Image is too large')
  return sharp(input, { density: 144 })
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
    .png()
    .toBuffer()
}

function assertPublicHttpsUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== 'https:') throw new Error('Only https images')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    (isIP(host) && isPrivateIp(host))
  ) {
    throw new Error('Image host is not allowed')
  }
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase()
    return (
      v6 === '::1' ||
      v6.startsWith('fc') ||
      v6.startsWith('fd') ||
      v6.startsWith('fe80')
    )
  }
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
