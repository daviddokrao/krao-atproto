// M2: the PDS validates io.krao.* records against their lexicons.
import {
  ACCOUNTS,
  USDC_ASSET,
  checker,
  createRecord,
  deleteRecord,
  login,
} from './lib.mjs'

const { check, done } = checker()
const s = await login(ACCOUNTS.krao)
const now = new Date().toISOString()
const post = (
  await createRecord(s, 'app.bsky.feed.post', {
    text: 'Gated alpha 🔒',
    createdAt: now,
  })
).data
const fakeAccount = 'eip155:8453:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'

const cases = [
  [
    'wallet (valid)',
    'io.krao.actor.wallet',
    {
      account: fakeAccount,
      proof: {
        type: 'siwe',
        message: `URI: ${s.did}`,
        signature: '0x' + 'ab'.repeat(65),
      },
      createdAt: now,
    },
    true,
  ],
  [
    'wallet (no proof)',
    'io.krao.actor.wallet',
    { account: fakeAccount, createdAt: now },
    false,
  ],
  [
    'tip (valid)',
    'io.krao.feed.tip',
    {
      recipient: 'did:plc:baoawbqghvolw7wigqrokhus',
      subject: { uri: post.uri, cid: post.cid },
      asset: USDC_ASSET,
      amount: '5000000',
      txHash: '0x' + '12'.repeat(32),
      createdAt: now,
    },
    true,
  ],
  [
    'tip (handle as recipient)',
    'io.krao.feed.tip',
    {
      recipient: 'defi-minh.test',
      asset: 'eip155:8453/slip44:60',
      amount: '1',
      txHash: '0x01',
      createdAt: now,
    },
    false,
  ],
  [
    'gate rule (valid)',
    'io.krao.gate.rule',
    {
      subject: { uri: post.uri, cid: post.cid },
      conditions: [
        {
          $type: 'io.krao.gate.defs#tokenBalance',
          asset: USDC_ASSET,
          minAmount: '1000000',
        },
      ],
      service: 'did:web:gate.krao.io',
      createdAt: now,
    },
    true,
  ],
  [
    'nftAvatar (valid, rkey self)',
    'io.krao.actor.nftAvatar',
    {
      nft: {
        chain: 'eip155:1',
        contract: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
        tokenId: '1234',
        standard: 'erc721',
      },
      wallet: fakeAccount,
      createdAt: now,
    },
    true,
    'self',
  ],
]

const created = [post.uri]
for (const [name, collection, record, expectOk, rkey] of cases) {
  const r = await createRecord(s, collection, record, { rkey })
  if (r.ok) created.push(r.data.uri)
  check(
    name,
    r.ok === expectOk,
    r.ok ? 'accepted' : `rejected (${r.data.error}: ${r.data.message})`,
  )
}

// The fake records would show up as invalid wallets/NFTs in later checks
for (const uri of created.reverse()) await deleteRecord(s, uri)
done()
