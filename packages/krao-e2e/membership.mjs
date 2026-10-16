// M31: creator memberships. A creator offers plans; a member pays USDC on
// the Anvil Base fork straight to the creator's wallet and records it; the
// indexer verifies the transfer, opens membership gates, and closes them when
// the 30 days run out (Anvil's clock moved forward). Also top supporters
// (anonymous tips carry no DID) and the creator dashboard.
// Moves the Anvil clock 31 days forward: run it after the other groups.
import {
  GATE,
  GATE_DID,
  INDEXER,
  PDS,
  SIGNUP_CODE,
  USDC,
  USDC_ASSET,
  checker,
  createRecord,
  dealErc20,
  linkWallet,
  pad32,
  rpc,
  serviceAuth,
  sleep,
  verifyPhone,
  wallet,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)
const now = () => new Date().toISOString()
const CHAIN = 'eip155:8453'

/** A fresh account, so plans and memberships of earlier runs do not count */
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

/** An indexer query as `session` (service auth), or anonymous */
const query = async (method, params, session) =>
  xrpc(INDEXER, method, {
    token: session ? await serviceAuth(session, method) : undefined,
    query: params,
  })
const getContent = async (session, uri) =>
  xrpc(GATE, 'net.krao.gate.getContent', {
    token: await serviceAuth(session, 'net.krao.gate.getContent'),
    query: { uri },
  })
const status = async (session, creator) =>
  (await query('net.krao.membership.getStatus', { creator }, session)).data
    .membership

/** Polls `get` until `ok(value)` or the time is up; returns the last value */
async function waitFor(get, ok, ms = 20_000) {
  const until = Date.now() + ms
  let value = await get()
  while (!ok(value) && Date.now() < until) {
    await sleep(1000)
    value = await get()
  }
  return value
}

/** A USDC transfer from `from` (impersonated on Anvil), returning its hash */
async function sendUsdc(from, to, amount) {
  await rpc('anvil_setBalance', [from, '0x56bc75e2d63100000']) // gas
  await rpc('anvil_impersonateAccount', [from])
  const hash = await rpc('eth_sendTransaction', [
    {
      from,
      to: USDC,
      data: '0xa9059cbb' + pad32(to) + pad32(amount.toString(16)),
    },
  ])
  await rpc('anvil_stopImpersonatingAccount', [from])
  return hash
}

const creator = await signUp('creator')
await verifyPhone(creator) // to post
const member = await signUp('member')
const outsider = await signUp('outsider')
const creatorWallet = wallet()
const memberWallet = wallet()
const outsiderWallet = wallet()
await linkWallet(creator, creatorWallet)
await linkWallet(member, memberWallet)
await linkWallet(outsider, outsiderWallet)
await dealErc20(memberWallet.address, USDC, 100_000_000n) // 100 USDC
await dealErc20(outsiderWallet.address, USDC, 100_000_000n)

// 1. Plans: two active, one turned off
const plan = async (record) =>
  (
    await createRecord(creator, 'net.krao.membership.plan', {
      active: true,
      createdAt: now(),
      ...record,
    })
  ).data
const fan = await plan({
  name: 'Fan',
  description: 'Bài viết riêng mỗi tuần',
  priceUsdc: '5000000',
  perks: ['Bài viết riêng', 'Huy hiệu thành viên'],
})
check('creator posts a plan', !!fan.uri, JSON.stringify(fan))
const vip = await plan({ name: 'VIP', priceUsdc: '20000000' })
await plan({ name: 'Cũ', priceUsdc: '1000000', active: false })
const tooCheap = await createRecord(creator, 'net.krao.membership.plan', {
  name: 'Free',
  priceUsdc: '1',
  active: true,
  createdAt: now(),
})
await sleep(2000)
const publicPlans = await query('net.krao.membership.getPlans', {
  creator: creator.did,
})
check(
  'getPlans lists the active plans to anyone',
  publicPlans.data.plans?.map((p) => p.name).join() === 'Fan,VIP',
  JSON.stringify(publicPlans.data),
)
check(
  'a plan below $1 is not listed',
  tooCheap.ok &&
    !publicPlans.data.plans?.some((p) => p.uri === tooCheap.data.uri),
)
const ownPlans = await query(
  'net.krao.membership.getPlans',
  { creator: creator.did },
  creator,
)
check(
  'the creator also sees the plan they turned off',
  ownPlans.data.plans?.length === 3 &&
    ownPlans.data.plans.some((p) => p.name === 'Cũ' && p.active === false),
  JSON.stringify(ownPlans.data.plans?.map((p) => [p.name, p.active])),
)
const fanView = publicPlans.data.plans?.find((p) => p.uri === fan.uri)
check(
  'a plan shows its price, perks and no members yet',
  fanView?.priceUsdc === '5000000' &&
    fanView?.perks?.length === 2 &&
    fanView?.memberCount === 0,
  JSON.stringify(fanView),
)

