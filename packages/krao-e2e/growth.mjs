// Growth (M32): points for the first verified wallet and the first post
// (once per account), the opt-in weekly leaderboard, verified Basenames next
// to the handle (reverse and forward records on the Anvil Base fork), and
// the "Tiếng Việt" feed. M33: the analytics funnel, retention and summary
// (as differences: the dev-env has seed data), points for active days in
// the first month (simulated with the dev routes) and for a first community,
// community and token holder feeds, and the on-chain profile tab. Needs the
// dev-env (rewards-admin.test), the seed script's data and the Anvil fork.
import { keccak256 } from '@krao/wallet'
import {
  ACCOUNTS,
  ETH_ASSET,
  GATE,
  GATE_DID,
  INDEXER,
  PDS,
  REWARDS,
  REWARDS_TOKEN,
  SIGNUP_CODE,
  USDC,
  checker,
  createRecord,
  dealErc20,
  deleteRecord,
  linkWallet,
  login,
  pad32,
  putRecord,
  rewardsCall,
  rpc,
  serviceAuth,
  sleep,
  verifyPhone,
  wallet,
  walletRecord,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)
const now = () => new Date().toISOString()

async function signUp(name) {
  const handle = `${name}${stamp}.test`
  const res = await xrpc(PDS, 'com.atproto.server.createAccount', {
    body: {
      handle,
      email: `${handle}@example.com`,
      password: 'krao-dev-pass',
      inviteCode: SIGNUP_CODE,
    },
  })
  if (!res.ok) throw new Error(`createAccount: ${res.data.message}`)
  return res.data
}

/** Polls `fn` until it returns something truthy, or gives up */
async function waitFor(fn, ms = 20_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value || Date.now() > until) return value
    await sleep(500)
  }
}

const entries = async (session) =>
  (
    await rewardsCall(session, 'net.krao.points.listEntries', {
      query: { limit: 100 },
    })
  ).data.entries ?? []
const byRule = (list, ruleId) => list.filter((e) => e.ruleId === ruleId)

const profileOf = async (did) =>
  (
    await xrpc(INDEXER, 'net.krao.actor.getChainProfiles', {
      query: { actors: did },
    })
  ).data.profiles?.[0]

/*
 * 1. First verified wallet and first post: points once per account
 */

const ana = await signUp('grow')
await verifyPhone(ana)
const anaWallet = wallet()
const link = await linkWallet(ana, anaWallet)
check('a new account links a first wallet', link.ok, link.data.message)
const walletPoints = await waitFor(async () =>
  byRule(await entries(ana), 'growth.wallet-linked').at(0),
)
check(
  'the first verified wallet earns points (pending until KYC)',
  walletPoints?.amount === 20 && walletPoints?.status === 'pending',
  JSON.stringify(walletPoints),
)

// Unlink, link again, and link another wallet: no more points
await deleteRecord(ana, link.data.uri)
const relink = await linkWallet(ana, anaWallet)
const second = await linkWallet(ana, wallet())
check('the wallet is linked again, and a second one', relink.ok && second.ok)
await waitFor(
  async () =>
    (await profileOf(ana.did))?.wallets?.filter((w) => w.status === 'verified')
      .length === 2,
)

const firstPost = await createRecord(ana, 'app.bsky.feed.post', {
  text: `Bài đầu tiên của mình trên Krao ${stamp}`,
  langs: ['vi'],
  createdAt: now(),
})
check('the account posts', firstPost.ok, firstPost.data.message)
const postPoints = await waitFor(async () =>
  byRule(await entries(ana), 'growth.first-post').at(0),
)
check(
  'the first post earns points',
  postPoints?.amount === 10,
  JSON.stringify(postPoints),
)
await deleteRecord(ana, firstPost.data.uri)
const repost = await createRecord(ana, 'app.bsky.feed.post', {
  text: `Đăng lại sau khi xoá ${stamp}`,
  createdAt: now(),
})
await createRecord(ana, 'app.bsky.feed.post', {
  text: `Thêm một bài nữa ${stamp}`,
  createdAt: now(),
})
// The latest feed shows the indexer got this far; give delivery a moment
const krao = await login(ACCOUNTS.krao, { phone: false })
await waitFor(async () => {
  const page = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
    query: {
      feed: `at://${krao.did}/app.bsky.feed.generator/latest`,
      limit: 20,
    },
  })
  return page.data.feed?.some((item) => item.post === repost.data.uri)
})
await sleep(2_000)
const after = await entries(ana)
check(
  'each is rewarded exactly once (unlink/relink, delete/repost)',
  byRule(after, 'growth.wallet-linked').length === 1 &&
    byRule(after, 'growth.first-post').length === 1,
  JSON.stringify(after.map((e) => e.ruleId)),
)

