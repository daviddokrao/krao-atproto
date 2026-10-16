// M29: Krao communities. A community gated by an NFT (hello.base.eth on the
// Base fork), members joining, member-only posts through the gate service,
// the community feed, moderators hiding posts, approvals and bans.
import {
  ACCOUNTS,
  GATE,
  GATE_DID,
  INDEXER,
  checker,
  createRecord,
  deleteRecord,
  linkWallet,
  login,
  pad32,
  putRecord,
  rpc,
  serviceAuth,
  sleep,
  wallet,
  xrpc,
} from './lib.mjs'

const BASENAMES = '0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a'
const HELLO_ID = BigInt(
  '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
)
const CHAIN = 'eip155:8453'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)
const now = () => new Date().toISOString()

/** A community query as `session` (service auth to the indexer), or anonymous */
const query = async (method, params, session) =>
  xrpc(INDEXER, method, {
    token: session ? await serviceAuth(session, method) : undefined,
    query: params,
  })
const getCommunity = (uri, session) =>
  query('net.krao.community.getCommunity', { uri }, session)
const feedOf = async (uri) =>
  (
    await query('net.krao.community.getFeed', { community: uri })
  ).data.feed?.map((f) => f.post) ?? []
const getContent = async (session, uri) =>
  xrpc(GATE, 'net.krao.gate.getContent', {
    token: await serviceAuth(session, 'net.krao.gate.getContent'),
    query: { uri },
  })
const post = async (session, text) =>
  (
    await createRecord(session, 'app.bsky.feed.post', {
      text,
      createdAt: now(),
    })
  ).data
const submit = (session, community, p) =>
  createRecord(session, 'net.krao.community.submission', {
    community,
    post: { uri: p.uri, cid: p.cid },
    createdAt: now(),
  })

/** ERC-721 transferFrom of hello.base.eth, impersonating its owner on Anvil */
async function moveHello(to) {
  const res = await xrpc(INDEXER, 'net.krao.actor.resolveNft', {
    query: { chain: CHAIN, contract: BASENAMES, tokenId: HELLO_ID.toString() },
  })
  const from = res.data.owner
  if (!from || from === to.toLowerCase()) return
  // The owner may be a fresh wallet from an earlier run, with no gas
  await rpc('anvil_setBalance', [from, '0x56bc75e2d63100000'])
  await rpc('anvil_impersonateAccount', [from])
  await rpc('eth_sendTransaction', [
    {
      from,
      to: BASENAMES,
      data:
        '0x23b872dd' + pad32(from) + pad32(to) + pad32(HELLO_ID.toString(16)),
    },
  ])
  await rpc('anvil_stopImpersonatingAccount', [from])
}

const owner = await login(ACCOUNTS.krao)
const holder = await login(ACCOUNTS.minh)
const outsider = await login(ACCOUNTS.mai)
const mod = await login(ACCOUNTS.lan)

// The holder links a fresh wallet that gets the NFT
const holderWallet = wallet()
const linked = await linkWallet(holder, holderWallet)
check('holder links a fresh wallet', linked.ok, linked.data.message)
await moveHello(holderWallet.address)

// 1. An NFT-gated community
const slug = `nft-${stamp}`
const created = await putRecord(owner, 'net.krao.community.profile', slug, {
  name: `Basenames ${stamp}`,
  description: 'Cộng đồng người giữ Basename',
  rules: ['Không spam', 'Không xin seed phrase'],
  access: {
    mode: 'condition',
    conditions: [
      {
        $type: 'net.krao.gate.defs#nftHolding',
        chain: CHAIN,
        contract: BASENAMES,
      },
    ],
    match: 'all',
  },
  createdAt: now(),
})
check('community profile record accepted', created.ok, created.data.message)
const uri = created.data.uri
const bad = await putRecord(
  owner,
  'net.krao.community.profile',
  `bad-${stamp}`,
  {
    name: 'No access',
    createdAt: now(),
  },
)
check('a profile without access is refused by the PDS', !bad.ok, bad.status)

await createRecord(owner, 'net.krao.community.moderator', {
  community: uri,
  subject: mod.did,
  createdAt: now(),
})
const holderJoin = await createRecord(holder, 'net.krao.community.membership', {
  subject: uri,
  createdAt: now(),
})
await createRecord(outsider, 'net.krao.community.membership', {
  subject: uri,
  createdAt: now(),
})
await sleep(2500)

