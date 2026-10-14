// M6: token-gated posts. The gated body and images live in the gate service
// (inside @krao/indexer), never in the public repo, and are served with
// service auth only to viewers whose linked wallets meet the rule.
import {
  ACCOUNTS,
  ANVIL_KEYS,
  ETH_ASSET,
  GATE,
  GATE_DID,
  PDS,
  USDC,
  USDC_ASSET,
  checker,
  createRecord,
  dealErc20,
  linkWallet,
  login,
  serviceAuth,
  sleep,
  wallet,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const getContent = async (s, uri) =>
  xrpc(GATE, 'net.krao.gate.getContent', {
    token: await serviceAuth(s, 'net.krao.gate.getContent'),
    query: { uri },
  })

const author = await login(ACCOUNTS.krao)
const holder = await login(ACCOUNTS.minh)
const poor = await login(ACCOUNTS.mai)
const noWallet = await login(ACCOUNTS.lan)
const holderWallet = wallet(ANVIL_KEYS[1])
const poorWallet = wallet(ANVIL_KEYS[2])
await dealErc20(holderWallet.address, USDC, 50_000_000n) // 50 USDC
await dealErc20(poorWallet.address, USDC, 1_000_000n) // 1 USDC
await linkWallet(holder, holderWallet)
await linkWallet(poor, poorWallet)

// The author posts a public teaser, stores the gated part, then the rule
const post = (
  await createRecord(author, 'app.bsky.feed.post', {
    text: '🔒 Alpha cho holder: cần ≥ 10 USDC để xem.',
    createdAt: new Date().toISOString(),
  })
).data
const secret = 'Alpha: airdrop snapshot vào thứ 6, nhớ bridge sang Base trước.'
const put = await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(author, 'net.krao.gate.putContent'),
  body: { uri: post.uri, text: secret },
})
check('author can store gated content', put.ok, JSON.stringify(put.data))
const hijack = await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(holder, 'net.krao.gate.putContent'),
  body: { uri: post.uri, text: 'hijacked' },
})
check(
  'a non-author cannot overwrite it',
  !hijack.ok && hijack.data.error === 'NotAuthor',
  hijack.data.error,
)
const rule = await createRecord(author, 'net.krao.gate.rule', {
  subject: { uri: post.uri, cid: post.cid },
  conditions: [
    {
      $type: 'net.krao.gate.defs#tokenBalance',
      asset: USDC_ASSET,
      minAmount: '10000000',
    },
  ],
  match: 'all',
  service: GATE_DID,
  createdAt: new Date().toISOString(),
})
check('gate rule record accepted', rule.ok, rule.data.error)
// Someone else tries to gate the author's post from their own repo
await createRecord(noWallet, 'net.krao.gate.rule', {
  subject: { uri: post.uri, cid: post.cid },
  conditions: [
    {
      $type: 'net.krao.gate.defs#tokenBalance',
      asset: ETH_ASSET,
      minAmount: '1',
    },
  ],
  service: GATE_DID,
  createdAt: new Date().toISOString(),
})
await sleep(2500)

const rules = await xrpc(GATE, 'net.krao.gate.getRules', {
  query: { uris: [post.uri] },
})
const found = rules.data.rules ?? []
check(
  'getRules returns only the author rule, with content',
  found.length === 1 &&
    found[0].uri === rule.data.uri &&
    found[0].hasContent === true,
  JSON.stringify(found.map((r) => r.uri)),
)

// Eligibility
const asHolder = await getContent(holder, post.uri)
check(
  'holder with 50 USDC can read it',
  asHolder.ok && asHolder.data.text === secret,
  asHolder.data.error,
)
const asAuthor = await getContent(author, post.uri)
check('author can always read it', asAuthor.ok && asAuthor.data.text === secret)
const asPoor = await getContent(poor, post.uri)
check(
  'viewer with 1 USDC is refused (NotEligible, 403)',
  asPoor.status === 403 && asPoor.data.error === 'NotEligible',
  `${asPoor.status} ${asPoor.data.error}`,
)
const asNoWallet = await getContent(noWallet, post.uri)
check(
  'viewer without a linked wallet is refused',
  !asNoWallet.ok && asNoWallet.data.error === 'NotEligible',
  asNoWallet.data.error,
)
check(
  'refusals never leak the text',
  ![asPoor, asNoWallet].some((r) => JSON.stringify(r.data).includes('airdrop')),
)
await dealErc20(poorWallet.address, USDC, 20_000_000n) // now 20 USDC
const afterTopUp = await getContent(poor, post.uri)
check(
  'after topping up to 20 USDC the viewer can read it',
  afterTopUp.ok && afterTopUp.data.text === secret,
  afterTopUp.data.error,
)

