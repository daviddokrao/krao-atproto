import { lexicons } from '../src/client/lexicons.js'

const DID = 'did:plc:p4ehtxo7hz6udhijpm4yjmb4'
const EVM_ACCOUNT = 'eip155:8453:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'
const USDC_BASE = 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const POST_REF = {
  uri: `at://${DID}/app.bsky.feed.post/3mxorhjjx5k2t`,
  cid: 'bafyreigq7smi2aj55i3pjorvr43tk2shdgrkem2mngkiy22hz52qgv72km',
}
const createdAt = '2026-10-13T00:00:00.000Z'

function isValid(collection: string, record: Record<string, unknown>) {
  try {
    lexicons.assertValidRecord(collection, { $type: collection, ...record })
    return true
  } catch {
    return false
  }
}

describe('net.krao lexicons', () => {
  it('registers every Krao schema', () => {
    for (const id of [
      'net.krao.chain.defs',
      'net.krao.actor.wallet',
      'net.krao.actor.nftAvatar',
      'net.krao.actor.defs',
      'net.krao.actor.getChainProfiles',
      'net.krao.feed.tip',
      'net.krao.feed.defs',
      'net.krao.feed.getTips',
      'net.krao.gate.rule',
      'net.krao.gate.defs',
      'net.krao.gate.getContent',
      'net.krao.gate.putContent',
      'net.krao.gate.uploadMedia',
      'net.krao.server.getWalletChallenge',
      'net.krao.server.createWalletSession',
    ]) {
      expect(lexicons.get(id)).toBeDefined()
    }
  })

  describe('net.krao.actor.wallet', () => {
    const wallet = {
      account: EVM_ACCOUNT,
      proof: {
        type: 'siwe',
        message: `krao.net wants you to sign in with your Ethereum account:\n0xab16...\n\nURI: ${DID}`,
        signature: '0x' + 'ab'.repeat(65),
      },
      createdAt,
    }

    it('accepts a linked wallet with a proof', () => {
      expect(isValid('net.krao.actor.wallet', wallet)).toBe(true)
    })

    it('rejects a wallet without a proof', () => {
      const { proof: _proof, ...withoutProof } = wallet
      expect(isValid('net.krao.actor.wallet', withoutProof)).toBe(false)
    })
  })

  describe('net.krao.actor.nftAvatar', () => {
    it('accepts an NFT held by a linked wallet', () => {
      expect(
        isValid('net.krao.actor.nftAvatar', {
          nft: {
            chain: 'eip155:1',
            contract: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
            tokenId: '1234',
            standard: 'erc721',
          },
          wallet: EVM_ACCOUNT,
          createdAt,
        }),
      ).toBe(true)
    })

    it('rejects an NFT without a token ID', () => {
      expect(
        isValid('net.krao.actor.nftAvatar', {
          nft: { chain: 'eip155:1', contract: '0xbc4c' },
          wallet: EVM_ACCOUNT,
          createdAt,
        }),
      ).toBe(false)
    })
  })

  describe('net.krao.feed.tip', () => {
    const tip = {
      recipient: DID,
      subject: POST_REF,
      asset: USDC_BASE,
      amount: '5000000',
      txHash: '0x' + '12'.repeat(32),
      createdAt,
    }

    it('accepts a tip on a post', () => {
      expect(isValid('net.krao.feed.tip', tip)).toBe(true)
    })

    it('accepts a tip to an account without a post', () => {
      const { subject: _subject, ...accountTip } = tip
      expect(isValid('net.krao.feed.tip', accountTip)).toBe(true)
    })

    it('rejects a tip without a transaction hash', () => {
      const { txHash: _txHash, ...noTx } = tip
      expect(isValid('net.krao.feed.tip', noTx)).toBe(false)
    })

    it('rejects a non-DID recipient', () => {
      expect(
        isValid('net.krao.feed.tip', { ...tip, recipient: 'alice.test' }),
      ).toBe(false)
    })
  })

  describe('net.krao.gate.rule', () => {
    const rule = {
      subject: POST_REF,
      conditions: [
        {
          $type: 'net.krao.gate.defs#tokenBalance',
          asset: USDC_BASE,
          minAmount: '1000000',
        },
        {
          $type: 'net.krao.gate.defs#nftHolding',
          chain: 'eip155:1',
          contract: '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
        },
      ],
      match: 'any',
      service: 'did:web:gate.krao.net',
      createdAt,
    }

    it('accepts token and NFT conditions', () => {
      expect(isValid('net.krao.gate.rule', rule)).toBe(true)
    })

    it('rejects a rule with no conditions', () => {
      expect(isValid('net.krao.gate.rule', { ...rule, conditions: [] })).toBe(
        false,
      )
    })

    it('rejects more than five conditions', () => {
      const conditions = Array(6).fill(rule.conditions[0])
      expect(isValid('net.krao.gate.rule', { ...rule, conditions })).toBe(false)
    })
  })
})
