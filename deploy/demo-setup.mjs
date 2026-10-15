// Seeds the Krao sandbox demo once the dev-env is up: sample accounts and
// posts, test funds and the demo NFT on the Anvil fork, linked wallets, an
// NFT avatar, a token-gated post and a verified tip.
import { spawnSync } from 'node:child_process'
import * as L from '../packages/krao-e2e/lib.mjs'

const BASENAMES = '0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a'
const HELLO_ID = BigInt(
  '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
)
const now = () => new Date().toISOString()

async function waitFor(name, ready) {
  for (let i = 0; i < 300; i++) {
    if (await ready().catch(() => false)) return
    await L.sleep(2000)
  }
  throw new Error(`${name} did not come up`)
}

await waitFor('PDS', async () => (await fetch(`${L.PDS}/xrpc/_health`)).ok)
await waitFor('indexer', async () => (await fetch(`${L.INDEXER}/_health`)).ok)
// The dev-env's own mock data must finish before seeding on top of it
await waitFor(
  'mock data',
  async () =>
    (
      await L.xrpc(L.PDS, 'com.atproto.identity.resolveHandle', {
        query: { handle: 'carla.test' },
      })
    ).ok,
)
await L.sleep(10_000)

const seed = spawnSync(process.execPath, ['deploy/seed-local.mjs', L.PDS], {
  stdio: 'inherit',
})
if (seed.status !== 0) throw new Error('seed-local failed')

// Test funds: the app's built-in dev wallet is Anvil #0
const [dev, minhWallet, maiWallet] = L.ANVIL_KEYS.map((k) => L.wallet(k))
await L.dealErc20(dev.address, L.USDC, 1_000_000_000n) // 1000 USDC
await L.dealErc20(minhWallet.address, L.USDC, 50_000_000n) // 50 USDC
await L.dealErc20(maiWallet.address, L.USDC, 1_000_000n) // 1 USDC

// The demo NFT (hello.base.eth) goes to the dev wallet
const resolved = await L.xrpc(L.INDEXER, 'net.krao.actor.resolveNft', {
  query: {
    chain: 'eip155:8453',
    contract: BASENAMES,
    tokenId: HELLO_ID.toString(),
  },
})
const owner = resolved.data.owner
if (owner && owner !== dev.address.toLowerCase()) {
  await L.rpc('anvil_impersonateAccount', [owner])
  await L.rpc('eth_sendTransaction', [
    {
      from: owner,
      to: BASENAMES,
      data:
        '0x23b872dd' +
        L.pad32(owner) +
        L.pad32(dev.address) +
        L.pad32(HELLO_ID.toString(16)),
    },
  ])
  await L.rpc('anvil_stopImpersonatingAccount', [owner])
}

// Linked wallets: krao.test holds the dev wallet, minh is eligible for the
// gated post (50 USDC), mai is not (1 USDC)
const krao = await L.login(L.ACCOUNTS.krao)
const minh = await L.login(L.ACCOUNTS.minh)
const mai = await L.login(L.ACCOUNTS.mai)
await L.linkWallet(krao, dev)
await L.linkWallet(minh, minhWallet)
await L.linkWallet(mai, maiWallet)
await L.sleep(3000)

await L.putRecord(krao, 'net.krao.actor.nftAvatar', 'self', {
  nft: {
    chain: 'eip155:8453',
    contract: BASENAMES,
    tokenId: HELLO_ID.toString(),
    standard: 'erc721',
  },
  wallet: dev.account,
  createdAt: now(),
})

// A token-gated post
const gated = (
  await L.createRecord(krao, 'app.bsky.feed.post', {
    text: '🔒 Alpha cho holder: cần ≥ 10 USDC để xem.',
    createdAt: now(),
  })
).data
await L.xrpc(L.GATE, 'net.krao.gate.putContent', {
  token: await L.serviceAuth(krao, 'net.krao.gate.putContent'),
  body: {
    uri: gated.uri,
    text: 'Alpha: airdrop snapshot vào thứ 6, nhớ bridge sang Base trước.',
  },
})
await L.createRecord(krao, 'net.krao.gate.rule', {
  subject: { uri: gated.uri, cid: gated.cid },
  conditions: [
    {
      $type: 'net.krao.gate.defs#tokenBalance',
      asset: L.USDC_ASSET,
      minAmount: '10000000',
    },
  ],
  match: 'all',
  service: L.GATE_DID,
  createdAt: now(),
})

// A verified 5 USDC tip from krao.test to one of minh's posts
const tipped = (
  await L.createRecord(minh, 'app.bsky.feed.post', {
    text: 'Tip me if this helped 💎',
    createdAt: now(),
  })
).data
const amount = 5_000_000n
const txHash = await L.rpc('eth_sendTransaction', [
  {
    from: dev.address,
    to: L.USDC,
    data:
      '0xa9059cbb' + L.pad32(minhWallet.address) + L.pad32(amount.toString(16)),
  },
])
await L.createRecord(krao, 'net.krao.feed.tip', {
  recipient: minh.did,
  subject: { uri: tipped.uri, cid: tipped.cid },
  asset: L.USDC_ASSET,
  amount: amount.toString(),
  txHash,
  from: dev.account,
  to: minhWallet.account,
  message: 'Cảm ơn chia sẻ!',
  createdAt: now(),
})

console.log('✅ Krao demo data ready')