/*
 * 2. Weekly leaderboard: opt-in only, ranked among those who opted in
 */

const admin = await login(ACCOUNTS.rewardsAdmin, { phone: false })
const [lb1, lb2, lb3] = [
  await signUp('lbone'),
  await signUp('lbtwo'),
  await signUp('lbthree'),
]
// Above earlier runs this week: they gave out less, earlier
const top = 2 * Math.floor(Date.now() / 1000)
for (const [session, amount] of [
  [lb1, top],
  [lb2, top - 1],
  [lb3, top + 5],
]) {
  const res = await rewardsCall(admin, 'net.krao.rewards.admin.adjustPoints', {
    body: { did: session.did, amount, note: 'e2e leaderboard' },
  })
  check(`admin gives ${session.handle} points`, res.ok, res.data.message)
}
for (const session of [lb1, lb2]) {
  const res = await rewardsCall(
    session,
    'net.krao.points.setLeaderboardOptIn',
    { body: { optIn: true } },
  )
  check(`${session.handle} opts in`, res.ok && res.data.optIn === true)
}
const board = await xrpc(REWARDS, 'net.krao.points.getLeaderboard', {
  query: { limit: 50 },
})
const listed = board.data.entries ?? []
check(
  'the leaderboard answers without auth, for this week',
  board.ok && !!board.data.period?.start && board.data.viewer === undefined,
  JSON.stringify(board.data.period),
)
check(
  'accounts that did not opt in are not listed',
  !listed.some((e) => e.did === lb3.did),
)
check(
  'opted-in accounts are ranked among themselves',
  listed[0]?.did === lb1.did &&
    listed[0]?.rank === 1 &&
    listed[0]?.points === top &&
    listed[1]?.did === lb2.did &&
    listed[1]?.rank === 2,
  JSON.stringify(listed.slice(0, 3)),
)
const asLb3 = await rewardsCall(lb3, 'net.krao.points.getLeaderboard')
check(
  'a viewer that did not opt in sees its points, no rank',
  asLb3.data.viewer?.optedIn === false &&
    asLb3.data.viewer?.points === top + 5 &&
    asLb3.data.viewer?.rank === undefined,
  JSON.stringify(asLb3.data.viewer),
)
await rewardsCall(lb1, 'net.krao.points.setLeaderboardOptIn', {
  body: { optIn: false },
})
const asLb2 = await rewardsCall(lb2, 'net.krao.points.getLeaderboard')
check(
  'opting out leaves the board; the next account moves up',
  !asLb2.data.entries?.some((e) => e.did === lb1.did) &&
    asLb2.data.viewer?.optedIn === true &&
    asLb2.data.viewer?.rank === 1,
  JSON.stringify(asLb2.data.viewer),
)
const exported = await rewardsCall(lb2, 'net.krao.account.exportData')
check(
  'the choice is in the data export',
  exported.data.data?.leaderboard?.optIn === true,
  JSON.stringify(exported.data.data?.leaderboard),
)

/*
 * 3. Verified Basename: the wallet's reverse record names it, and only
 * once the name resolves back to the wallet is it shown
 */

const REGISTRY = '0xb94704422c2a1e396835a571837aa5ae53285a95'
const L2_RESOLVER = '0xc6d566a56a1aff6508b41f6c90ff131615583bcd'
const L2_REVERSE = '0x0000000000d8e504002cc26e3ec46d81971c1664'
const NAME = 'jesse.base.eth'

function namehash(name) {
  let node = new Uint8Array(32)
  for (const label of name.split('.').reverse()) {
    const joined = new Uint8Array(64)
    joined.set(node, 0)
    joined.set(keccak256(new TextEncoder().encode(label)), 32)
    node = keccak256(joined)
  }
  return Buffer.from(node).toString('hex')
}
const NODE = namehash(NAME)

/** abi.encode(string) after a selector */
function stringCall(selector, value) {
  const bytes = Buffer.from(value, 'utf8')
  const padded = Buffer.concat([
    bytes,
    Buffer.alloc((32 - (bytes.length % 32)) % 32),
  ])
  return (
    selector +
    pad32('20') +
    pad32(bytes.length.toString(16)) +
    padded.toString('hex')
  )
}

