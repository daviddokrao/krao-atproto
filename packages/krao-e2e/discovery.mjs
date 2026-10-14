// Discovery on Krao's own network: the indexer answers the AppView's
// suggestion and topic agents (suggested accounts and feeds, trending
// hashtags), and the AppView hydrates the results.
import {
  ACCOUNTS,
  APPVIEW,
  INDEXER,
  PDS,
  checker,
  createRecord,
  deleteRecord,
  login,
  sleep,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const krao = await login(ACCOUNTS.krao)
const minh = await login(ACCOUNTS.minh)

/** A post whose text ends with `#tag`, with the matching tag facet */
function tagPost(tag) {
  const prefix = 'Thử trending '
  const start = Buffer.byteLength(prefix)
  const text = `${prefix}#${tag}`
  return {
    text,
    facets: [
      {
        index: { byteStart: start, byteEnd: Buffer.byteLength(text) },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
      },
    ],
    createdAt: new Date().toISOString(),
  }
}

const tag = `kraoe2e${Date.now().toString(36)}`
const posts = [
  (await createRecord(krao, 'app.bsky.feed.post', tagPost(tag))).data,
  (await createRecord(minh, 'app.bsky.feed.post', tagPost(tag))).data,
]
await sleep(2500)

const topics = await xrpc(APPVIEW, 'app.bsky.unspecced.getTrendingTopics', {
  query: { limit: 25 },
})
check(
  'trending topics list a hashtag Krao accounts are using',
  topics.data.topics?.some(
    (t) => t.topic === `#${tag}` && t.link === `/hashtag/${tag}`,
  ),
  topics.data.error ?? JSON.stringify(topics.data.topics?.slice(0, 3)),
)

const trends = await xrpc(APPVIEW, 'app.bsky.unspecced.getTrends', {
  query: { limit: 25 },
})
const trend = trends.data.trends?.find((t) => t.topic === tag)
check(
  'trends count the posts and show who is posting',
  trend?.postCount === 2 && trend.actors?.length === 2,
  trends.data.error ?? JSON.stringify(trend),
)

const skeleton = await xrpc(
  INDEXER,
  'app.bsky.unspecced.getSuggestedUsersSkeleton',
  { query: { viewer: krao.did, limit: 50 } },
)
const kraoFollows = await xrpc(APPVIEW, 'app.bsky.graph.getFollows', {
  query: { actor: krao.did, limit: 100 },
})
const followed = new Set(kraoFollows.data.follows?.map((f) => f.did))
check(
  'suggested accounts leave out the viewer and who they follow',
  skeleton.data.dids?.length > 0 &&
    !skeleton.data.dids.includes(krao.did) &&
    skeleton.data.dids.every((did) => !followed.has(did)),
  JSON.stringify(skeleton.data),
)

const users = await xrpc(APPVIEW, 'app.bsky.unspecced.getSuggestedUsers', {
  query: { limit: 10 },
})
check(
  'the AppView serves suggested users',
  users.ok && users.data.actors?.length > 0,
  users.data.error ?? users.data.message,
)

const explore = await xrpc(
  APPVIEW,
  'app.bsky.unspecced.getSuggestedUsersForExplore',
  { query: { limit: 10 } },
)
check(
  'the Explore page gets suggested users',
  explore.ok && explore.data.actors?.length > 0,
  explore.data.error ?? explore.data.message,
)

const suggestions = await xrpc(PDS, 'app.bsky.actor.getSuggestions', {
  token: minh.accessJwt,
  query: { limit: 10 },
})
check(
  'signed-in suggestions never include yourself',
  suggestions.ok && !suggestions.data.actors?.some((a) => a.did === minh.did),
  suggestions.data.error ?? suggestions.data.message,
)

const feeds = await xrpc(APPVIEW, 'app.bsky.unspecced.getSuggestedFeeds', {
  query: { limit: 10 },
})
check(
  'suggested feeds are Krao feeds',
  feeds.ok &&
    feeds.data.feeds?.length > 0 &&
    feeds.data.feeds.every((f) => f.creator.did === krao.did),
  feeds.data.error ?? feeds.data.message,
)

const list = (
  await createRecord(krao, 'app.bsky.graph.list', {
    purpose: 'app.bsky.graph.defs#referencelist',
    name: 'Krao web3 builders',
    createdAt: new Date().toISOString(),
  })
).data
const pack = (
  await createRecord(krao, 'app.bsky.graph.starterpack', {
    name: `Krao builders ${tag}`,
    list: list.uri,
    createdAt: new Date().toISOString(),
  })
).data
await sleep(2500)
const packs = await xrpc(
  APPVIEW,
  'app.bsky.unspecced.getSuggestedStarterPacks',
  {
    query: { limit: 10 },
  },
)
check(
  'new Krao starter packs are suggested',
  packs.ok && packs.data.starterPacks?.some((p) => p.uri === pack.uri),
  packs.data.error ?? packs.data.message,
)
await deleteRecord(krao, pack.uri)
await deleteRecord(krao, list.uri)

for (const post of posts) {
  await deleteRecord(post.uri.includes(krao.did) ? krao : minh, post.uri)
}
await sleep(2500)
const after = await xrpc(APPVIEW, 'app.bsky.unspecced.getTrendingTopics', {
  query: { limit: 25 },
})
check(
  'deleted posts leave the trending topics',
  !after.data.topics?.some((t) => t.topic === `#${tag}`),
)
done()
