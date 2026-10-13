// M4: ETH/USDC tips on Base, verified by the indexer against the chain.
import {
  ACCOUNTS,
  ANVIL_KEYS,
  ETH_ASSET,
  INDEXER,
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
    await xrpc(INDEXER, 'io.krao.actor.getChainProfiles', {
      query: { actors: 'defi-minh.test' },
    })
  ).data.profiles?.[0]?.tipsReceivedCount ?? 0
const receivedBefore = await tipsReceived()

const tip = (asset, amount, txHash, extra = {}) =>
  createRecord(sender, 'io.krao.feed.tip', {
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
const res = await xrpc(INDEXER, 'io.krao.feed.getTips', {
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
check(
  'inflated amount on a reused tx is not counted',
  byTx(ethTx).length === 1,
  `${byTx(ethTx).length} tips listed for the ETH tx`,
)
check('tip to an unlinked wallet is not listed', byTx(strangerTx).length === 0)
check(
  'tip with an unknown tx stays pending',
  byTx(unknownTx).some((t) => t.status === 'pending'),
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

const received = (await tipsReceived()) - receivedBefore
check(
  'recipient profile counts the 2 verified tips',
  received === 2,
  String(received),
)
done()