// Gated images: uploaded to the gate, referenced from the gated content and
// served only through signed URLs handed to eligible viewers
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const upload = async (s, bytes, contentType) => {
  const res = await fetch(new URL('/xrpc/net.krao.gate.uploadMedia', GATE), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await serviceAuth(s, 'net.krao.gate.uploadMedia')}`,
      'content-type': contentType,
    },
    body: bytes,
  })
  return { ok: res.ok, status: res.status, data: await res.json() }
}
const uploaded = await upload(author, png, 'image/png')
check(
  'the author can upload a gated image',
  uploaded.ok && uploaded.data.media?.mimeType === 'image/png',
  JSON.stringify(uploaded.data),
)
const notImage = await upload(author, Buffer.from('<script>'), 'image/png')
check(
  'uploads must really be images',
  notImage.status === 400,
  `${notImage.status} ${notImage.data.message}`,
)
const putMedia = await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(author, 'net.krao.gate.putContent'),
  body: {
    uri: post.uri,
    text: secret,
    media: [
      { url: uploaded.data.media.url, mimeType: 'image/png', alt: 'chart' },
    ],
  },
})
check('gated content can carry the image', putMedia.ok, putMedia.data.message)

const withMedia = await getContent(holder, post.uri)
const mediaUrl = withMedia.data.media?.[0]?.url
const image = mediaUrl ? await fetch(mediaUrl) : null
const imageBytes = image ? Buffer.from(await image.arrayBuffer()) : null
check(
  'an eligible viewer gets a working image URL',
  image?.ok &&
    image.headers.get('content-type') === 'image/png' &&
    imageBytes.equals(png) &&
    withMedia.data.media[0].alt === 'chart',
  mediaUrl,
)
const tampered = mediaUrl
  ? await fetch(mediaUrl.replace(/sig=[^&]+/, 'sig=forged'))
  : null
const unsigned = mediaUrl ? await fetch(mediaUrl.split('?')[0]) : null
check(
  'image URLs without a valid signature are refused',
  tampered?.status === 403 && unsigned?.status === 403,
  `${tampered?.status} ${unsigned?.status}`,
)
// A (tiny, fake) MP4: gated video is stored and served the same way, with
// byte ranges so players can seek
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypmp42'),
  Buffer.alloc(64, 7),
])
const video = await upload(author, mp4, 'video/mp4')
check(
  'the author can upload a gated video',
  video.ok && video.data.media?.mimeType === 'video/mp4',
  JSON.stringify(video.data),
)
const putVideo = await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(author, 'net.krao.gate.putContent'),
  body: {
    uri: post.uri,
    text: secret,
    media: [
      { url: uploaded.data.media.url, mimeType: 'image/png', alt: 'chart' },
      { url: video.data.media.url, mimeType: 'video/mp4' },
    ],
  },
})
const withVideo = await getContent(holder, post.uri)
const videoUrl = withVideo.data.media?.find(
  (m) => m.mimeType === 'video/mp4',
)?.url
const part = videoUrl
  ? await fetch(videoUrl, { headers: { range: 'bytes=4-11' } })
  : null
const partBytes = part ? Buffer.from(await part.arrayBuffer()) : null
check(
  'gated video is served in byte ranges',
  putVideo.ok &&
    part?.status === 206 &&
    part.headers.get('content-range') === `bytes 4-11/${mp4.length}` &&
    partBytes.toString() === 'ftypmp42',
  `${part?.status} ${part?.headers.get('content-range')}`,
)

const holderPost = (
  await createRecord(holder, 'app.bsky.feed.post', {
    text: 'Bài của holder',
    createdAt: new Date().toISOString(),
  })
).data
const stolen = await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(holder, 'net.krao.gate.putContent'),
  body: {
    uri: holderPost.uri,
    media: [{ url: uploaded.data.media.url, mimeType: 'image/png' }],
  },
})
check(
  "nobody can reuse another account's gated image",
  stolen.status === 400,
  `${stolen.status} ${stolen.data.message}`,
)

// Service auth
const noAuth = await xrpc(GATE, 'net.krao.gate.getContent', {
  query: { uri: post.uri },
})
check(
  'request without service auth is rejected (401)',
  noAuth.status === 401,
  String(noAuth.status),
)
const wrongAud = await xrpc(GATE, 'net.krao.gate.getContent', {
  token: await serviceAuth(
    holder,
    'net.krao.gate.getContent',
    'did:web:evil.example',
  ),
  query: { uri: post.uri },
})
check(
  'token for another service is rejected',
  !wrongAud.ok,
  `${wrongAud.status} ${wrongAud.data.error}`,
)
const wrongLxm = await xrpc(GATE, 'net.krao.gate.getContent', {
  token: await serviceAuth(holder, 'net.krao.gate.putContent'),
  query: { uri: post.uri },
})
check(
  'token for another method is rejected',
  !wrongLxm.ok,
  `${wrongLxm.status} ${wrongLxm.data.error}`,
)

// The gated text must not be anywhere in the author's public repo
const repoUrl = new URL('/xrpc/com.atproto.sync.getRepo', PDS)
repoUrl.searchParams.set('did', author.did)
const car = Buffer.from(await (await fetch(repoUrl)).arrayBuffer())
check(
  'gated text is not in the public repo (CAR export)',
  car.length > 0 && !car.includes(secret) && !car.includes('airdrop snapshot'),
  `${car.length} bytes`,
)
check(
  'the gated image and video are not in the public repo either',
  !car.includes(png) && !car.includes(mp4),
)

// Leave a gated post for manual testing, with the poor wallet back at 1 USDC
await dealErc20(poorWallet.address, USDC, 1_000_000n)
console.log('      gated post:', post.uri)
done()
