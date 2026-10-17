// M29: polls. One vote per account, verified-only polls (phone or KYC with
// Krao), token-weighted polls on balances at a snapshot block (Anvil Base
// fork), deadlines and hidden results.
import {
  ACCOUNTS,
  INDEXER,
  PDS,
  SIGNUP_CODE,
  USDC,
  USDC_ASSET,
  checker,
  createRecord,
  dealErc20,
  linkWallet,
  login,
  rpc,
  serviceAuth,
  sleep,
  wallet,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)
const now = () => new Date().toISOString()
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString()

/** A fresh account: no phone, so not verified with Krao */
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

/** A post with a poll next to it (same record key) */
async function pollPost(session, text, poll) {
  const post = (
    await createRecord(session, 'app.bsky.feed.post', {
      text,
      createdAt: now(),
    })
  ).data
  const rkey = post.uri.split('/').pop()
  const res = await createRecord(
    session,
    'net.krao.poll.poll',
    {
      post: { uri: post.uri, cid: post.cid },
      createdAt: now(),
      ...poll,
    },
    { rkey },
  )
  return { post, poll: res }
}

const vote = (session, poll, option) =>
  createRecord(session, 'net.krao.poll.vote', {
    poll: { uri: poll.data.uri, cid: poll.data.cid },
    option,
    createdAt: now(),
  })

const results = async (poll, session) => {
  const method = 'net.krao.poll.getResults'
  return (
    await xrpc(INDEXER, method, {
      token: session ? await serviceAuth(session, method) : undefined,
      query: { uri: poll.data.uri },
    })
  ).data.poll
}

const author = await login(ACCOUNTS.krao)
const minh = await login(ACCOUNTS.minh)
const mai = await login(ACCOUNTS.mai)
const fresh = await signUp('pollnew')

// 1. One account, one vote
const a = await pollPost(author, `Thứ 6 đi cà phê? ${stamp}`, {
  question: 'Thứ 6 đi cà phê?',
  options: ['Có', 'Không', 'Để sau'],
  endsAt: inSeconds(3600),
  mode: 'account',
})
check('poll record accepted', a.poll.ok, a.poll.data.message)
const tooMany = await createRecord(author, 'net.krao.poll.poll', {
  post: { uri: a.post.uri, cid: a.post.cid },
  options: ['1', '2', '3', '4', '5'],
  endsAt: inSeconds(3600),
  mode: 'account',
  createdAt: now(),
})
check('a poll with 5 options is refused by the PDS', !tooMany.ok)
const badOption = await vote(minh, a.poll, 4)
check('a vote for option 4 is refused by the PDS', !badOption.ok)
await sleep(1500)
const minhVote = await vote(minh, a.poll, 0)
await sleep(300)
await vote(minh, a.poll, 1)
await vote(mai, a.poll, 1)
await vote(fresh, a.poll, 0)
await sleep(2000)
let r = await results(a.poll, minh)
check(
  'results count one vote per account',
  r?.options?.map((o) => o.votes).join() === '2,1,0' && r.totalVotes === 3,
  JSON.stringify(r?.options),
)
check(
  'the voter sees the vote that counted',
  r?.viewer?.uri === minhVote.data.uri &&
    r.viewer.option === 0 &&
    r.viewer.status === 'counted',
  JSON.stringify(r?.viewer),
)
const anon = await results(a.poll)
check('results without auth have no viewer', anon && !anon.viewer)
const polls = await xrpc(INDEXER, 'net.krao.poll.getPolls', {
  query: { posts: [a.post.uri, `at://${author.did}/app.bsky.feed.post/none`] },
})
check(
  'getPolls finds the poll of a post',
  polls.data.polls?.length === 1 && polls.data.polls[0].uri === a.poll.data.uri,
  JSON.stringify(polls.data).slice(0, 200),
)

