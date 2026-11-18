import { ed25519 } from '@noble/curves/ed25519'
import { secp256k1 } from '@noble/curves/secp256k1'
import * as ui8 from 'uint8arrays'
import {
  type SignInMessage,
  evmAddressFromPublicKey,
  formatSignInMessage,
  hashEvmMessage,
  isPublicTestAddress,
  normalizeAccountId,
  parseAccountId,
  parseSignInMessage,
  recoverEvmAddress,
  verifyWalletProof,
} from '../src/index.js'

const DID = 'did:plc:p4ehtxo7hz6udhijpm4yjmb4'
const OTHER_DID = 'did:plc:baoawbqghvolw7wigqrokhus'
const SOLANA_MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

function evmWallet() {
  const privateKey = secp256k1.utils.randomPrivateKey()
  const address = evmAddressFromPublicKey(
    secp256k1.getPublicKey(privateKey, false),
  )
  const sign = (message: string) => {
    const sig = secp256k1.sign(hashEvmMessage(message), privateKey)
    return (
      '0x' +
      ui8.toString(sig.toCompactRawBytes(), 'base16') +
      (sig.recovery + 27).toString(16)
    )
  }
  return { address, sign }
}

function solanaWallet() {
  const privateKey = ed25519.utils.randomPrivateKey()
  const address = ui8.toString(ed25519.getPublicKey(privateKey), 'base58btc')
  const sign = (message: string) =>
    ui8.toString(
      ed25519.sign(ui8.fromString(message, 'utf8'), privateKey),
      'base58btc',
    )
  return { address, sign }
}

function linkMessage(
  overrides: Partial<SignInMessage> & Pick<SignInMessage, 'address'>,
): string {
  return formatSignInMessage({
    domain: 'krao.net',
    chain: 'Ethereum',
    statement: 'Link this wallet to my Krao account.',
    uri: DID,
    version: '1',
    chainId: '8453',
    nonce: 'abc123def456',
    issuedAt: '2026-10-13T00:00:00.000Z',
    resources: [],
    ...overrides,
  })
}

describe('known Ethereum vectors', () => {
  it('hashes messages like personal_sign', () => {
    // ethers.hashMessage('Hello World')
    expect(ui8.toString(hashEvmMessage('Hello World'), 'base16')).toBe(
      'a1de988600a42c4b4ab089b619297c17d53cffae5d5120d82d8a92d0bb3b78f2',
    )
  })

  it('derives addresses from public keys', () => {
    const privateKey = ui8.fromString(
      '0123456789012345678901234567890123456789012345678901234567890123',
      'base16',
    )
    expect(
      evmAddressFromPublicKey(secp256k1.getPublicKey(privateKey, false)),
    ).toBe('0x14791697260e4c9a71f18484c9f997b308e59325')
  })
})

describe('accounts', () => {
  it('parses EVM and Solana CAIP-10 ids', () => {
    expect(
      parseAccountId('eip155:8453:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'),
    ).toMatchObject({
      namespace: 'eip155',
      reference: '8453',
      chainId: 'eip155:8453',
    })
    const sol = solanaWallet()
    expect(
      parseAccountId(`solana:${SOLANA_MAINNET}:${sol.address}`),
    ).toMatchObject({ namespace: 'solana', address: sol.address })
  })

  it('rejects malformed ids', () => {
    for (const id of [
      'eip155:1',
      'eip155:1:0x1234',
      'eip155:01:0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb',
      'cosmos:cosmoshub-4:cosmos1abc',
      'solana:short:abc',
    ]) {
      expect(() => parseAccountId(id)).toThrow()
    }
  })

  it('normalizes EVM address casing', () => {
    expect(
      normalizeAccountId('eip155:1:0xAB16A96D359eC26a11e2C2b3d8f8B8942d5Bfcdb'),
    ).toBe('eip155:1:0xab16a96d359ec26a11e2c2b3d8f8b8942d5bfcdb')
  })
})

describe('sign-in messages', () => {
  it('round-trips through format and parse', () => {
    const msg: SignInMessage = {
      domain: 'krao.net',
      chain: 'Ethereum',
      address: '0xab16a96D359eC26a11e2C2b3d8f8B8942d5Bfcdb',
      statement: 'Sign in to Krao.',
      uri: 'https://pds.krao.net',
      version: '1',
      chainId: '1',
      nonce: 'n0nce',
      issuedAt: '2026-10-13T00:00:00.000Z',
      expirationTime: '2026-10-13T00:10:00.000Z',
      resources: [DID],
    }
    expect(parseSignInMessage(formatSignInMessage(msg))).toEqual(msg)
  })

  it('parses messages without a statement', () => {
    const text = formatSignInMessage({
      domain: 'krao.net',
      chain: 'Solana',
      address: 'abc',
      uri: DID,
      version: '1',
      nonce: 'n',
      issuedAt: '2026-10-13T00:00:00.000Z',
      resources: [],
    })
    expect(parseSignInMessage(text).statement).toBeUndefined()
  })

  it('rejects text that is not a sign-in message', () => {
    expect(() => parseSignInMessage('hello')).toThrow()
  })
})

