import { secp256k1 } from '@noble/curves/secp256k1'
import * as ui8 from 'uint8arrays'
import {
  COINBASE_SMART_WALLET_FACTORY,
  DEPLOYLESS_CHECK_LENGTH,
  ERC1271_MAGIC_VALUE,
  type EvmJsonRpc,
  RpcResponseError,
  RpcTransportError,
  bytesToHex,
  coinbaseCreateAccountCalldata,
  coinbaseGetAddressCalldata,
  coinbaseReplaySafeHash,
  coinbaseSignature,
  coinbaseUndeployedSignature,
  evmAddressFromPublicKey,
  formatSignInMessage,
  functionSelector,
  hashEvmMessage,
  hexToBytes,
  httpJsonRpc,
  readAddress,
  readBytes,
  uintWord,
  unwrapErc6492Signature,
  verifyEvmHashSignature,
  verifyWalletProof,
  wrapErc6492Signature,
} from '../src/index.js'

const DID = 'did:plc:p4ehtxo7hz6udhijpm4yjmb4'

function owner(hexKey?: string) {
  const key = hexKey
    ? ui8.fromString(hexKey, 'base16')
    : secp256k1.utils.randomPrivateKey()
  const address = evmAddressFromPublicKey(secp256k1.getPublicKey(key, false))
  /** Raw ECDSA over a 32 byte hash (eth_sign / signTypedData style) */
  const signHash = (hash: Uint8Array) => {
    const s = secp256k1.sign(hash, key)
    return ui8.concat([
      s.toCompactRawBytes(),
      new Uint8Array([s.recovery + 27]),
    ])
  }
  return { address, signHash }
}

/**
 * A pretend chain with one kind of wallet contract: valid when its owner
 * signed the replay-safe hash (Coinbase Smart Wallet style), deployed from
 * the Coinbase factory address. Wallets in `deployed` have code; the
 * deployless check deploys `undeployed` ones in the simulation.
 */
function mockChain(opts: {
  chainId?: number
  wallets: Record<string, string> // wallet address -> owner address
  deployed: Set<string>
  /** EIP-7702 accounts: code delegating to a wallet implementation */
  delegated?: Record<string, string> // account -> owner
}) {
  const chainId = opts.chainId ?? 8453
  const calls: string[] = []
  const isValid = (wallet: string, data: Uint8Array): string => {
    const selector = bytesToHex(data.slice(0, 4))
    if (
      selector !==
      bytesToHex(functionSelector('isValidSignature(bytes32,bytes)'))
    ) {
      throw new RpcResponseError('execution reverted', 3)
    }
    const args = data.slice(4)
    const hash = args.slice(0, 32)
    const sigWrapper = readBytes(args, 32)
    // abi.decode(sig, (SignatureWrapper)): tuple at offset 0
    const tuple = sigWrapper.slice(32)
    const ownerSig = readBytes(tuple, 32)
    const walletOwner =
      opts.wallets[wallet] ?? opts.delegated?.[wallet] ?? undefined
    if (!walletOwner) throw new RpcResponseError('execution reverted', 3)
    const safe = coinbaseReplaySafeHash({ hash, wallet, chainId })
    let ok = false
    try {
      const sig = secp256k1.Signature.fromCompact(
        ownerSig.slice(0, 64),
      ).addRecoveryBit(ownerSig[64] - 27)
      ok =
        evmAddressFromPublicKey(
          sig.recoverPublicKey(safe).toRawBytes(false),
        ) === walletOwner
    } catch {
      ok = false
    }
    return ok
      ? ERC1271_MAGIC_VALUE + '0'.repeat(56)
      : '0xffffffff' + '0'.repeat(56)
  }
  const rpc: EvmJsonRpc = async (method, params) => {
    const deployless =
      method === 'eth_call' && !(params[0] as { to?: string }).to
    calls.push(deployless ? 'deployless eth_call' : method)
    if (method === 'eth_getCode') {
      const address = (params[0] as string).toLowerCase()
      if (opts.delegated?.[address]) return '0xef0100' + '11'.repeat(20)
      return opts.deployed.has(address) ? '0x6080' : '0x'
    }
    if (method === 'eth_call') {
      const tx = params[0] as { to?: string; data: string }
      const data = hexToBytes(tx.data)
      if (tx.to) {
        const to = tx.to.toLowerCase()
        if (!opts.deployed.has(to) && !opts.delegated?.[to]) return '0x'
        return isValid(to, data)
      }
      // Deployless check: our init code, then its arguments
      const args = data.slice(DEPLOYLESS_CHECK_LENGTH)
      const factory = readAddress(args, 0)
      const wallet = readAddress(args, 32)
      const n = Number(BigInt(bytesToHex(args.slice(64, 96))))
      const m = Number(BigInt(bytesToHex(args.slice(96, 128))))
      const factoryCalldata = bytesToHex(args.slice(128, 128 + n))
      const check = args.slice(128 + n, 128 + n + m)
      const deploys =
        factory === COINBASE_SMART_WALLET_FACTORY.toLowerCase() &&
        factoryCalldata ===
          coinbaseCreateAccountCalldata([opts.wallets[wallet] ?? '0x00'], 0)
      let word = '0'.repeat(64)
      let size = 0
      let success = deploys
      if (deploys) {
        try {
          word = isValid(wallet, check).slice(2)
          size = 32
        } catch {
          success = false
        }
      }
      return (
        '0x' +
        bytesToHex(uintWord(success ? 1 : 0)).slice(2) +
        bytesToHex(uintWord(size)).slice(2) +
        word
      )
    }
    throw new Error(`unexpected ${method}`)
  }
  return { rpc, calls }
}

