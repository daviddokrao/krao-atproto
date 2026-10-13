// Krao's "latest" feed: the indexer is the feed generator, the AppView
// serves it like any other custom feed.
import {
  ACCOUNTS,
  APPVIEW,
  INDEXER,
  checker,
  createRecord,
  deleteRecord,
  login,
  putRecord,
  sleep,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const krao = await login(ACCOUNTS.krao)
const minh = await login(ACCOUNTS.minh)

const desc = await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')
check('indexer describes itself as a feed generator', desc.ok, desc.data.error)
const feedUri = `at://${krao.did}/app.bsky.feed.generator/latest`
// Normally published by scripts/seed-local.mjs; make sure it exists
await putRecord(krao, 'app.bsky.feed.generator', 'latest', {
  did: desc.data.did,
  displayName: 'Mới nhất',
  createdAt: new Date().toISOString(),
})

const post = (
  await createRecord(minh, 'app.bsky.feed.post', {
    text: `Feed check ${Date.now()}`,
    createdAt: new Date().toISOString(),
  })
).data
const ref = { uri: post.uri, cid: post.cid }
const reply = (
  await createRecord(krao, 'app.bsky.feed.post', {
    text: 'A reply stays out of the feed',
    reply: { root: ref, parent: ref },
    createdAt: new Date().toISOString(),
  })
).data
await sleep(2500)

const described = await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')
check(
  'the published feed is listed',
  described.data.feeds?.some((f) => f.uri === feedUri),
  JSON.stringify(described.data.feeds),
)

const skeleton = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: feedUri, limit: 10 },
})
const uris = skeleton.data.feed?.map((item) => item.post) ?? []
check('skeleton starts with the newest post', uris[0] === post.uri, uris[0])
check('replies are left out', !uris.includes(reply.uri))

const unknown = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: `at://${minh.did}/app.bsky.feed.generator/other` },
})
check(
  'an unpublished feed is refused',
  unknown.data.error === 'UnknownFeed',
  unknown.data.error,
)

const page = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: feedUri, limit: 1 },
})
const next = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: feedUri, limit: 1, cursor: page.data.cursor },
})
check(
  'the cursor pages to older posts',
  !!page.data.cursor && next.data.feed?.[0]?.post !== page.data.feed[0].post,
)

// The AppView hydrates the feed from the generator's skeleton
let appviewFeed
for (let i = 0; i < 10; i++) {
  appviewFeed = await xrpc(APPVIEW, 'app.bsky.feed.getFeed', {
    query: { feed: feedUri, limit: 10 },
  })
  if (appviewFeed.data.feed?.[0]?.post?.uri === post.uri) break
  await sleep(1000)
}
check(
  'the AppView serves the feed with the new post',
  appviewFeed.data.feed?.[0]?.post?.uri === post.uri,
  appviewFeed.data.error ?? appviewFeed.data.feed?.[0]?.post?.uri,
)

await deleteRecord(minh, post.uri)
await deleteRecord(krao, reply.uri)
await sleep(2500)
const afterDelete = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: feedUri, limit: 10 },
})
check(
  'a deleted post leaves the feed',
  !afterDelete.data.feed?.some((item) => item.post === post.uri),
)
done()