const anon = await getCommunity(uri)
check(
  'getCommunity works anonymously, without viewer state',
  anon.ok && anon.data.community?.slug === slug && !anon.data.community.viewer,
  JSON.stringify(anon.data).slice(0, 200),
)
check(
  'the community lists its access condition and moderator',
  anon.data.community?.access?.mode === 'condition' &&
    anon.data.community.access.conditions?.[0]?.$type ===
      'net.krao.gate.defs#nftHolding' &&
    anon.data.community.moderators?.includes(mod.did),
)
const asHolder = await getCommunity(uri, holder)
check(
  'the NFT holder is a member',
  asHolder.data.community?.viewer?.state === 'member' &&
    asHolder.data.community.viewer.membership === holderJoin.data.uri,
  JSON.stringify(asHolder.data.community?.viewer),
)
const asOutsider = await getCommunity(uri, outsider)
check(
  'an account without the NFT is not a member',
  asOutsider.data.community?.viewer?.state === 'ineligible' &&
    asOutsider.data.community.viewer.eligible === false,
  JSON.stringify(asOutsider.data.community?.viewer),
)
check(
  'member count: owner, moderator and holder',
  asHolder.data.community?.memberCount === 3,
  asHolder.data.community?.memberCount,
)
const members = await query('net.krao.community.getMembers', {
  community: uri,
})
const memberDids = members.data.members?.map((m) => m.did) ?? []
check(
  'getMembers lists members in good standing only',
  memberDids[0] === owner.did &&
    memberDids.includes(mod.did) &&
    memberDids.includes(holder.did) &&
    !memberDids.includes(outsider.did),
  JSON.stringify(memberDids),
)
const forged = await xrpc(INDEXER, 'net.krao.community.getCommunity', {
  token: await serviceAuth(holder, 'net.krao.community.listMyCommunities'),
  query: { uri },
})
check(
  'a token for another method is refused',
  forged.status === 401 || forged.status === 403,
  forged.status,
)

// 2. Member-only post: public teaser, the body in the gate service
const secret = `Chỉ thành viên ${stamp}: snapshot vào thứ 6.`
const gated = await post(owner, '🔒 Bài cho thành viên cộng đồng')
await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(owner, 'net.krao.gate.putContent'),
  body: { uri: gated.uri, text: secret },
})
const rule = await createRecord(owner, 'net.krao.gate.rule', {
  subject: { uri: gated.uri, cid: gated.cid },
  conditions: [{ $type: 'net.krao.gate.defs#communityMember', community: uri }],
  service: GATE_DID,
  createdAt: now(),
})
check('community gate rule accepted', rule.ok, rule.data.message)
await submit(owner, uri, gated)
await sleep(2000)
const memberRead = await getContent(holder, gated.uri)
check(
  'a member reads the member-only post',
  memberRead.ok && memberRead.data.text === secret,
  memberRead.data.error,
)
const outsiderRead = await getContent(outsider, gated.uri)
check(
  'a non-member is refused (403 NotEligible)',
  outsiderRead.status === 403 && outsiderRead.data.error === 'NotEligible',
  `${outsiderRead.status} ${outsiderRead.data.error}`,
)
const rules = await xrpc(GATE, 'net.krao.gate.getRules', {
  query: { uris: [gated.uri] },
})
check(
  'refusals and public rules never carry the text',
  !JSON.stringify(outsiderRead.data).includes(stamp + ':') &&
    !JSON.stringify(rules.data).includes('snapshot'),
)

// 3. The community feed: members' submissions, minus hidden posts
const holderPost = await post(holder, `Basename của mình ${stamp}`)
const outsiderPost = await post(outsider, `Mình chưa có Basename ${stamp}`)
const notOwn = await submit(holder, uri, outsiderPost)
await submit(holder, uri, holderPost)
await submit(outsider, uri, outsiderPost)
await sleep(2000)
check(
  'submitting someone else’s post is refused or ignored',
  !notOwn.ok || !(await feedOf(uri)).includes(outsiderPost.uri),
)
let feed = await feedOf(uri)
check(
  'the feed has the members’ posts and not the non-member’s',
  feed.includes(holderPost.uri) &&
    feed.includes(gated.uri) &&
    !feed.includes(outsiderPost.uri),
  JSON.stringify(feed),
)
const fakeHide = await createRecord(outsider, 'net.krao.community.hide', {
  community: uri,
  post: holderPost.uri,
  createdAt: now(),
})
const hide = await createRecord(mod, 'net.krao.community.hide', {
  community: uri,
  post: holderPost.uri,
  reason: 'Lạc đề',
  createdAt: now(),
})
await sleep(1500)
feed = await feedOf(uri)
check(
  'a moderator hides a post from the feed (a non-moderator cannot)',
  fakeHide.ok && hide.ok && !feed.includes(holderPost.uri),
  JSON.stringify(feed),
)
await deleteRecord(mod, hide.data.uri)
await sleep(1500)
check(
  'deleting the hide shows the post again',
  (await feedOf(uri)).includes(holderPost.uri),
)