function linkMessage(address: string) {
  return formatSignInMessage({
    domain: 'krao.net',
    chain: 'Ethereum',
    address,
    statement: 'Link this wallet to my Krao account.',
    uri: DID,
    version: '1',
    chainId: '8453',
    nonce: 'abc123def456',
    issuedAt: '2026-10-16T00:00:00.000Z',
    resources: [],
  })
}

const WALLET = '0x' + 'ab'.repeat(20)

describe('ABI and Coinbase fixtures', () => {
  it('computes the ERC-1271 selector', () => {
    expect(
      bytesToHex(functionSelector('isValidSignature(bytes32,bytes)')),
    ).toBe(ERC1271_MAGIC_VALUE)
  })

  it('encodes the Coinbase factory calls', () => {
    const o = '0x' + '12'.repeat(20)
    // createAccount(bytes[],uint256) and getAddress(bytes[],uint256)
    expect(coinbaseCreateAccountCalldata([o], 0)).toBe(
      '0x3ffba36f' +
        '40'.padStart(64, '0') + // owners offset
        '0'.repeat(64) + // nonce
        '1'.padStart(64, '0') + // one owner
        '20'.padStart(64, '0') + // its offset
        '20'.padStart(64, '0') + // 32 bytes
        o.slice(2).padStart(64, '0'),
    )
    expect(coinbaseGetAddressCalldata([o], 0).slice(0, 10)).toBe('0x250b1b41')
  })

  it('wraps and unwraps ERC-6492 signatures', () => {
    const wrapped = wrapErc6492Signature({
      factory: COINBASE_SMART_WALLET_FACTORY,
      factoryCalldata: '0xdeadbeef',
      signature: '0x' + '07'.repeat(65),
    })
    expect(wrapped.endsWith('6492'.repeat(16))).toBe(true)
    const parts = unwrapErc6492Signature(hexToBytes(wrapped))
    expect(parts.factory).toBe(COINBASE_SMART_WALLET_FACTORY.toLowerCase())
    expect(bytesToHex(parts.factoryCalldata)).toBe('0xdeadbeef')
    expect(bytesToHex(parts.signature)).toBe('0x' + '07'.repeat(65))
  })

  it('encodes the Coinbase signature wrapper', () => {
    const sig = coinbaseSignature({ ownerSignature: '0x' + '01'.repeat(65) })
    expect(sig).toBe(
      '0x' +
        '20'.padStart(64, '0') + // tuple offset
        '0'.repeat(64) + // ownerIndex
        '40'.padStart(64, '0') + // signatureData offset in the tuple
        '41'.padStart(64, '0') + // 65 bytes
        '01'.repeat(65) +
        '0'.repeat(62),
    )
  })
})

