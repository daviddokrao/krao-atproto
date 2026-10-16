// Growth (M32): points for the first verified wallet and the first post
// (once per account), the opt-in weekly leaderboard, verified Basenames next
// to the handle (reverse and forward records on the Anvil Base fork), and
// the "Tiếng Việt" feed. Needs the dev-env (rewards-admin.test), the seed
// script's data and the Anvil fork.
import { keccak256 } from '@krao/wallet'
import {
  ACCOUNTS,
  INDEXER,
  PDS,
  REWARDS,
  SIGNUP_CODE,
  checker,
  createRecord,
  deleteRecord,
  linkWallet,
  login,
  pad32,
  putRecord,
  rewardsCall,
  rpc,
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

done()