describe('verifyWalletProof', () => {
  it('accepts a valid EVM link proof', () => {
    const wallet = evmWallet()
    const message = linkMessage({ address: wallet.address })
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: { type: 'siwe', message, signature: wallet.sign(message) },
      }),
    ).toEqual({ ok: true })
  })

  it('recovers the signer address', () => {
    const wallet = evmWallet()
    expect(recoverEvmAddress('hi', wallet.sign('hi'))).toBe(wallet.address)
  })

  it('accepts the DID as a resource instead of the URI', () => {
    const wallet = evmWallet()
    const message = linkMessage({
      address: wallet.address,
      uri: 'https://krao.net',
      resources: [DID],
    })
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: { type: 'siwe', message, signature: wallet.sign(message) },
      }).ok,
    ).toBe(true)
  })

  it('rejects a proof replayed for another DID', () => {
    const wallet = evmWallet()
    const message = linkMessage({ address: wallet.address })
    expect(
      verifyWalletProof({
        did: OTHER_DID,
        account: `eip155:8453:${wallet.address}`,
        proof: { type: 'siwe', message, signature: wallet.sign(message) },
      }),
    ).toEqual({ ok: false, reason: 'Message does not name the DID' })
  })

  it('rejects a signature from another wallet', () => {
    const wallet = evmWallet()
    const attacker = evmWallet()
    const message = linkMessage({ address: wallet.address })
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: { type: 'siwe', message, signature: attacker.sign(message) },
      }),
    ).toEqual({ ok: false, reason: 'Invalid signature' })
  })

  it('rejects a message for a different address or chain', () => {
    const wallet = evmWallet()
    const other = evmWallet()
    const wrongAddress = linkMessage({ address: other.address })
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: {
          type: 'siwe',
          message: wrongAddress,
          signature: wallet.sign(wrongAddress),
        },
      }).ok,
    ).toBe(false)
    const wrongChain = linkMessage({ address: wallet.address, chainId: '1' })
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: {
          type: 'siwe',
          message: wrongChain,
          signature: wallet.sign(wrongChain),
        },
      }),
    ).toEqual({
      ok: false,
      reason: 'Message chain ID does not match the account',
    })
  })

  it('rejects a tampered message', () => {
    const wallet = evmWallet()
    const message = linkMessage({ address: wallet.address })
    const signature = wallet.sign(message)
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: {
          type: 'siwe',
          message: message.replace('abc123def456', 'zzz'),
          signature,
        },
      }).ok,
    ).toBe(false)
  })

  it('accepts a valid Solana link proof and rejects a forged one', () => {
    const wallet = solanaWallet()
    const message = linkMessage({
      chain: 'Solana',
      address: wallet.address,
      chainId: SOLANA_MAINNET,
    })
    const account = `solana:${SOLANA_MAINNET}:${wallet.address}`
    expect(
      verifyWalletProof({
        did: DID,
        account,
        proof: { type: 'siws', message, signature: wallet.sign(message) },
      }),
    ).toEqual({ ok: true })
    expect(
      verifyWalletProof({
        did: DID,
        account,
        proof: {
          type: 'siws',
          message,
          signature: solanaWallet().sign(message),
        },
      }),
    ).toEqual({ ok: false, reason: 'Invalid signature' })
  })

  it('rejects a mismatched proof type', () => {
    const wallet = evmWallet()
    const message = linkMessage({ address: wallet.address })
    expect(
      verifyWalletProof({
        did: DID,
        account: `eip155:8453:${wallet.address}`,
        proof: { type: 'siws', message, signature: wallet.sign(message) },
      }).ok,
    ).toBe(false)
  })
})

describe('public test keys', () => {
  it('flags the Hardhat/Anvil default accounts and nothing else', () => {
    const keys = [
      'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    ]
    for (const key of keys) {
      const address = evmAddressFromPublicKey(
        secp256k1.getPublicKey(ui8.fromString(key, 'base16'), false),
      )
      expect(isPublicTestAddress(address)).toBe(true)
      expect(
        isPublicTestAddress(address.toUpperCase().replace('0X', '0x')),
      ).toBe(true)
    }
    expect(isPublicTestAddress(evmWallet().address)).toBe(false)
  })
})
