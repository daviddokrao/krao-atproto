// GIF media relay and search, replacing gifs.bsky.app. Needs outbound
// internet access; search needs KRAO_KLIPY_API_KEY on the indexer.
import { INDEXER, checker } from './lib.mjs'

const { check, done } = checker()

const missing = await fetch(`${INDEXER}/gifs/t/krao-e2e-missing/x.gif`)
check(
  'media requests are relayed to Tenor',
  missing.status === 404,
  String(missing.status),
)

for (const path of ['//example.com/x.gif', '/%2F%2Fexample.com/x.gif']) {
  const res = await fetch(`${INDEXER}/gifs/t/${path}`)
  check(
    `the relay cannot be pointed at another host (${path})`,
    res.status === 400 || res.status === 404,
    String(res.status),
  )
}

const search = await fetch(`${INDEXER}/klipy/v2/search?q=cat&limit=1`)
if (search.status === 503) {
  check(
    'GIF search reports it is unavailable without an API key',
    (await search.json()).error === 'GifSearchUnavailable',
  )
} else {
  const body = await search.json()
  check(
    'GIF search returns results with the API key',
    search.ok && Array.isArray(body.results),
    String(search.status),
  )
}

const unknown = await fetch(`${INDEXER}/klipy/v2/categories`)
check(
  'only the GIF search methods are forwarded',
  unknown.status === 404 || unknown.status === 503,
  String(unknown.status),
)
done()
