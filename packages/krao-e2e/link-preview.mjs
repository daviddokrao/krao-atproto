// Link previews served by the indexer (cardyb-compatible), including the
// guards that keep user-supplied URLs off the server's own network.
// Needs outbound internet access.
import { INDEXER, checker } from './lib.mjs'

const { check, done } = checker()
const extract = async (url) => {
  const res = await fetch(
    `${INDEXER}/v1/extract?url=${encodeURIComponent(url)}`,
  )
  return res.json()
}

const page = await extract('https://example.com/')
check(
  'a public page is previewed',
  page.error === '' && page.likely_type === 'html' && !!page.title,
  page.error || page.title,
)

const withImage = await extract('https://github.com/bluesky-social/atproto')
check(
  'og:image is returned through the image proxy',
  withImage.error === '' &&
    withImage.image?.startsWith(`${INDEXER}/v1/image?url=`),
  withImage.error || withImage.image,
)
if (withImage.image) {
  const image = await fetch(withImage.image)
  check(
    'the proxied image is served as JPEG',
    image.ok && image.headers.get('content-type') === 'image/jpeg',
    `${image.status} ${image.headers.get('content-type')}`,
  )
}

for (const [name, url, reason] of [
  ['loopback address', 'http://127.0.0.1:2583/xrpc/_health', /not allowed/],
  ['private address', 'http://10.0.0.1/', /not allowed/],
  // localtest.me is public DNS that resolves to 127.0.0.1
  ['hostname resolving to loopback', 'http://localtest.me:2583/', /public/],
  ['localhost', 'http://localhost:2589/_health', /not allowed/],
  ['non-http scheme', 'file:///etc/passwd', /protocol/],
]) {
  const res = await extract(url)
  check(`${name} is refused`, reason.test(res.error), res.error)
}

const blockedImage = await fetch(
  `${INDEXER}/v1/image?url=${encodeURIComponent('http://127.0.0.1:2589/_health')}`,
)
check('the image proxy refuses local addresses', blockedImage.status === 502)
done()
