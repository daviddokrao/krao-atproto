// Mini Apps and transaction previews (M34): the Mini App registry and its
// review by safety admins, posts embedding a Mini App, the sample Mini App
// the dev-env serves, and net.krao.wallet.simulate / inspectSignature on the
// Anvil Base fork. Needs the dev-env (rewards-admin.test as safety admin)
// and the seed script's data (krao.test's "Bỏ phiếu nhanh").
import {
  ACCOUNTS,
  GATE_DID,
  INDEXER,
  PDS,
  USDC,
  checker,
  createRecord,
  dealErc20,
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

const SAMPLE = process.env.KRAO_MINIAPP_SAMPLE_URL ?? 'http://localhost:2595/'
const WEB = process.env.KRAO_DEV_WEB_URL ?? 'http://localhost:8081'
const BASENAMES = '0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a'
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const MAX = 'f'.repeat(64)
const COLLECTION = 'net.krao.miniapp.app'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)

/** A method on the indexer, called as `session` with service auth */
async function asUser(session, method, { body, query } = {}) {
  const token = await serviceAuth(session, method, GATE_DID)
  return xrpc(INDEXER, method, { token, body, query })
}

const getApp = (uri) =>
  xrpc(INDEXER, 'net.krao.miniapp.getApp', { query: { uri } })

/** getApp once the indexer has the record at `cid` */
async function indexed(uri, cid) {
  let res
  for (let i = 0; i < 30; i++) {
    res = await getApp(uri)
    if (res.data.app?.cid === cid) return res.data.app
    await sleep(300)
  }
  return res?.data.app
}

const appRecord = (over = {}) => ({
  name: `Mini App ${stamp}`,
  description: 'e2e',
  url: `https://miniapp-${stamp}.example.com/`,
  permissions: ['identity', 'sign'],
  createdAt: new Date().toISOString(),
  ...over,
})

/*
 * The sample Mini App and the seeded one
 */

const sample = await fetch(SAMPLE).catch(() => null)
check(
  'the sample Mini App answers at :2595',
  sample?.status === 200 && (await sample.text()).includes('Bỏ phiếu nhanh'),
  sample?.status,
)

const krao = await login(ACCOUNTS.krao)
const seeded = await getApp(`at://${krao.did}/${COLLECTION}/bo-phieu-nhanh`)
check(
  "krao.test's sample Mini App is seeded and approved",
  seeded.data.app?.status === 'approved' &&
    seeded.data.app?.url === SAMPLE &&
    seeded.data.app?.permissions?.length === 4,
  JSON.stringify(seeded.data),
)
if (seeded.data.app?.iconUrl) {
  const icon = await fetch(seeded.data.app.iconUrl)
  check(
    'its icon comes through the indexer as PNG',
    icon.ok && icon.headers.get('content-type') === 'image/png',
    icon.status,
  )
} else {
  check('the seeded Mini App has an icon', false)
}

/*
 * The registry and its review
 */

const dev = await login(ACCOUNTS.mai)
const admin = await login(ACCOUNTS.rewardsAdmin, { phone: false })

const http = await createRecord(
  dev,
  COLLECTION,
  appRecord({ url: `http://miniapp-${stamp}.example.com/` }),
)
const sameOrigin = await createRecord(
  dev,
  COLLECTION,
  appRecord({ url: `${WEB}/miniapp` }),
)
check(
  'the PDS takes Mini App records',
  http.ok && sameOrigin.ok,
  http.data.message,
)
const httpApp = await indexed(http.data.uri, http.data.cid)
const sameApp = await indexed(sameOrigin.data.uri, sameOrigin.data.cid)
check(
  'a plain http URL (outside localhost) is invalid',
  httpApp?.status === 'invalid',
  JSON.stringify(httpApp),
)
check(
  "Krao's own web origin is invalid",
  sameApp?.status === 'invalid',
  JSON.stringify(sameApp),
)

const valid = await putRecord(dev, COLLECTION, `e2e-${stamp}`, appRecord())
let app = await indexed(valid.data.uri, valid.data.cid)
check(
  'a valid Mini App is pending',
  app?.status === 'pending',
  JSON.stringify(app),
)
const approved = async () =>
  (
    await xrpc(INDEXER, 'net.krao.miniapp.listApproved', {
      query: { limit: 50 },
    })
  ).data.apps?.some((a) => a.uri === valid.data.uri)
check('and not listed as approved', !(await approved()))
const pending = await asUser(admin, 'net.krao.miniapp.admin.listPending', {
  query: { limit: 50 },
})
check(
  'admins see it pending',
  pending.data.apps?.some((a) => a.uri === valid.data.uri),
  JSON.stringify(pending.data).slice(0, 300),
)

