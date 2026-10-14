// Krao's "latest" and "popular" feeds: the indexer is the feed generator,
// the AppView serves them like any other custom feed.
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

// "popular" ranks by likes and reposts, decayed by age
const popularUri = `at://${krao.did}/app.bsky.feed.generator/popular`
await putRecord(krao, 'app.bsky.feed.generator', 'popular', {
  did: desc.data.did,
  displayName: 'Nổi bật',
  createdAt: new Date().toISOString(),
})
const liked = (
  await createRecord(krao, 'app.bsky.feed.post', {
    text: `Popular check ${Date.now()}`,
    createdAt: new Date().toISOString(),
  })
).data
const likedRef = { uri: liked.uri, cid: liked.cid }
const interactions = [
  await createRecord(minh, 'app.bsky.feed.like', {
    subject: likedRef,
    createdAt: new Date().toISOString(),
  }),
  await createRecord(minh, 'app.bsky.feed.repost', {
    subject: likedRef,
    createdAt: new Date().toISOString(),
  }),
]
// Newer than `liked`, but nobody interacted with it
const plain = (
  await createRecord(minh, 'app.bsky.feed.post', {
    text: `Plain check ${Date.now()}`,
    createdAt: new Date().toISOString(),
  })
).data
await sleep(2500)
const popular = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: popularUri, limit: 50 },
})
const ranked = popular.data.feed?.map((item) => item.post) ?? []
check(
  'popular ranks a liked and reposted post above a newer plain one',
  ranked.includes(plain.uri) &&
    ranked.indexOf(liked.uri) !== -1 &&
    ranked.indexOf(liked.uri) < ranked.indexOf(plain.uri),
  `${ranked.indexOf(liked.uri)} vs ${ranked.indexOf(plain.uri)}`,
)
const popularPage = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: popularUri, limit: 1 },
})
const popularNext = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: popularUri, limit: 1, cursor: popularPage.data.cursor },
})
check(
  'the popular cursor pages on',
  popularPage.data.cursor === '1' &&
    popularNext.data.feed?.[0]?.post === ranked[1],
)

for (const created of interactions) await deleteRecord(minh, created.data.uri)
await sleep(2500)
const unliked = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
  query: { feed: popularUri, limit: 50 },
})
const reranked = unliked.data.feed?.map((item) => item.post) ?? []
check(
  'removing the like and repost drops the post back',
  reranked.indexOf(plain.uri) < reranked.indexOf(liked.uri),
)
await deleteRecord(krao, liked.uri)
await deleteRecord(minh, plain.uri)

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