// 2. Verified accounts only
const v = await pollPost(author, `Chỉ người đã xác thực ${stamp}`, {
  options: ['A', 'B'],
  endsAt: inSeconds(3600),
  mode: 'verified',
})
await sleep(1500)
await vote(minh, v.poll, 0)
await vote(fresh, v.poll, 1)
await sleep(2000)
r = await results(v.poll, fresh)
check(
  'verified poll: only the verified account counts',
  r?.options?.map((o) => o.votes).join() === '1,0',
  JSON.stringify(r?.options),
)
check(
  'the unverified voter is told why',
  r?.viewer?.status === 'ignored' && r.viewer.reason === 'NotVerified',
  JSON.stringify(r?.viewer),
)

// 3. Deadline and results hidden until the end
const d = await pollPost(author, `Hết hạn nhanh ${stamp}`, {
  options: ['X', 'Y'],
  endsAt: inSeconds(8),
  mode: 'account',
  resultsVisibility: 'afterEnd',
})
await sleep(1500)
await vote(minh, d.poll, 1)
await sleep(1500)
r = await results(d.poll, minh)
check(
  'afterEnd results are hidden while the poll is open',
  r?.resultsVisible === false &&
    r.totalVotes === undefined &&
    r.options.every((o) => o.votes === undefined) &&
    r.viewer?.option === 1,
  JSON.stringify(r),
)
await sleep(7000)
await vote(mai, d.poll, 0)
await sleep(2000)
r = await results(d.poll, mai)
check(
  'after the end: results shown, late votes ignored',
  r?.ended === true &&
    r.resultsVisible === true &&
    r.options.map((o) => o.votes).join() === '0,1' &&
    r.viewer?.reason === 'AfterEnd',
  JSON.stringify(r),
)

// 4. Token-weighted: balances at the snapshot block, not after
const whale = await signUp('pollwhale')
const shrimp = await signUp('pollshrimp')
const whaleWallet = wallet()
const shrimpWallet = wallet()
await dealErc20(whaleWallet.address, USDC, 30_000_000n) // 30 USDC
await dealErc20(shrimpWallet.address, USDC, 5_000_000n) // 5 USDC
await linkWallet(whale, whaleWallet)
await linkWallet(shrimp, shrimpWallet)
await rpc('evm_mine', [])
const t = await pollPost(author, `Bỏ phiếu theo USDC ${stamp}`, {
  options: ['Đồng ý', 'Phản đối'],
  endsAt: inSeconds(3600),
  mode: 'token',
  asset: USDC_ASSET,
})
await sleep(2000)
const snapshot = (await results(t.poll))?.snapshotBlock
check('token poll has a snapshot block', !!snapshot, snapshot)
// Buying after the snapshot does not count
await rpc('evm_mine', [])
await dealErc20(shrimpWallet.address, USDC, 1_000_000_000n)
await rpc('evm_mine', [])
await vote(whale, t.poll, 0)
await vote(shrimp, t.poll, 1)
await sleep(2500)
r = await results(t.poll, shrimp)
check(
  'votes weigh the snapshot balances',
  r?.options?.map((o) => o.weight).join() === '30000000,5000000' &&
    r.totalWeight === '35000000',
  JSON.stringify(r?.options),
)
check(
  'the voter sees their weight',
  r?.viewer?.status === 'counted' && r.viewer.weight === '5000000',
  JSON.stringify(r?.viewer),
)
const badAsset = await pollPost(author, `Chain lạ ${stamp}`, {
  options: ['A', 'B'],
  endsAt: inSeconds(3600),
  mode: 'token',
  asset: 'eip155:1/slip44:60',
})
await sleep(1500)
const missing = await xrpc(INDEXER, 'net.krao.poll.getResults', {
  query: { uri: badAsset.poll.data.uri },
})
check(
  'a token poll on a chain Krao does not index is not indexed',
  missing.data.error === 'NotFound',
  missing.data.error,
)

done()