// 2. Gated posts: members of the creator, and members of the VIP plan
const gatedPost = async (text, secret, condition) => {
  const post = (
    await createRecord(creator, 'app.bsky.feed.post', {
      text,
      createdAt: now(),
    })
  ).data
  await xrpc(GATE, 'net.krao.gate.putContent', {
    token: await serviceAuth(creator, 'net.krao.gate.putContent'),
    body: { uri: post.uri, text: secret },
  })
  const rule = await createRecord(creator, 'net.krao.gate.rule', {
    subject: { uri: post.uri, cid: post.cid },
    conditions: [{ $type: 'net.krao.gate.defs#membership', ...condition }],
    match: 'all',
    service: GATE_DID,
    createdAt: now(),
  })
  check(`gate rule with ${JSON.stringify(condition)} accepted`, rule.ok)
  return post
}
const forMembers = await gatedPost(
  '🔒 Dành cho thành viên',
  'Lịch livestream tháng sau',
  { creator: creator.did },
)
const forVip = await gatedPost('🔒 Chỉ VIP', 'Tài liệu VIP', {
  creator: creator.did,
  plan: vip.uri,
})
await sleep(1500)
const before = await getContent(member, forMembers.uri)
check(
  'the gate is closed before paying',
  before.status === 403,
  `${before.status}`,
)

// 3. The member pays 5 USDC to the creator's wallet and records it.
// Earlier runs moved the chain 31 days ahead, and an idle chain mines its
// next block far ahead of its latest one: mine now, so the indexer's chain
// clock (read every 5s) starts from the chain's present.
await rpc('evm_mine', [])
await sleep(6000)
const payTx = await sendUsdc(
  memberWallet.address,
  creatorWallet.address,
  5_000_000n,
)
const pay = (session, txHash, p = fan) =>
  createRecord(session, 'net.krao.membership.payment', {
    plan: { uri: p.uri, cid: p.cid },
    creator: creator.did,
    chain: CHAIN,
    txHash,
    createdAt: now(),
  })
const paid = await pay(member, payTx)
check('payment record accepted by the PDS', paid.ok, paid.data.message)
const active = await waitFor(
  () => status(member, creator.did),
  (m) => m?.status === 'active',
)
check(
  'membership becomes active for 30 days',
  active?.status === 'active' &&
    active.plan === fan.uri &&
    Math.round(
      (Date.parse(active.expiresAt) - Date.parse(active.since)) / 86_400_000,
    ) === 30,
  JSON.stringify(active),
)

const open = await getContent(member, forMembers.uri)
check(
  'the gate opens for the member',
  open.ok && open.data.text === 'Lịch livestream tháng sau',
  JSON.stringify(open.data),
)
const closed = await getContent(outsider, forMembers.uri)
check(
  'the gate stays closed for a non-member (403)',
  closed.status === 403,
  `${closed.status} ${closed.data.error}`,
)
const vipClosed = await getContent(member, forVip.uri)
check(
  'a plan gate stays closed for members of another plan',
  vipClosed.status === 403,
  `${vipClosed.status}`,
)

// Someone else claims the member's transfer
await pay(outsider, payTx)
const stolen = await waitFor(
  () => status(outsider, creator.did),
  (m) => m && m.status !== 'pending',
)
check(
  "a claim on someone else's transfer is refused",
  stolen?.status === 'invalid',
  JSON.stringify(stolen),
)

// 4. Members list: only the creator's own
const members = await query('net.krao.membership.listMembers', {}, creator)
check(
  'the creator lists the member as active',
  members.data.members?.length === 1 &&
    members.data.members[0].member === member.did &&
    members.data.members[0].status === 'active',
  JSON.stringify(members.data),
)
const othersList = await query('net.krao.membership.listMembers', {}, outsider)
check(
  "another account sees no one (only its own members, never the creator's)",
  othersList.ok && othersList.data.members?.length === 0,
  JSON.stringify(othersList.data),
)
const anonymousList = await query('net.krao.membership.listMembers', {})
check(
  'listMembers needs auth',
  anonymousList.status === 401,
  `${anonymousList.status}`,
)
const mine = await query('net.krao.membership.listMyMemberships', {}, member)
check(
  'the member lists their membership',
  mine.data.memberships?.length === 1 &&
    mine.data.memberships[0].creator === creator.did,
  JSON.stringify(mine.data),
)
const counted = await query('net.krao.membership.getPlans', {
  creator: creator.did,
})
check(
  'the plan counts its member',
  counted.data.plans?.find((p) => p.uri === fan.uri)?.memberCount === 1,
)

