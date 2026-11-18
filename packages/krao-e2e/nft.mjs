// M5: verified NFT avatars and on-chain badges. Uses the real Basename
// hello.base.eth on the Base fork, moved to the dev wallet (Anvil #0).
import {
  ACCOUNTS,
  ANVIL_KEYS,
  INDEXER,
  checker,
  deleteRecord,
  linkWallet,
  login,
  pad32,
  putRecord,
  rpc,
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
const profileOf = async (actor) =>
  (
    await xrpc(INDEXER, 'net.krao.actor.getChainProfiles', {
      query: { actors: actor },
    })
  ).data.profiles?.[0]
const resolveHello = () =>
  xrpc(INDEXER, 'net.krao.actor.resolveNft', {
    query: { chain: CHAIN, contract: BASENAMES, tokenId: HELLO_ID.toString() },
  })

/** ERC-721 transferFrom, impersonating `from` on Anvil */
async function transferNft(from, to) {
  // The owner may be a fresh wallet left by the community group, with no gas
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

const s = await login(ACCOUNTS.krao)
const alice = await login(ACCOUNTS.alice)
const dev = wallet(ANVIL_KEYS[0])
const other = wallet(ANVIL_KEYS[1])

// The fork starts with the real mainnet owner; hand the NFT to the dev wallet
let resolved = await resolveHello()
if (resolved.ok && resolved.data.owner !== dev.address.toLowerCase()) {
  await transferNft(resolved.data.owner, dev.address)
  resolved = await resolveHello()
}

// 1. resolveNft reads the Basename from the fork
check('resolveNft finds the NFT', resolved.ok, resolved.data.error)
check(
  'resolveNft reports the dev wallet as owner',
  resolved.data.owner === dev.address.toLowerCase(),
  resolved.data.owner,
)
check(
  'resolveNft reads the collection name',
  resolved.data.collectionName === 'Basenames',
  resolved.data.collectionName,
)
const missing = await xrpc(INDEXER, 'net.krao.actor.resolveNft', {
  query: { chain: CHAIN, contract: BASENAMES, tokenId: '1' },
})
check(
  'resolveNft returns NotFound for an unminted token',
  missing.data.error === 'NotFound',
  missing.data.error,
)

// 2. Link the dev wallet and set the NFT as avatar
const linked = await linkWallet(s, dev)
const nftRecord = {
  nft: {
    chain: CHAIN,
    contract: BASENAMES,
    tokenId: HELLO_ID.toString(),
    standard: 'erc721',
  },
  wallet: dev.account,
  createdAt: new Date().toISOString(),
}
const put = await putRecord(s, 'net.krao.actor.nftAvatar', 'self', nftRecord)
check('nftAvatar record accepted by PDS', put.ok, put.data.error)
await sleep(3000)
const p = await profileOf('krao.test')
check(
  'NFT avatar is verified',
  p?.nftAvatar?.status === 'verified',
  p?.nftAvatar?.status,
)
check(
  'NFT avatar view has the collection name',
  p?.nftAvatar?.collectionName === 'Basenames',
)
const badgeIds = (p?.badges ?? []).map((b) => b.id)
check(
  'badges include wallet-verified and nft-avatar',
  badgeIds.includes('wallet-verified') && badgeIds.includes('nft-avatar'),
  JSON.stringify(badgeIds),
)

// 3. alice.test claims the NFT without having linked the owning wallet
await putRecord(alice, 'net.krao.actor.nftAvatar', 'self', nftRecord)
await sleep(3000)
const ap = await profileOf('alice.test')
check(
  "claiming someone else's NFT is invalid",
  ap?.nftAvatar?.status === 'invalid',
  ap?.nftAvatar?.status,
)
check(
  'no nft-avatar badge for an invalid claim',
  !(ap?.badges ?? []).some((b) => b.id === 'nft-avatar'),
)

// 4. Selling the NFT drops the verification on the next re-check
await transferNft(dev.address, other.address)
console.log('      transferred the NFT away, waiting for the re-check…')
let status
for (let i = 0; i < 12 && status !== 'invalid'; i++) {
  await sleep(2500)
  status = (await profileOf('krao.test'))?.nftAvatar?.status
}
check(
  'NFT avatar becomes invalid after the NFT is transferred away',
  status === 'invalid',
  status,
)

// Clean up: NFT back to the dev wallet, test records removed
await transferNft(other.address, dev.address)
const avatarUri = (did) => `at://${did}/net.krao.actor.nftAvatar/self`
await deleteRecord(s, avatarUri(s.did))
await deleteRecord(alice, avatarUri(alice.did))
if (linked.ok) await deleteRecord(s, linked.data.uri)
done()