/** A transaction from `from`, impersonated on Anvil (with gas money) */
async function sendAs(from, to, data) {
  await rpc('anvil_setBalance', [from, '0x56bc75e2d63100000'])
  await rpc('anvil_impersonateAccount', [from])
  await rpc('eth_sendTransaction', [{ from, to, data }])
  await rpc('anvil_stopImpersonatingAccount', [from])
}
const callWord = async (to, data) =>
  '0x' + (await rpc('eth_call', [{ to, data }, 'latest'])).slice(-40)

const bao = await signUp('basename')
const baoWallet = wallet()
const address = baoWallet.address.toLowerCase()
// Bao's wallet claims jesse.base.eth (anyone can set any reverse name)...
await sendAs(address, L2_REVERSE, stringCall('0xc47f0027', NAME))
const forwardBefore = await callWord(L2_RESOLVER, '0x3b3b57de' + NODE)
check(
  'on the fork, the name does not point at the wallet yet',
  forwardBefore !== address,
  forwardBefore,
)
const record = walletRecord(bao.did, baoWallet)
const baoLink = await createRecord(bao, 'net.krao.actor.wallet', record)
check('the wallet is linked', baoLink.ok, baoLink.data.message)
const rkey = baoLink.data.uri.split('/').pop()
await waitFor(async () =>
  (await profileOf(bao.did))?.wallets?.some((w) => w.status === 'verified'),
)
// Give the name check a few rounds: it must not accept the claim
const claimed = await waitFor(
  async () => (await profileOf(bao.did))?.primaryName,
  4_000,
)
check(
  'a reverse record alone is not enough (forward points elsewhere)',
  !claimed,
  JSON.stringify(claimed),
)

// ...then the name's owner points it at Bao's wallet
const owner = await callWord(REGISTRY, '0x02571be3' + NODE)
await sendAs(owner, L2_RESOLVER, '0xd5fa2b00' + NODE + pad32(address))
check(
  'the name now resolves to the wallet',
  (await callWord(L2_RESOLVER, '0x3b3b57de' + NODE)) === address,
)
// A change to the link makes the indexer check again (it also does daily)
await putRecord(bao, 'net.krao.actor.wallet', rkey, {
  ...record,
  label: 'Ví chính',
})
const verified = await waitFor(
  async () => (await profileOf(bao.did))?.primaryName,
)
check(
  'forward and reverse agree: the Basename is shown',
  verified?.name === NAME &&
    verified?.source === 'basename' &&
    verified?.address === address,
  JSON.stringify(verified),
)

// The owner may hide it
await putRecord(bao, 'net.krao.actor.wallet', rkey, {
  ...record,
  label: 'Ví chính',
  showPrimaryName: false,
})
const hidden = await waitFor(async () => {
  const profile = await profileOf(bao.did)
  return (
    profile?.wallets?.some((w) => w.showPrimaryName === false) &&
    !profile.primaryName &&
    profile
  )
})
check('showPrimaryName false hides it', !!hidden, JSON.stringify(hidden))

/*
 * 4. "Tiếng Việt" feed: Vietnamese posts, not English ones or unsafe links
 */

const desc = await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')
const viFeed = `at://${krao.did}/app.bsky.feed.generator/vietnamese`
if (!desc.data.feeds?.some((f) => f.uri === viFeed)) {
  // Normally published by scripts/seed-local.mjs
  await putRecord(krao, 'app.bsky.feed.generator', 'vietnamese', {
    did: desc.data.did,
    displayName: 'Tiếng Việt',
    description: 'Bài viết tiếng Việt mới nhất trên Krao.',
    createdAt: now(),
  })
}
const listedFeed = await waitFor(async () =>
  (await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')).data.feeds?.some(
    (f) => f.uri === viFeed,
  ),
)
check('the Tiếng Việt feed is published', !!listedFeed)