const byUser = await asUser(dev, 'net.krao.miniapp.admin.approve', {
  body: { uri: valid.data.uri, cid: valid.data.cid },
})
check('others may not approve (403)', byUser.status === 403, byUser.status)
const wrongCid = await asUser(admin, 'net.krao.miniapp.admin.approve', {
  body: { uri: valid.data.uri, cid: http.data.cid },
})
check(
  'approving another version is refused (CidMismatch)',
  wrongCid.data.error === 'CidMismatch',
  JSON.stringify(wrongCid.data),
)
const approve = await asUser(admin, 'net.krao.miniapp.admin.approve', {
  body: { uri: valid.data.uri, cid: valid.data.cid },
})
check(
  'an admin approves the current version',
  approve.ok && approve.data.app?.status === 'approved',
  JSON.stringify(approve.data),
)
check('it is listed as approved', await approved())
const invalidApprove = await asUser(admin, 'net.krao.miniapp.admin.approve', {
  body: { uri: http.data.uri, cid: http.data.cid },
})
check(
  'invalid Mini Apps cannot be approved',
  invalidApprove.data.error === 'InvalidApp',
  JSON.stringify(invalidApprove.data),
)

const edited = await putRecord(
  dev,
  COLLECTION,
  `e2e-${stamp}`,
  appRecord({ name: `Mini App ${stamp} v2` }),
)
app = await indexed(edited.data.uri, edited.data.cid)
check(
  'changing the record sends it back to pending',
  edited.ok && edited.data.cid !== valid.data.cid && app?.status === 'pending',
  JSON.stringify(app),
)
check('and off the approved list', !(await approved()))

await asUser(admin, 'net.krao.miniapp.admin.approve', {
  body: { uri: edited.data.uri, cid: edited.data.cid },
})
const revoke = await asUser(admin, 'net.krao.miniapp.admin.revoke', {
  body: { uri: edited.data.uri, reason: 'e2e' },
})
check(
  'an admin revokes it',
  revoke.data.app?.status === 'revoked' &&
    (await getApp(edited.data.uri)).data.app?.status === 'revoked' &&
    !(await approved()),
  JSON.stringify(revoke.data),
)
const missing = await getApp(`at://${dev.did}/${COLLECTION}/nope-${stamp}`)
check('unknown Mini Apps are NotFound', missing.data.error === 'NotFound')

/*
 * A post embedding a Mini App
 */

const post = await createRecord(krao, 'app.bsky.feed.post', {
  text: `Mini App ${stamp}`,
  embed: {
    $type: 'net.krao.embed.miniapp',
    app: {
      uri: seeded.data.app?.uri ?? valid.data.uri,
      cid: seeded.data.app?.cid ?? valid.data.cid,
    },
  },
  createdAt: new Date().toISOString(),
})
const stored = post.ok
  ? await xrpc(PDS, 'com.atproto.repo.getRecord', {
      query: {
        repo: krao.did,
        collection: 'app.bsky.feed.post',
        rkey: post.data.uri.split('/').pop(),
      },
    })
  : undefined
check(
  'the PDS takes a post with a net.krao.embed.miniapp embed',
  stored?.data.value?.embed?.$type === 'net.krao.embed.miniapp',
  JSON.stringify(post.data),
)

/*
 * Transaction previews on the Anvil fork
 */

const w = wallet()
await rpc('anvil_setBalance', [w.address, '0x' + (10n ** 18n).toString(16)])
await dealErc20(w.address, USDC, 5_000000n)
const stranger = wallet().address
const simulate = (body) =>
  asUser(krao, 'net.krao.wallet.simulate', {
    body: { chain: 'eip155:8453', from: w.address, ...body },
  })
const codes = (res) => (res.data.warnings ?? []).map((x) => x.code)

const noAuth = await xrpc(INDEXER, 'net.krao.wallet.simulate', {
  body: { chain: 'eip155:8453', from: w.address, to: stranger },
})
check('previews need a signed-in account', noAuth.status === 401, noAuth.status)

const eth = await simulate({ to: stranger, value: '1000000000000000' })
check(
  'sending ETH: traced, the exact amount goes out',
  eth.data.ok === true &&
    eth.data.method === 'trace' &&
    eth.data.changes?.some(
      (c) =>
        c.direction === 'out' &&
        c.kind === 'native' &&
        c.amount === '1000000000000000' &&
        c.counterparty === stranger.toLowerCase(),
    ),
  JSON.stringify(eth.data),
)

const transferData = (to, amount) =>
  '0xa9059cbb' + pad32(to) + pad32(amount.toString(16))
