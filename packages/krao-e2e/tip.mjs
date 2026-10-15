// M4: ETH/USDC tips on Base, verified by the indexer against the chain.
import {
  ACCOUNTS,
  ANVIL_KEYS,
  ETH_ASSET,
  INDEXER,
  PDS,
  USDC,
  USDC_ASSET,
  checker,
  createRecord,
  dealErc20,
  linkWallet,
  login,
  pad32,
  rpc,
  sleep,
  wallet,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const sender = await login(ACCOUNTS.krao)
const recipient = await login(ACCOUNTS.minh)
const sw = wallet(ANVIL_KEYS[0])
const rw = wallet(ANVIL_KEYS[1])
await dealErc20(sw.address, USDC, 100_000_000n) // 100 USDC to tip with
await linkWallet(sender, sw)
await linkWallet(recipient, rw)
// A device for the recipient, to see the tip pushed (see push.mjs)
const PUSH = process.env.KRAO_PUSH_URL ?? 'http://localhost:2593'
const PUSH_TOKEN =
  process.env.KRAO_PUSH_INTERNAL_TOKEN ?? 'krao-dev-push-internal-token'
const deviceToken = `e2e-tip-${Date.now()}`
await xrpc(PDS, 'app.bsky.notification.registerPush', {
  token: recipient.accessJwt,
  body: {
    serviceDid:
      process.env.KRAO_APPVIEW_DID ?? 'did:plc:dw4kbjf5mn7nhenabiqpkyh3',
    token: deviceToken,
    platform: 'android',
    appId: 'io.krao.app',
  },
})
const post = (
  await createRecord(recipient, 'app.bsky.feed.post', {
    text: 'Tip me if this helped 💎',
    createdAt: new Date().toISOString(),
  })
).data
await sleep(1500)

// Earlier runs on the same dev-env already count towards the profile total
const tipsReceived = async () =>
  (
    await xrpc(INDEXER, 'net.krao.actor.getChainProfiles', {
      query: { actors: 'defi-minh.test' },
    })
  ).data.profiles?.[0]?.tipsReceivedCount ?? 0
const receivedBefore = await tipsReceived()

const tip = (asset, amount, txHash, extra = {}) =>
  createRecord(sender, 'net.krao.feed.tip', {
    recipient: recipient.did,
    subject: { uri: post.uri, cid: post.cid },
    asset,
    amount: amount.toString(),
    txHash,
    from: sw.account,
    to: rw.account,
    createdAt: new Date().toISOString(),
    ...extra,
  })

// 1. 0.01 ETH tip
const ethAmount = 10n ** 16n
const ethTx = await rpc('eth_sendTransaction', [
  { from: sw.address, to: rw.address, value: '0x' + ethAmount.toString(16) },
])
const t1 = await tip(ETH_ASSET, ethAmount, ethTx, { message: 'Great post!' })
check('ETH tip record accepted by PDS', t1.ok, t1.data.error)

// 2. 5 USDC tip via ERC-20 transfer
const usdcAmount = 5_000_000n
const usdcTx = await rpc('eth_sendTransaction', [
  {
    from: sw.address,
    to: USDC,
    data: '0xa9059cbb' + pad32(rw.address) + pad32(usdcAmount.toString(16)),
  },
])
await tip(USDC_ASSET, usdcAmount, usdcTx)

// 3. Cheats
await tip(ETH_ASSET, ethAmount * 100n, ethTx) // inflated amount, reused tx
const dead = '0x000000000000000000000000000000000000dEaD'
const strangerTx = await rpc('eth_sendTransaction', [
  { from: sw.address, to: dead, value: '0x1' },
])
await tip(ETH_ASSET, 1n, strangerTx, { to: `eip155:8453:${dead}` })
const unknownTx = '0x' + 'ab'.repeat(32)
await tip(ETH_ASSET, 1n, unknownTx)

await sleep(4000)
const res = await xrpc(INDEXER, 'net.krao.feed.getTips', {
  query: { subject: post.uri },
})
const tips = res.data.tips ?? []
const byTx = (h) => tips.filter((t) => t.txHash === h.toLowerCase())
check('getTips works for the post', res.ok, res.data.error)
check(
  'ETH tip is verified',
  byTx(ethTx).some(
    (t) => t.status === 'verified' && t.amount === ethAmount.toString(),
  ),
)
check(
  'ETH tip carries the message and sender profile',
  byTx(ethTx).some(
    (t) => t.message === 'Great post!' && t.sender.handle === 'krao.test',
  ),
)
check(
  'USDC tip is verified',
  byTx(usdcTx).some((t) => t.status === 'verified'),
)
const pushed = (
  await (
    await fetch(`${PUSH}/internal/recent`, {
      headers: { authorization: `Bearer ${PUSH_TOKEN}` },
    })
  ).json()
).sent.filter((s) => s.token === deviceToken && s.msg.data.reason === 'krao-tip')
check(
  'each verified tip is pushed to the recipient, the cheats are not',
  pushed.length === 2 &&
    pushed.some((s) => s.msg.body === 'Great post!') &&
    pushed.every((s) => s.msg.data.subject === post.uri),
  JSON.stringify(pushed.map((s) => s.msg)),
)
check(
  'inflated amount on a reused tx is not counted',
  byTx(ethTx).length === 1,
  `${byTx(ethTx).length} tips listed for the ETH tx`,
)
check('tip to an unlinked wallet is not listed', byTx(strangerTx).length === 0)
check(
  'a tip whose transaction is not confirmed is not shown publicly',
  byTx(unknownTx).length === 0,
)
const eth = res.data.totals?.find((t) => t.asset === ETH_ASSET)
const usdc = res.data.totals?.find((t) => t.asset === USDC_ASSET)
check(
  'ETH total is 0.01 ETH from 1 tip',
  eth?.amount === ethAmount.toString() && eth?.count === 1,
  JSON.stringify(eth),
)
check(
  'USDC total is 5 USDC from 1 tip',
  usdc?.amount === usdcAmount.toString() && usdc?.count === 1,
  JSON.stringify(usdc),
)

// Feed batch lookup: totals per post, untipped posts omitted
const untipped = (
  await createRecord(recipient, 'app.bsky.feed.post', {
    text: 'No tips here',
    createdAt: new Date().toISOString(),
  })
).data
const batch = await xrpc(INDEXER, 'net.krao.feed.getTipTotals', {
  query: { subjects: [post.uri, untipped.uri] },
})
const byAsset = (totals = []) =>
  JSON.stringify([...totals].sort((a, b) => a.asset.localeCompare(b.asset)))
const batchTotals = batch.data.subjects?.find(
  (s) => s.subject === post.uri,
)?.totals
check(
  'getTipTotals returns the same totals for the post',
  !!batchTotals && byAsset(batchTotals) === byAsset(res.data.totals),
  JSON.stringify(batchTotals),
)
check(
  'getTipTotals omits a post without tips',
  batch.data.subjects?.length === 1,
  String(batch.data.subjects?.length),
)

// 4. Someone else claims a transfer they did not send. They post first, so
// the earliest-claim rule alone would not stop them.
const thief = await login(ACCOUNTS.lan)
// A wallet of their own (fresh: test keys belong to other accounts)
const tw = wallet()
await linkWallet(thief, tw)
const post2 = (
  await createRecord(recipient, 'app.bsky.feed.post', {
    text: 'Another one',
    createdAt: new Date().toISOString(),
  })
).data
await sleep(1500)
const spoofAmount = 2n * 10n ** 15n
const spoofTx = await rpc('eth_sendTransaction', [
  { from: sw.address, to: rw.address, value: '0x' + spoofAmount.toString(16) },
])
const claim = (session, extra) =>
  createRecord(session, 'net.krao.feed.tip', {
    recipient: recipient.did,
    subject: { uri: post2.uri, cid: post2.cid },
    asset: ETH_ASSET,
    amount: spoofAmount.toString(),
    txHash: spoofTx,
    to: rw.account,
    createdAt: new Date().toISOString(),
    ...extra,
  })
await claim(thief, {}) // no sender wallet
await claim(thief, { from: sw.account }) // a wallet that is not theirs
await claim(thief, { from: tw.account }) // their wallet, but not the tx sender
await sleep(1500)
await claim(sender, { from: sw.account })
await sleep(4000)
const res2 = await xrpc(INDEXER, 'net.krao.feed.getTips', {
  query: { subject: post2.uri },
})
const claims = (res2.data.tips ?? []).filter(
  (t) => t.txHash === spoofTx.toLowerCase(),
)
check(
  'spoofed claims on a transfer are rejected',
  claims.length === 1 && claims[0].sender.handle === 'krao.test',
  JSON.stringify(claims.map((t) => [t.sender.handle, t.status])),
)
check(
  'the real sender is credited for the transfer',
  claims[0]?.status === 'verified',
  claims[0]?.status,
)

const received = (await tipsReceived()) - receivedBefore
check(
  'recipient profile counts the 3 verified tips',
  received === 3,
  String(received),
)
done()
