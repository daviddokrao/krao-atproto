// Vietnamese search (M30): the AppView matches posts and accounts ignoring
// accents and đ ("tien ao" finds "tiền ảo"), each word of the query must
// appear, and the closer match ranks first.
import {
  APPVIEW,
  PDS,
  SIGNUP_CODE,
  checker,
  createRecord,
  putRecord,
  sleep,
  verifyPhone,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const stamp = `kraos${Date.now().toString(36).slice(-6)}`

/** Retries `fn` until it returns something truthy (the AppView indexes async) */
async function waitFor(fn, ms = 15_000) {
  const until = Date.now() + ms
  for (;;) {
    const result = await fn()
    if (result || Date.now() > until) return result
    await sleep(500)
  }
}

const searchPosts = (q, extra = {}) =>
  xrpc(APPVIEW, 'app.bsky.feed.searchPosts', { query: { q, ...extra } })
const uris = (res) => res?.data.posts?.map((p) => p.uri) ?? []

// A fresh account, so that `from:` keeps other posts out of the ranking
const handle = `dao${stamp.slice(-6)}.test`
const account = await xrpc(PDS, 'com.atproto.server.createAccount', {
  body: {
    handle,
    email: `${handle}@example.com`,
    password: 'krao-dev-pass',
    inviteCode: SIGNUP_CODE,
  },
})
if (!account.ok) throw new Error(`createAccount: ${account.data.message}`)
const session = account.data
await verifyPhone(session)

const post = (text) =>
  createRecord(session, 'app.bsky.feed.post', {
    text,
    createdAt: new Date().toISOString(),
  }).then((res) => res.data.uri)

const phrase = await post(`Thị trường tiền ảo hôm nay tăng mạnh ${stamp}`)
const apart = await post(`Ảo tưởng về đồng tiền ${stamp}`)
const other = await post(`Hôm nay trời đẹp ${stamp}`)
const from = `from:${handle}`

const found = await waitFor(async () => {
  const res = await searchPosts(`tien ao ${from}`)
  return uris(res).includes(phrase) && uris(res).includes(apart) ? res : null
})
check(
  '"tien ao" finds posts saying "tiền ảo"',
  !!found,
  JSON.stringify(uris(await searchPosts(`tien ao ${from}`))),
)
const ranked = uris(found)
check(
  'the phrase ranks above the same words apart (posted later)',
  ranked.indexOf(phrase) !== -1 &&
    ranked.indexOf(phrase) < ranked.indexOf(apart),
  JSON.stringify(ranked),
)
check('posts without the words are left out', !ranked.includes(other))

const accented = await searchPosts(`tiền ảo ${from}`)
check(
  'the accented query finds them too',
  uris(accented)[0] === phrase && uris(accented).includes(apart),
  JSON.stringify(uris(accented)),
)
const stroke = await searchPosts(`dong tien ${from}`)
check(
  '"dong" matches "đồng"',
  JSON.stringify(uris(stroke)) === JSON.stringify([apart]),
  JSON.stringify(uris(stroke)),
)
const everyone = await searchPosts(`tien ao ${stamp}`)
check(
  'without from: too',
  uris(everyone).includes(phrase) && uris(everyone).includes(apart),
  JSON.stringify(uris(everyone)),
)
const recent = await searchPosts('tien ao', { limit: 25 })
check(
  'a plain "tien ao" search has the new post on its first page',
  uris(recent).includes(phrase),
  `${uris(recent).length} results`,
)
const paged = await searchPosts(stamp, { limit: 2 })
const page2 = paged.data.cursor
  ? await searchPosts(stamp, { limit: 2, cursor: paged.data.cursor })
  : null
check(
  'ranked results page with a cursor',
  uris(paged).length === 2 &&
    uris(page2).length === 1 &&
    !uris(paged).includes(uris(page2)[0]),
  JSON.stringify({ first: uris(paged), next: uris(page2) }),
)

/*
 * Accounts: display names without accents
 */

const profile = await putRecord(session, 'app.bsky.actor.profile', 'self', {
  displayName: `Trần Thị Đào ${stamp}`,
})
check('profile saved', profile.ok, JSON.stringify(profile.data))

const actors = await waitFor(async () => {
  const res = await xrpc(APPVIEW, 'app.bsky.actor.searchActors', {
    query: { q: `tran thi dao ${stamp}` },
  })
  return res.data.actors?.some((a) => a.did === session.did) ? res : null
})
check('"tran thi dao" finds "Trần Thị Đào"', !!actors)
const typeahead = await xrpc(APPVIEW, 'app.bsky.actor.searchActorsTypeahead', {
  query: { q: `dao ${stamp}` },
})
check(
  'typeahead ignores accents too',
  typeahead.data.actors?.some((a) => a.did === session.did),
  JSON.stringify(typeahead.data),
)
const byHandle = await xrpc(APPVIEW, 'app.bsky.actor.searchActors', {
  query: { q: handle.slice(0, -5) },
})
check(
  'handles still match, best first',
  byHandle.data.actors?.[0]?.did === session.did,
  JSON.stringify(byHandle.data.actors?.map((a) => a.handle)),
)

done()