const usdcOut = await simulate({
  to: USDC,
  data: transferData(stranger, 1_000000n),
})
check(
  'sending USDC: an erc20 change out',
  usdcOut.data.ok === true &&
    usdcOut.data.changes?.some(
      (c) =>
        c.direction === 'out' &&
        c.kind === 'erc20' &&
        c.amount === '1000000' &&
        c.token?.symbol === 'USDC',
    ),
  JSON.stringify(usdcOut.data),
)
check('worth 1 USD', usdcOut.data.usdOut === '1.00', usdcOut.data.usdOut)

const approveMax = await simulate({
  to: USDC,
  data: '0x095ea7b3' + pad32(stranger) + MAX,
})
check(
  'approving USDC without limit: unlimitedApproval (danger)',
  approveMax.data.approvals?.[0]?.unlimited === true &&
    approveMax.data.warnings?.some(
      (x) => x.code === 'unlimitedApproval' && x.severity === 'danger',
    ),
  JSON.stringify(approveMax.data),
)

const forAll = await simulate({
  to: BASENAMES,
  data: '0xa22cb465' + pad32(stranger) + pad32('1'),
})
check(
  'setApprovalForAll(true): approvalForAll',
  codes(forAll).includes('approvalForAll') &&
    forAll.data.approvals?.[0]?.kind === 'approvalForAll',
  JSON.stringify(forAll.data),
)

const reverts = await simulate({
  to: USDC,
  data: transferData(stranger, 1000_000000n),
})
check(
  'a transaction that reverts: ok=false, reverts',
  reverts.data.ok === false && codes(reverts).includes('reverts'),
  JSON.stringify(reverts.data),
)

const delegation = await simulate({
  to: w.address,
  authorizationList: [{ address: stranger, chainId: '8453' }],
})
check(
  'an EIP-7702 authorization: eip7702Delegation',
  delegation.data.warnings?.some(
    (x) => x.code === 'eip7702Delegation' && x.severity === 'danger',
  ),
  JSON.stringify(delegation.data),
)

const unsafe = await simulate({
  to: stranger,
  value: '1',
  origin: 'https://drainer.test',
})
check(
  'a Mini App on an unsafe domain: unsafeOrigin',
  codes(unsafe).includes('unsafeOrigin'),
  JSON.stringify(unsafe.data),
)

// A verified wallet of another account, and an address that looks like it
const victim = await login(ACCOUNTS.lan)
const victimWallet = wallet()
await linkWallet(victim, victimWallet)
const real = victimWallet.address.toLowerCase()
const fake =
  real.slice(0, 6) +
  [...real.slice(6, -4)].map((c) => (c === 'e' ? 'f' : 'e')).join('') +
  real.slice(-4)
let lookalike
for (let i = 0; i < 20; i++) {
  lookalike = await simulate({ to: fake, value: '1' })
  if (codes(lookalike).includes('lookalikeAddress')) break
  await sleep(500)
}
check(
  "sending to a lookalike of another account's wallet: lookalikeAddress",
  lookalike.data.warnings?.some(
    (x) => x.code === 'lookalikeAddress' && x.address === fake,
  ),
  JSON.stringify(lookalike.data),
)

const otherChain = await asUser(krao, 'net.krao.wallet.simulate', {
  body: { chain: 'eip155:1', from: w.address, to: stranger },
})
check(
  'other chains are UnsupportedChain',
  otherChain.data.error === 'UnsupportedChain',
  JSON.stringify(otherChain.data),
)

/*
 * Signature previews
 */

const inspect = (body) =>
  asUser(krao, 'net.krao.wallet.inspectSignature', {
    body: { chain: 'eip155:8453', from: w.address, ...body },
  })
const permit2 = await inspect({
  method: 'eth_signTypedData_v4',
  payload: JSON.stringify({
    domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
    primaryType: 'PermitSingle',
    types: {},
    message: {
      details: {
        token: USDC,
        amount: ((1n << 160n) - 1n).toString(),
        expiration: 0,
        nonce: 0,
      },
      spender: stranger,
      sigDeadline: 0,
    },
  }),
  origin: 'https://vote.example.com',
})
check(
  'an unlimited Permit2 permit: permit2 + unlimitedApproval',
  permit2.data.kind === 'permit2' &&
    codes(permit2).includes('unlimitedApproval'),
  JSON.stringify(permit2.data),
)
const plain = await inspect({
  method: 'personal_sign',
  payload: 'Bỏ phiếu nhanh: tôi chọn "Có"',
  origin: 'https://vote.example.com',
})
check(
  'a plain message: message, nothing dangerous',
  plain.data.kind === 'message' &&
    !plain.data.warnings?.some((x) => x.severity === 'danger'),
  JSON.stringify(plain.data),
)

done()