describe('verifyEvmHashSignature', () => {
  const hash = hashEvmMessage('hello')

  it('accepts a plain ECDSA signature offline', async () => {
    const o = owner()
    expect(
      await verifyEvmHashSignature({
        address: o.address,
        hash,
        signature: bytesToHex(o.signHash(hash)),
      }),
    ).toBe(true)
  })

  it('does not ask the chain for a plain account', async () => {
    const o = owner()
    const chain = mockChain({ wallets: {}, deployed: new Set() })
    expect(
      await verifyEvmHashSignature({
        address: o.address,
        hash,
        signature: bytesToHex(o.signHash(hash)),
        rpc: chain.rpc,
      }),
    ).toBe(true)
    expect(chain.calls).toEqual([])
  })

  it('rejects a contract wallet signature without an RPC', async () => {
    const o = owner()
    const signature = coinbaseSignature({
      ownerSignature: o.signHash(
        coinbaseReplaySafeHash({ hash, wallet: WALLET, chainId: 8453 }),
      ),
    })
    expect(
      await verifyEvmHashSignature({ address: WALLET, hash, signature }),
    ).toBe(false)
  })

  it('accepts a deployed wallet signature (ERC-1271)', async () => {
    const o = owner()
    const chain = mockChain({
      wallets: { [WALLET]: o.address },
      deployed: new Set([WALLET]),
    })
    const signature = coinbaseSignature({
      ownerSignature: o.signHash(
        coinbaseReplaySafeHash({ hash, wallet: WALLET, chainId: 8453 }),
      ),
    })
    expect(
      await verifyEvmHashSignature({
        address: WALLET,
        hash,
        signature,
        rpc: chain.rpc,
      }),
    ).toBe(true)
    // Another owner, or the replay-safe hash of another chain, fails
    const forged = coinbaseSignature({
      ownerSignature: owner().signHash(
        coinbaseReplaySafeHash({ hash, wallet: WALLET, chainId: 8453 }),
      ),
    })
    const otherChain = coinbaseSignature({
      ownerSignature: o.signHash(
        coinbaseReplaySafeHash({ hash, wallet: WALLET, chainId: 1 }),
      ),
    })
    for (const sig of [forged, otherChain]) {
      expect(
        await verifyEvmHashSignature({
          address: WALLET,
          hash,
          signature: sig,
          rpc: chain.rpc,
        }),
      ).toBe(false)
    }
  })

  it('accepts an undeployed wallet signature (ERC-6492)', async () => {
    const o = owner()
    const chain = mockChain({
      wallets: { [WALLET]: o.address },
      deployed: new Set(),
    })
    const ownerSignature = o.signHash(
      coinbaseReplaySafeHash({ hash, wallet: WALLET, chainId: 8453 }),
    )
    const signature = coinbaseUndeployedSignature({
      owners: [o.address],
      ownerSignature,
    })
    expect(
      await verifyEvmHashSignature({
        address: WALLET,
        hash,
        signature,
        rpc: chain.rpc,
      }),
    ).toBe(true)
    // Unwrapped, it cannot be checked while the wallet has no code
    expect(
      await verifyEvmHashSignature({
        address: WALLET,
        hash,
        signature: coinbaseSignature({ ownerSignature }),
        rpc: chain.rpc,
      }),
    ).toBe(false)
    // A factory call for other owners deploys another wallet
    expect(
      await verifyEvmHashSignature({
        address: WALLET,
        hash,
        signature: coinbaseUndeployedSignature({
          owners: [owner().address],
          ownerSignature,
        }),
        rpc: chain.rpc,
      }),
    ).toBe(false)
  })

  it('checks the inner signature of a wrapped one once deployed', async () => {
    const o = owner()
    const chain = mockChain({
      wallets: { [WALLET]: o.address },
      deployed: new Set([WALLET]),
    })
    const signature = coinbaseUndeployedSignature({
      owners: [o.address],
      ownerSignature: o.signHash(
        coinbaseReplaySafeHash({ hash, wallet: WALLET, chainId: 8453 }),
      ),
    })
    expect(
      await verifyEvmHashSignature({
        address: WALLET,
        hash,
        signature,
        rpc: chain.rpc,
      }),
    ).toBe(true)
    expect(chain.calls).toEqual(['eth_getCode', 'eth_call'])
  })

  it('falls back to ERC-1271 for an EIP-7702 account', async () => {
    const account = owner()
    const delegateOwner = owner()
    const chain = mockChain({
      wallets: {},
      deployed: new Set(),
      delegated: { [account.address]: delegateOwner.address },
    })
    // The account's own key: ecrecover, no chain needed
    expect(
      await verifyEvmHashSignature({
        address: account.address,
        hash,
        signature: bytesToHex(account.signHash(hash)),
        rpc: chain.rpc,
      }),
    ).toBe(true)
    expect(chain.calls).toEqual([])
    // A signature its delegate code accepts
    const signature = coinbaseSignature({
      ownerSignature: delegateOwner.signHash(
        coinbaseReplaySafeHash({
          hash,
          wallet: account.address,
          chainId: 8453,
        }),
      ),
    })
    expect(
      await verifyEvmHashSignature({
        address: account.address,
        hash,
        signature,
        rpc: chain.rpc,
      }),
    ).toBe(true)
  })

  it('treats a revert as invalid and a dead node as an error', async () => {
    const o = owner()
    const reverting: EvmJsonRpc = async (method) => {
      if (method === 'eth_getCode') return '0x6080'
      throw new RpcResponseError('execution reverted', 3)
    }
    const signature = '0x' + '00'.repeat(200)
    expect(
      await verifyEvmHashSignature({
        address: o.address,
        hash,
        signature,
        rpc: reverting,
      }),
    ).toBe(false)
    const dead = httpJsonRpc('http://127.0.0.1:9', { timeoutMs: 2000 })
    await expect(
      verifyEvmHashSignature({
        address: o.address,
        hash,
        signature,
        rpc: dead,
      }),
    ).rejects.toBeInstanceOf(RpcTransportError)
    const limited: EvmJsonRpc = async () => {
      throw new RpcResponseError('rate limited', -32005)
    }
    await expect(
      verifyEvmHashSignature({
        address: o.address,
        hash,
        signature,
        rpc: limited,
      }),
    ).rejects.toBeInstanceOf(RpcResponseError)
  })
})