const linkPost = (text, url) => {
  const byteStart = Buffer.byteLength(text)
  return createRecord(ana, 'app.bsky.feed.post', {
    text: `${text}${url}`,
    facets: [
      {
        index: { byteStart, byteEnd: byteStart + Buffer.byteLength(url) },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
      },
    ],
    createdAt: now(),
  })
}
const viPost = await createRecord(ana, 'app.bsky.feed.post', {
  text: `Hôm nay thị trường tiền ảo khá yên ả, mọi người nghĩ sao? ${stamp}`,
  createdAt: now(),
})
const enPost = await createRecord(ana, 'app.bsky.feed.post', {
  text: `Good morning, the market looks calm today ${stamp}`,
  langs: ['en'],
  createdAt: now(),
})
const viTagged = await createRecord(ana, 'app.bsky.feed.post', {
  text: `gm gm ${stamp}`,
  langs: ['vi'],
  createdAt: now(),
})
const unsafePost = await linkPost(
  `Nhận quà miễn phí, kết nối ví tại đây ${stamp}: `,
  'https://drainer.test/claim',
)
check(
  'the posts are written',
  viPost.ok && enPost.ok && viTagged.ok && unsafePost.ok,
  viPost.data.message,
)

/** Every post of a feed, following cursors */
async function feedPosts(feed) {
  const posts = []
  let cursor
  for (let i = 0; i < 20; i++) {
    const page = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
      query: { feed, limit: 100, ...(cursor ? { cursor } : {}) },
    })
    posts.push(...(page.data.feed ?? []).map((item) => item.post))
    cursor = page.data.cursor
    if (!cursor) break
  }
  return posts
}
const viPosts = await waitFor(async () => {
  const posts = await feedPosts(viFeed)
  return posts.includes(viPost.data.uri) && posts
})
check('a Vietnamese post (detected from its text) is in the feed', !!viPosts)
check('an English post is not', !!viPosts && !viPosts.includes(enPost.data.uri))
check(
  'nor a Vietnamese post linking to a drainer',
  !!viPosts && !viPosts.includes(unsafePost.data.uri),
)
check(
  'a post tagged langs vi is in the feed whatever its text',
  !!viPosts && viPosts.includes(viTagged.data.uri),
)

/*
 * M33 helpers: the rewards service's internal routes (dev-env token), and
 * days in Vietnam's time
 */