// 5. Top supporters: an anonymous tip of 9 USDC and the member's 5 USDC
const tipTx = await sendUsdc(
  outsiderWallet.address,
  creatorWallet.address,
  9_000_000n,
)
await createRecord(outsider, 'net.krao.feed.tip', {
  recipient: creator.did,
  asset: USDC_ASSET,
  amount: '9000000',
  txHash: tipTx,
  from: outsiderWallet.account,
  to: creatorWallet.account,
  anonymous: true,
  createdAt: now(),
})
const supporters = await waitFor(
  async () =>
    (
      await query('net.krao.creator.getTopSupporters', {
        actor: creator.did,
      })
    ).data,
  (d) => d.supporters?.length === 2,
)
check(
  'top supporters rank the anonymous tip first, then the member',
  supporters.supporters?.[0]?.anonymous === true &&
    supporters.supporters[0].totalUsd === '9.00' &&
    supporters.supporters[1]?.did === member.did &&
    supporters.supporters[1].totalUsd === '5.00',
  JSON.stringify(supporters),
)
check(
  "an anonymous supporter's DID is never exposed",
  !JSON.stringify(supporters).includes(outsider.did) &&
    !('did' in (supporters.supporters?.[0] ?? {})),
)

// 6. The creator's dashboard
const stats = await query('net.krao.creator.getStats', {}, creator)
const today = stats.data.daily?.at(-1)
check(
  'getStats counts the tip and the new member',
  stats.ok &&
    stats.data.tips30d?.count === 1 &&
    stats.data.tips30d.totalUsd === '9.00' &&
    stats.data.members?.active === 1 &&
    stats.data.members.new30d === 1 &&
    stats.data.members.expired30d === 0 &&
    typeof stats.data.followers?.now === 'number',
  JSON.stringify({ ...stats.data, daily: undefined }),
)
check(
  'getStats has 30 days, today with the tip and the member',
  stats.data.daily?.length === 30 &&
    today?.tipsUsd === '9.00' &&
    today?.newMembers === 1,
  JSON.stringify(today),
)
const otherStats = await query('net.krao.creator.getStats', {})
check('getStats needs auth', otherStats.status === 401, `${otherStats.status}`)

// 7. 31 days later on the chain: the membership has run out
await rpc('evm_increaseTime', [31 * 24 * 60 * 60])
await rpc('evm_mine', [])
await sleep(6000) // the indexer reads the chain's clock every 5s
const expired = await status(member, creator.did)
check(
  'the membership expires after 30 days',
  expired?.status === 'expired',
  JSON.stringify(expired),
)
const closedAgain = await getContent(member, forMembers.uri)
check(
  'the gate closes when the membership expires',
  closedAgain.status === 403,
  `${closedAgain.status}`,
)
const expiredList = await query(
  'net.krao.membership.listMembers',
  { status: 'expired' },
  creator,
)
check(
  'the creator lists the member as expired',
  expiredList.data.members?.[0]?.member === member.did &&
    expiredList.data.members[0].status === 'expired',
  JSON.stringify(expiredList.data),
)
const laterStats = await query('net.krao.creator.getStats', {}, creator)
check(
  'getStats moves the member to expired',
  laterStats.data.members?.active === 0 &&
    laterStats.data.members.expired30d === 1,
  JSON.stringify(laterStats.data.members),
)

// 8. The old transaction cannot renew it
await pay(member, payTx)
const reused = await waitFor(
  () => status(member, creator.did),
  (m) => m?.status === 'invalid',
)
check(
  'a reused transaction is refused',
  reused?.status === 'invalid' && /already used/.test(reused.reason ?? ''),
  JSON.stringify(reused),
)
check(
  'and the gate stays closed',
  (await getContent(member, forMembers.uri)).status === 403,
)

// A fresh payment renews it
const renewTx = await sendUsdc(
  memberWallet.address,
  creatorWallet.address,
  5_000_000n,
)
await pay(member, renewTx)
const renewed = await waitFor(
  () => status(member, creator.did),
  (m) => m?.status === 'active',
)
check('a new payment renews the membership', renewed?.status === 'active')
check('and opens the gate again', (await getContent(member, forMembers.uri)).ok)
done()