describe('contract wallets that misbehave', () => {
  const hash = hashEvmMessage('hello')
  const signature = '0x' + '00'.repeat(200)
  const address = '0x' + 'cd'.repeat(20)
  /** A deployed contract whose eth_call fails with `error` */
  const failingCall =
    (error: Error, seen: unknown[] = []): EvmJsonRpc =>
    async (method, params) => {
      if (method === 'eth_getCode') return '0x6080'
      seen.push(params[0])
      throw error
    }

  it('treats any failed execution as an invalid signature', async () => {
    for (const error of [
      new RpcResponseError('execution reverted', 3),
      new RpcResponseError('out of gas', -32000),
      new RpcResponseError('invalid opcode: INVALID', -32000),
      new RpcResponseError('stack underflow', -32000),
      new RpcResponseError('execution timeout', -32015),
      new RpcResponseError('out of gas', -32603),
      new RpcResponseError('something odd', -32000),
    ]) {
      expect(
        await verifyEvmHashSignature({
          address,
          hash,
          signature,
          rpc: failingCall(error),
        }),
      ).toBe(false)
    }
  })

  it('throws only when the node is limited or broken', async () => {
    for (const error of [
      new RpcResponseError('limit exceeded', -32005),
      new RpcResponseError('internal error', -32603),
      new RpcTransportError('eth_call: HTTP 503'),
    ]) {
      await expect(
        verifyEvmHashSignature({
          address,
          hash,
          signature,
          rpc: failingCall(error),
        }),
      ).rejects.toBe(error)
    }
  })

  it('caps the gas of every call', async () => {
    const seen: unknown[] = []
    await verifyEvmHashSignature({
      address,
      hash,
      signature,
      rpc: failingCall(new RpcResponseError('execution reverted', 3), seen),
    })
    expect(seen).toEqual([expect.objectContaining({ gas: '0x2dc6c0' })])
  })

  it('reads HTTP 429 and 5xx as the node being unreachable', async () => {
    for (const status of [429, 502]) {
      const rpc = httpJsonRpc('http://rpc.test', {
        fetch: (async () =>
          Response.json(
            { jsonrpc: '2.0', id: 1, error: { code: 3, message: 'revert' } },
            { status },
          )) as typeof fetch,
      })
      await expect(rpc('eth_call', [])).rejects.toBeInstanceOf(
        RpcTransportError,
      )
    }
  })
})