const internal = (path, body) =>
  fetch(new URL(path, REWARDS), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${REWARDS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
const VN_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const vnDay = (ms) => new Date(ms + VN_MS).toISOString().slice(0, 10)
const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10)
/** The Monday (Vietnam time) of the week holding `ms` */
const weekOf = (ms) => {
  const day = vnDay(ms)
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
  return addDays(day, -dow)
}
const steps = (funnel) =>
  Object.fromEntries((funnel.steps ?? []).map((s) => [s.id, s.count]))
const analytics = async (method, query) =>
  (await rewardsCall(admin, `net.krao.analytics.${method}`, { query })).data
/** Moves the account's sign-up back; waits for the PDS to report it first */
const backdate = async (did, days) => {
  const at = await waitFor(async () => {
    const res = await internal('/internal/dev/backdate-account', {
      did,
      days: 0,
    })
    return res.ok && (await res.json()).createdAt
  })
  if (!at) return undefined
  const res = await internal('/internal/dev/backdate-account', { did, days })
  return res.ok ? (await res.json()).createdAt : undefined
}
const activeDay = (did, day) =>
  internal('/internal/events', { type: 'activity.day', did, day })

/*
 * 5. Analytics: the funnel and the summary count new accounts (admins only)
 */

const denied = await rewardsCall(ana, 'net.krao.analytics.getSummary')
check(
  'analytics are for rewards admins only',
  denied.status === 403,
  `${denied.status}`,
)
// Let deliveries from the sections above settle first
await sleep(3_000)
const funnelBefore = steps(await analytics('getFunnel'))
const summaryBefore = await analytics('getSummary')
check(
  'the funnel lists its five steps',
  Object.keys(funnelBefore).join() ===
    'registered,phoneVerified,kycApproved,walletLinked,firstTip',
  JSON.stringify(funnelBefore),
)
const fa = await signUp('funnela')
const fb = await signUp('funnelb')
await verifyPhone(fa)
await linkWallet(fa, wallet())
const kyc = await rewardsCall(admin, 'net.krao.rewards.admin.reviewKyc', {
  body: {
    did: fb.did,
    decision: 'approve',
    reasonCode: 'other',
    note: 'Analytics e2e',
  },
})
check('admin approves a KYC', kyc.ok, kyc.data.message)
const expected = {
  ...funnelBefore,
  registered: funnelBefore.registered + 2,
  phoneVerified: funnelBefore.phoneVerified + 1,
  kycApproved: funnelBefore.kycApproved + 1,
  walletLinked: funnelBefore.walletLinked + 1,
}
const funnelAfter = await waitFor(async () => {
  const now = steps(await analytics('getFunnel'))
  return now.walletLinked >= expected.walletLinked &&
    now.registered >= expected.registered
    ? now
    : undefined
})
check(
  'the funnel counts the new accounts at each step',
  JSON.stringify(funnelAfter) === JSON.stringify(expected),
  `${JSON.stringify(funnelBefore)} -> ${JSON.stringify(funnelAfter)}`,
)
const summaryAfter = await waitFor(async () => {
  const now = await analytics('getSummary')
  return now.accounts >= summaryBefore.accounts + 2 &&
    now.activeToday >= summaryBefore.activeToday + 1
    ? now
    : undefined
})
check(
  'the summary counts the accounts and today’s activity (a wallet link)',
  summaryAfter?.accounts === summaryBefore.accounts + 2 &&
    summaryAfter?.activeToday >= summaryBefore.activeToday + 1 &&
    summaryAfter?.active30d >= summaryAfter?.active7d &&
    summaryAfter?.active7d >= summaryAfter?.activeToday,
  `${JSON.stringify(summaryBefore)} -> ${JSON.stringify(summaryAfter)}`,
)

/*
 * 6. Active 20 of the first 30 days: +50 once (sign-ups moved 40 days back
 * with the dev route); 19 days earn nothing. Retention counts them.
 */

const retentionOf = async (week) =>
  (await analytics('getRetention', { weeks: 8 })).cohorts?.find(
    (c) => c.week === week,
  ) ?? { size: 0, d1: 0, d7: 0, d30: 0 }
const cohortWeek = weekOf(Date.now() - 40 * DAY_MS)
const retentionBefore = await retentionOf(cohortWeek)

const active20 = await signUp('activea')
const active19 = await signUp('activeb')
const created20 = await backdate(active20.did, 40)
const created19 = await backdate(active19.did, 40)
check(
  'the dev route moves sign-ups back 40 days',
  !!created20 &&
    !!created19 &&
    Date.now() - Date.parse(created20) > 39 * DAY_MS,
  created20,
)
const playDays = async (did, createdAt, count) => {
  const first = vnDay(Date.parse(createdAt))
  for (let i = 0; i < count; i++) {
    await activeDay(did, addDays(first, i))
  }
}
await playDays(active19.did, created19, 19)
await playDays(active20.did, created20, 20)
const activePoints = await waitFor(async () =>
  byRule(await entries(active20), 'growth.active-30d').at(0),
)
check(
  '20 active days of the first 30 earn points (pending until KYC)',
  activePoints?.amount === 50 && activePoints?.status === 'pending',
  JSON.stringify(activePoints),
)
check(
  '19 days earn nothing',
  byRule(await entries(active19), 'growth.active-30d').length === 0,
)
await playDays(active20.did, created20, 25)
check(
  'more days do not earn it again',
  byRule(await entries(active20), 'growth.active-30d').length === 1,
)
const retentionAfter = await retentionOf(cohortWeek)
check(
  'retention: the cohort of 40 days ago grows by 2, both active on day 1 and in days 6-8, none in days 28-32',
  retentionAfter.size === retentionBefore.size + 2 &&
    retentionAfter.d1 === (retentionBefore.d1 ?? 0) + 2 &&
    retentionAfter.d7 === (retentionBefore.d7 ?? 0) + 2 &&
    retentionAfter.d30 === (retentionBefore.d30 ?? 0),
  `${JSON.stringify(retentionBefore)} -> ${JSON.stringify(retentionAfter)}`,
)

/*
 * 7. A first community: +10 once, only into one with 3 other members
 */

const communityQuery = async (method, params, session) =>
  xrpc(INDEXER, method, {
    token: session ? await serviceAuth(session, method) : undefined,
    query: params,
  })
const newCommunity = async (session, slug, name) =>
  putRecord(session, 'net.krao.community.profile', slug, {
    name,
    access: { mode: 'open' },
    rules: [],
    createdAt: now(),
  })
const joinCommunity = (session, subject) =>
  createRecord(session, 'net.krao.community.membership', {
    subject,
    createdAt: now(),
  })

const cOwner = await signUp('cowner')
const bigSlug = `big-${stamp}`
const big = await newCommunity(cOwner, bigSlug, `Cộng đồng lớn ${stamp}`)
const small = await newCommunity(cOwner, `small-${stamp}`, `Nhỏ ${stamp}`)
check('the communities are created', big.ok && small.ok, big.data.message)
const early = [
  await signUp('cmone'),
  await signUp('cmtwo'),
  await signUp('cmthree'),
]
for (const session of early) await joinCommunity(session, big.data.uri)
const joiner = await signUp('joiner')
await joinCommunity(joiner, small.data.uri)
await waitFor(async () => {
  const res = await communityQuery(
    'net.krao.community.getCommunity',
    { uri: big.data.uri },
    joiner,
  )
  return res.data.community?.memberCount === 4
})
await sleep(2_000)
check(
  'joining a community with fewer than 3 other members earns nothing',
  byRule(await entries(joiner), 'growth.community-joined').length === 0,
)
await joinCommunity(joiner, big.data.uri)
const joinPoints = await waitFor(async () =>
  byRule(await entries(joiner), 'growth.community-joined').at(0),
)
check(
  'joining a community with 3 other members earns points',
  joinPoints?.amount === 10 && joinPoints?.status === 'pending',
  JSON.stringify(joinPoints),
)
const big2 = await newCommunity(cOwner, `big2-${stamp}`, `Lớn nữa ${stamp}`)
for (const session of early) await joinCommunity(session, big2.data.uri)
await joinCommunity(joiner, big2.data.uri)
await sleep(3_000)
check(
  'a second community earns nothing more',
  byRule(await entries(joiner), 'growth.community-joined').length === 1,
)

/*
 * 8. The community's feed generator: public posts only
 */

const feedGen = (await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator'))
  .data.did
const communityFeed = await putRecord(
  cOwner,
  'app.bsky.feed.generator',
  `community-${bigSlug}`,
  {
    did: feedGen,
    displayName: `Cộng đồng lớn ${stamp}`,
    createdAt: now(),
  },
)
check('the owner publishes the community feed', communityFeed.ok)
const withFeed = await waitFor(async () => {
  const res = await communityQuery('net.krao.community.getCommunity', {
    uri: big.data.uri,
  })
  return res.data.community?.feed && res.data
})
check(
  'getCommunity names the feed and the DID it must point at',
  withFeed?.community?.feed === communityFeed.data.uri &&
    withFeed?.feedGeneratorDid === feedGen,
  JSON.stringify(withFeed && { ...withFeed, community: undefined }),
)
const member = early[0]
await verifyPhone(member)
await verifyPhone(cOwner)
const postAndSubmit = async (session, text) => {
  const p = (
    await createRecord(session, 'app.bsky.feed.post', {
      text,
      createdAt: now(),
    })
  ).data
  await createRecord(session, 'net.krao.community.submission', {
    community: big.data.uri,
    post: { uri: p.uri, cid: p.cid },
    createdAt: now(),
  })
  return p
}
const publicPost = await postAndSubmit(member, `Bài công khai ${stamp}`)
const hiddenPost = await postAndSubmit(member, `Bài lạc đề ${stamp}`)
await createRecord(cOwner, 'net.krao.community.hide', {
  community: big.data.uri,
  post: hiddenPost.uri,
  createdAt: now(),
})
const gatedPost = await postAndSubmit(cOwner, '🔒 Bài cho thành viên')
await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(cOwner, 'net.krao.gate.putContent'),
  body: { uri: gatedPost.uri, text: `Chỉ thành viên ${stamp}` },
})
await createRecord(cOwner, 'net.krao.gate.rule', {
  subject: { uri: gatedPost.uri, cid: gatedPost.cid },
  conditions: [
    { $type: 'net.krao.gate.defs#communityMember', community: big.data.uri },
  ],
  service: GATE_DID,
  createdAt: now(),
})
const communityPosts = await waitFor(async () => {
  const members = (
    await communityQuery('net.krao.community.getFeed', {
      community: big.data.uri,
    })
  ).data.feed?.map((f) => f.post)
  // The members' feed has the gated post once its rule is indexed
  if (!members?.includes(gatedPost.uri)) return undefined
  const posts = await feedPosts(communityFeed.data.uri)
  return posts.includes(publicPost.uri) && posts
})
check('the community feed generator serves a public post', !!communityPosts)
check(
  'but not a post the owner hid, nor a members-only post',
  !!communityPosts &&
    !communityPosts.includes(hiddenPost.uri) &&
    !communityPosts.includes(gatedPost.uri),
  JSON.stringify(communityPosts),
)
const fake = await putRecord(
  early[1],
  'app.bsky.feed.generator',
  `community-${bigSlug}`,
  { did: feedGen, displayName: 'Giả mạo', createdAt: now() },
)
await waitFor(async () =>
  (await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')).data.feeds?.some(
    (f) => f.uri === fake.data.uri,
  ),
)
check(
  'a community feed published by someone else is empty',
  (await feedPosts(fake.data.uri)).length === 0,
)