// 4. Bans: the member loses the feed and member-only posts at once
const ban = await createRecord(mod, 'net.krao.community.ban', {
  community: uri,
  subject: holder.did,
  reason: 'e2e',
  createdAt: now(),
})
await sleep(1500)
const bannedRead = await getContent(holder, gated.uri)
const bannedState = await getCommunity(uri, holder)
check(
  'a banned member cannot read member-only posts',
  bannedRead.status === 403 &&
    bannedState.data.community?.viewer?.state === 'banned',
  `${bannedRead.status} ${bannedState.data.community?.viewer?.state}`,
)
check(
  'a banned member’s posts leave the feed',
  !(await feedOf(uri)).includes(holderPost.uri),
)
await deleteRecord(mod, ban.data.uri)
await sleep(1500)
check(
  'lifting the ban lets the member back in',
  (await getContent(holder, gated.uri)).ok,
)

// 5. My communities, search
const mine = await query('net.krao.community.listMyCommunities', {}, holder)
check(
  'listMyCommunities (service auth) has the community with my state',
  mine.data.communities?.some(
    (c) => c.uri === uri && c.viewer?.state === 'member',
  ),
  JSON.stringify(mine.data).slice(0, 200),
)
const anonMine = await xrpc(INDEXER, 'net.krao.community.listMyCommunities')
check('listMyCommunities needs auth', anonMine.status === 401, anonMine.status)
const search = await query('net.krao.community.listCommunities', {
  query: slug,
})
check(
  'listCommunities finds it by slug',
  search.data.communities?.some((c) => c.uri === uri),
)

// 6. An approval community
const approvalSlug = `ask-${stamp}`
const approval = (
  await putRecord(owner, 'net.krao.community.profile', approvalSlug, {
    name: `Hội kín ${stamp}`,
    access: { mode: 'approval' },
    createdAt: now(),
  })
).data.uri
await createRecord(owner, 'net.krao.community.moderator', {
  community: approval,
  subject: mod.did,
  createdAt: now(),
})
await createRecord(outsider, 'net.krao.community.membership', {
  subject: approval,
  createdAt: now(),
})
await sleep(2000)
const pendingState = await getCommunity(approval, outsider)
check(
  'a new member waits for approval',
  pendingState.data.community?.viewer?.state === 'pending',
  JSON.stringify(pendingState.data.community?.viewer),
)
const pending = await query(
  'net.krao.community.getPendingMembers',
  { community: approval },
  mod,
)
check(
  'a moderator sees pending members',
  pending.data.members?.some((m) => m.did === outsider.did),
  JSON.stringify(pending.data),
)
const notMod = await query(
  'net.krao.community.getPendingMembers',
  { community: approval },
  holder,
)
check(
  'others cannot list pending members (NotModerator)',
  notMod.status === 403 && notMod.data.error === 'NotModerator',
  `${notMod.status} ${notMod.data.error}`,
)
await createRecord(holder, 'net.krao.community.approval', {
  community: approval,
  subject: outsider.did,
  createdAt: now(),
})
await sleep(1500)
check(
  'an approval by a non-moderator does not count',
  (await getCommunity(approval, outsider)).data.community?.viewer?.state ===
    'pending',
)
await createRecord(mod, 'net.krao.community.approval', {
  community: approval,
  subject: outsider.did,
  createdAt: now(),
})
await sleep(1500)
check(
  'an approval by a moderator admits the member',
  (await getCommunity(approval, outsider)).data.community?.viewer?.state ===
    'member',
)

// Clean up the fresh wallet (accounts can link at most 10)
await deleteRecord(holder, linked.data.uri)
done()