describe('verifyWalletProof with contract wallets', () => {
  it('links a smart wallet on the RPC chain only', async () => {
    const o = owner()
    const chain = mockChain({
      wallets: { [WALLET]: o.address },
      deployed: new Set([WALLET]),
    })
    const message = linkMessage(WALLET)
    const signature = coinbaseSignature({
      ownerSignature: o.signHash(
        coinbaseReplaySafeHash({
          hash: hashEvmMessage(message),
          wallet: WALLET,
          chainId: 8453,
        }),
      ),
    })
    const proof = { type: 'siwe', message, signature }
    const account = `eip155:8453:${WALLET}`
    expect(
      await verifyWalletProof({
        did: DID,
        account,
        proof,
        rpc: (c) => (c === 'eip155:8453' ? chain.rpc : undefined),
      }),
    ).toEqual({ ok: true })
    expect(
      await verifyWalletProof({
        did: DID,
        account,
        proof,
        rpc: () => undefined,
      }),
    ).toEqual({ ok: false, reason: 'Invalid signature' })
  })
})

/*
 * Against a real chain: set KRAO_TEST_RPC_URL to an Anvil fork of Base
 * (chain id 8453). Read-only: the undeployed wallet is only deployed inside
 * the eth_call simulation.
 */
const RPC_URL = process.env.KRAO_TEST_RPC_URL
const onChain = RPC_URL ? describe : describe.skip
onChain('Coinbase Smart Wallet on a Base fork', () => {
  it('checks an undeployed wallet signature (ERC-6492)', async () => {
    const rpc = httpJsonRpc(RPC_URL!)
    const o = owner()
    const wallet = readAddress(
      hexToBytes(
        (await rpc('eth_call', [
          {
            to: COINBASE_SMART_WALLET_FACTORY,
            data: coinbaseGetAddressCalldata([o.address], 0),
          },
          'latest',
        ])) as string,
      ),
      0,
    )
    expect(await rpc('eth_getCode', [wallet, 'latest'])).toBe('0x')
    const hash = hashEvmMessage(linkMessage(wallet))
    const ownerSignature = o.signHash(
      coinbaseReplaySafeHash({ hash, wallet, chainId: 8453 }),
    )
    const signature = coinbaseUndeployedSignature({
      owners: [o.address],
      ownerSignature,
    })
    expect(
      await verifyEvmHashSignature({ address: wallet, hash, signature, rpc }),
    ).toBe(true)
    const forged = coinbaseUndeployedSignature({
      owners: [o.address],
      ownerSignature: owner().signHash(
        coinbaseReplaySafeHash({ hash, wallet, chainId: 8453 }),
      ),
    })
    expect(
      await verifyEvmHashSignature({
        address: wallet,
        hash,
        signature: forged,
        rpc,
      }),
    ).toBe(false)
  })
})