/*
 * 9. "Holders of $USDC": posts of accounts whose wallets hold USDC
 */

const usdcFeed = `at://${krao.did}/app.bsky.feed.generator/holders-usdc`
const feeds = (await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')).data
  .feeds
if (!feeds?.some((f) => f.uri === usdcFeed)) {
  // Normally published by scripts/seed-local.mjs
  await putRecord(krao, 'app.bsky.feed.generator', 'holders-usdc', {
    did: feedGen,
    displayName: 'Người giữ $USDC',
    createdAt: now(),
  })
}
const holderUsdc = await waitFor(async () => {
  const token = (
    await xrpc(INDEXER, 'net.krao.token.getToken', {
      query: { symbol: 'usdc' },
    })
  ).data.token
  return token?.holderFeed && token
})
check(
  'the USDC token names its holders feed',
  !!holderUsdc?.holderFeed?.endsWith('/app.bsky.feed.generator/holders-usdc'),
  holderUsdc?.holderFeed,
)
const holder = await signUp('holder')
const notHolder = await signUp('notholder')
await verifyPhone(holder)
await verifyPhone(notHolder)
const holderWallet = wallet()
const notHolderWallet = wallet()
await linkWallet(holder, holderWallet)
await linkWallet(notHolder, notHolderWallet)
await dealErc20(holderWallet.address, USDC, 5_000_000n)
await dealErc20(notHolderWallet.address, USDC, 0n)
const holderPost = await createRecord(holder, 'app.bsky.feed.post', {
  text: `Mình giữ USDC ${stamp}`,
  createdAt: now(),
})
const notHolderPost = await createRecord(notHolder, 'app.bsky.feed.post', {
  text: `Mình không giữ gì ${stamp}`,
  createdAt: now(),
})
const holderPosts = await waitFor(async () => {
  const posts = await feedPosts(usdcFeed)
  return posts.includes(holderPost.data.uri) && posts
})
check('a USDC holder’s post is in the holders feed', !!holderPosts)
check(
  'an account without USDC is not',
  !!holderPosts && !holderPosts.includes(notHolderPost.data.uri),
)

/*
 * 10. The on-chain tab: an approved NFT collection, the NFT avatar, and
 * support without anonymous tips
 */

const BASENAMES = '0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a'
const HELLO_ID = BigInt(
  '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
)
const put = await xrpc(INDEXER, 'net.krao.nft.admin.putCollection', {
  token: await serviceAuth(admin, 'net.krao.nft.admin.putCollection'),
  body: { chain: 'eip155:8453', contract: BASENAMES },
})
check(
  'a safety admin approves the Basenames collection',
  put.ok && put.data.collection?.contract === BASENAMES,
  JSON.stringify(put.data),
)
const notAdmin = await xrpc(INDEXER, 'net.krao.nft.admin.putCollection', {
  token: await serviceAuth(ana, 'net.krao.nft.admin.putCollection'),
  body: { chain: 'eip155:8453', contract: BASENAMES },
})
check('others may not', notAdmin.status === 403, `${notAdmin.status}`)
const approved = await xrpc(INDEXER, 'net.krao.nft.listCollections')
check(
  'the collection is listed publicly',
  approved.data.collections?.some((c) => c.contract === BASENAMES),
)

const collector = await signUp('collector')
const collectorWallet = wallet()
await linkWallet(collector, collectorWallet)
// The NFT test token (hello.base.eth) moves to the collector's wallet
const helloOwner = (
  await xrpc(INDEXER, 'net.krao.actor.resolveNft', {
    query: {
      chain: 'eip155:8453',
      contract: BASENAMES,
      tokenId: HELLO_ID.toString(),
    },
  })
).data.owner
const collectorAddress = collectorWallet.address.toLowerCase()
if (helloOwner && helloOwner !== collectorAddress) {
  await sendAs(
    helloOwner,
    BASENAMES,
    '0x23b872dd' +
      pad32(helloOwner) +
      pad32(collectorAddress) +
      pad32(HELLO_ID.toString(16)),
  )
}
// The avatar is checked against linked wallets: link first
await waitFor(async () =>
  (await profileOf(collector.did))?.wallets?.some(
    (w) => w.status === 'verified',
  ),
)
await putRecord(collector, 'net.krao.actor.nftAvatar', 'self', {
  nft: {
    chain: 'eip155:8453',
    contract: BASENAMES,
    tokenId: HELLO_ID.toString(),
    standard: 'erc721',
  },
  wallet: collectorWallet.account,
  createdAt: now(),
})
const onchain = async (did) =>
  xrpc(INDEXER, 'net.krao.actor.getOnchainProfile', { query: { actor: did } })
const tab = await waitFor(async () => {
  const res = await onchain(collector.did)
  return res.data.nfts?.some((n) => n.isAvatar) && res.data
})
check(
  'the on-chain tab lists the owned wallet',
  tab?.wallets?.some((w) => w.address === collectorAddress),
  JSON.stringify(tab?.wallets),
)
const avatarNft = tab?.nfts?.find((n) => n.isAvatar)
check(
  'the e2e NFT is there, as the avatar, with an image through the indexer',
  avatarNft?.contract === BASENAMES &&
    avatarNft?.tokenId === HELLO_ID.toString() &&
    avatarNft?.image?.startsWith(`${INDEXER}/nft-image?`),
  JSON.stringify(tab?.nfts),
)

// Tips from the collector: one public, one anonymous
const fan = await signUp('fan')
const fanWallet = wallet()
await linkWallet(fan, fanWallet)
await waitFor(async () =>
  (await profileOf(fan.did))?.wallets?.some((w) => w.status === 'verified'),
)
const sendEth = async (amount) => {
  await rpc('anvil_setBalance', [collectorAddress, '0x56bc75e2d63100000'])
  await rpc('anvil_impersonateAccount', [collectorAddress])
  const hash = await rpc('eth_sendTransaction', [
    {
      from: collectorAddress,
      to: fanWallet.address,
      value: '0x' + amount.toString(16),
    },
  ])
  await rpc('anvil_stopImpersonatingAccount', [collectorAddress])
  return hash
}
const tipRecord = async (amount, anonymous) =>
  createRecord(collector, 'net.krao.feed.tip', {
    recipient: fan.did,
    asset: ETH_ASSET,
    amount: amount.toString(),
    txHash: await sendEth(amount),
    from: collectorWallet.account,
    to: fanWallet.account,
    ...(anonymous ? { anonymous: true } : {}),
    createdAt: now(),
  })
const publicTip = await tipRecord(10n ** 15n, false)
const anonymousTip = await tipRecord(2n * 10n ** 15n, true)
check('the tips are written', publicTip.ok && anonymousTip.ok)
await waitFor(async () => {
  const tips = (
    await xrpc(INDEXER, 'net.krao.feed.getTips', {
      query: { recipient: fan.did },
    })
  ).data.tips
  return tips?.filter((t) => t.status === 'verified').length === 2 && tips
}, 30_000)
const support = (await onchain(collector.did)).data.support
check(
  'support counts the public tip only',
  support?.tipsSent === 1,
  JSON.stringify(support),
)
const sentHistory = (
  await xrpc(INDEXER, 'net.krao.actor.getSupportHistory', {
    query: { actor: collector.did, direction: 'sent' },
  })
).data.items
const receivedHistory = (
  await xrpc(INDEXER, 'net.krao.actor.getSupportHistory', {
    query: { actor: fan.did, direction: 'received' },
  })
).data.items
check(
  'the support history has the public tip, never the anonymous one',
  sentHistory?.some((i) => i.uri === publicTip.data.uri) &&
    !sentHistory?.some((i) => i.uri === anonymousTip.data.uri) &&
    receivedHistory?.some((i) => i.uri === publicTip.data.uri) &&
    !receivedHistory?.some((i) => i.uri === anonymousTip.data.uri),
  JSON.stringify(sentHistory),
)
check(
  'history items carry the asset and amount',
  sentHistory?.[0]?.asset?.symbol === 'ETH' &&
    sentHistory?.[0]?.amount === (10n ** 15n).toString(),
  JSON.stringify(sentHistory?.[0]),
)
const funnelTips = await waitFor(async () => {
  const now = steps(await analytics('getFunnel'))
  return now.firstTip > funnelBefore.firstTip && now
})
check(
  'the first verified tip shows in the funnel',
  !!funnelTips,
  `${funnelBefore.firstTip} -> ${funnelTips?.firstTip}`,
)
const missing = await onchain('did:plc:doesnotexist0000000000')
check(
  'an unknown account has an empty tab (no wallets, nothing held)',
  missing.ok && missing.data.wallets?.length === 0,
  JSON.stringify(missing.data),
)

done()
