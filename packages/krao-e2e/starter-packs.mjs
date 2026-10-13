// Starter pack sharing from the indexer: short links (replacing go.bsky.app)
// and share cards (replacing ogcard.cdn.bsky.app).
import {
  ACCOUNTS,
  INDEXER,
  checker,
  createRecord,
  deleteRecord,
  login,
  sleep,
} from './lib.mjs'

const { check, done } = checker()
const shorten = (path) =>
  fetch(`${INDEXER}/s/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  })

const path = `/starter-pack/krao.test/e2e${Date.now()}`
const first = await (await shorten(path)).json()
const again = await (await shorten(path)).json()
check(
  'a path gets a short link on the indexer',
  first.url?.startsWith(`${INDEXER}/s/`),
  first.url,
)
check('the same path keeps its code', again.url === first.url)

const asJson = await fetch(first.url, {
  headers: { accept: 'application/json' },
})
const resolved = await asJson.json()
check(
  'apps resolve it to the web page as JSON',
  resolved.url?.endsWith(path),
  resolved.url,
)
const asBrowser = await fetch(first.url, {
  redirect: 'manual',
  headers: { accept: 'text/html' },
})
check(
  'browsers are redirected to the web page',
  asBrowser.status === 302 && asBrowser.headers.get('location')?.endsWith(path),
  `${asBrowser.status} ${asBrowser.headers.get('location')}`,
)
for (const bad of ['//evil.example/x', 'https://evil.example/', '']) {
  const res = await shorten(bad)
  check(`"${bad}" cannot be shortened`, res.status === 400, String(res.status))
}

// Share card for a real starter pack
const krao = await login(ACCOUNTS.krao)
const list = (
  await createRecord(krao, 'app.bsky.graph.list', {
    purpose: 'app.bsky.graph.defs#referencelist',
    name: 'E2E pack',
    createdAt: new Date().toISOString(),
  })
).data
const pack = (
  await createRecord(krao, 'app.bsky.graph.starterpack', {
    name: 'Builder Web3 Việt Nam',
    description: 'Những người đang xây trên Base',
    list: list.uri,
    createdAt: new Date().toISOString(),
  })
).data
const rkey = pack.uri.split('/').pop()
let card
for (let i = 0; i < 10; i++) {
  await sleep(1000)
  card = await fetch(`${INDEXER}/ogcard/start/${krao.did}/${rkey}`)
  if (card.ok) break
}
const png = Buffer.from(await card.arrayBuffer())
check(
  'the share card is a 1200×630 PNG',
  card.headers.get('content-type') === 'image/png' &&
    png.readUInt32BE(16) === 1200 &&
    png.readUInt32BE(20) === 630,
  `${card.status} ${card.headers.get('content-type')}`,
)
const missing = await fetch(`${INDEXER}/ogcard/start/${krao.did}/nope`)
check('an unknown starter pack has no card', missing.status === 404)

await deleteRecord(krao, pack.uri)
await deleteRecord(krao, list.uri)
done()
