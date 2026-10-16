import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeAbiString, decodeRevertData, eventTopic } from './abi-decode.js'
import { EvmRpc, RPC_REQUEST_MAX_BYTES, RpcError } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import {
  type CallFrame,
  PERMIT2,
  PREVIEW_GAS_CAP,
  PreviewError,
  SELECTORS,
  TOPICS,
  decodeCalldata,
  isUnlimited,
  parseTrace,
  simulateTransaction,
} from './simulate.js'
import { TokenCatalog, USDC } from './token.js'
import { upsertWallet } from './wallets.js'

const BASE = 'eip155:8453'
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const USER = addr(0xaa)
const OTHER = addr(0xbb)
const usdc = USDC.toLowerCase()
const pad = (hex: string | bigint) =>
  (typeof hex === 'bigint' ? hex.toString(16) : hex.replace(/^0x/, ''))
    .toLowerCase()
    .padStart(64, '0')
const MAX = (1n << 256n) - 1n
const call = (sel: string, ...words: (string | bigint)[]) =>
  sel + words.map(pad).join('')
/** An ABI-encoded string return value */
const encodeAbiStringForTest = (text: string) => {
  const bytes = Buffer.from(text, 'utf8').toString('hex')
  return (
    '0x' +
    pad(32n) +
    pad(BigInt(text.length)) +
    bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
  )
}

type Handler = (params: unknown[]) => unknown
function fakeRpc(handlers: Record<string, Handler> = {}) {
  const calls: string[] = []
  return {
    calls,
    rpc: {
      request: async <T>(method: string, params: unknown[]): Promise<T> => {
        calls.push(method)
        const handler = handlers[method]
        if (!handler) {
          throw new RpcError(`${method}: the method does not exist`, -32601)
        }
        return (await handler(params)) as T
      },
      tryCall: async (to: string, data: string) =>
        handlers.tryCall
          ? ((await handlers.tryCall([to, data])) as string)
          : null,
    },
  }
}

let db: Database

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  await new TokenCatalog(db).init()
  await db
    .updateTable('token')
    .set({ priceUsd: '3000' })
    .where('key', '=', 'ETH')
    .execute()
})

afterEach(async () => {
  await db.destroy()
})

const simulate = (
  rpc: ReturnType<typeof fakeRpc>['rpc'],
  input: Partial<Parameters<typeof simulateTransaction>[1]> = {},
  opts: { knownDelegates?: string[]; isUnsafe?: (url: string) => boolean } = {},
) =>
  simulateTransaction(
    { db, rpcs: new Map([[BASE, rpc]]), ...opts },
    { chain: BASE, from: USER, to: OTHER, ...input },
  )

describe('ABI', () => {
  it('has the well-known selectors and topics', () => {
    expect(SELECTORS).toMatchObject({
      transfer: '0xa9059cbb',
      transferFrom: '0x23b872dd',
      approve: '0x095ea7b3',
      increaseAllowance: '0x39509351',
      safeTransferFrom721: '0x42842e0e',
      safeTransferFrom721Data: '0xb88d4fde',
      safeTransferFrom1155: '0xf242432a',
      safeBatchTransferFrom: '0x2eb2c2d6',
      setApprovalForAll: '0xa22cb465',
      permit2Approve: '0x87517c45',
    })
    expect(TOPICS.transfer).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
    expect(TOPICS.approval).toBe(
      '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    )
    expect(TOPICS.approvalForAll).toBe(
      '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
    )
    expect(eventTopic('Transfer(address,address,uint256)')).toBe(
      TOPICS.transfer,
    )
  })

  it('reads strings and revert reasons', () => {
    expect(decodeAbiString(encodeAbiStringForTest('USDC'))).toBe('USDC')
    // bytes32 symbols (eg MKR)
    expect(
      decodeAbiString(
        '0x' + Buffer.from('MKR').toString('hex').padEnd(64, '0'),
      ),
    ).toBe('MKR')
    expect(decodeAbiString('0x')).toBeUndefined()
    expect(
      decodeRevertData(
        '0x08c379a0' + encodeAbiStringForTest('not enough').slice(2),
      ),
    ).toBe('not enough')
    expect(decodeRevertData('0x4e487b71' + pad(0x11n))).toBe('Panic(0x11)')
  })

  it('judges unlimited amounts', () => {
    expect(isUnlimited(MAX)).toBe(true)
    expect(isUnlimited(1n << 255n)).toBe(true)
    expect(isUnlimited(1000n)).toBe(false)
    expect(isUnlimited(1000n, 256, 1000n)).toBe(true)
    expect(isUnlimited((1n << 160n) - 1n, 160)).toBe(true)
    expect(isUnlimited(10n ** 6n, 160)).toBe(false)
  })
})

describe('decoding calldata', () => {
  it('reads transfers, value and approvals', () => {
    expect(
      decodeCalldata({
        from: USER,
        to: usdc,
        data: call(SELECTORS.transfer, OTHER, 5_000_000n),
      }),
    ).toEqual({
      changes: [
        {
          direction: 'out',
          kind: 'erc20',
          token: usdc,
          amount: 5_000_000n,
          counterparty: OTHER,
        },
      ],
      approvals: [],
    })
    expect(
      decodeCalldata({ from: USER, to: OTHER, value: 10n }).changes,
    ).toEqual([
      { direction: 'out', kind: 'native', amount: 10n, counterparty: OTHER },
    ])
    expect(
      decodeCalldata({
        from: USER,
        to: usdc,
        data: call(SELECTORS.approve, OTHER, MAX),
      }).approvals,
    ).toEqual([
      { kind: 'erc20or721', token: usdc, spender: OTHER, amount: MAX },
    ])
    expect(
      decodeCalldata({
        from: USER,
        to: addr(0xcc),
        data: call(SELECTORS.setApprovalForAll, OTHER, 1n),
      }).approvals,
    ).toEqual([
      {
        kind: 'approvalForAll',
        token: addr(0xcc),
        spender: OTHER,
        unlimited: true,
      },
    ])
    // Revoking is not an approval
    expect(
      decodeCalldata({
        from: USER,
        to: addr(0xcc),
        data: call(SELECTORS.setApprovalForAll, OTHER, 0n),
      }).approvals,
    ).toEqual([])
    expect(
      decodeCalldata({
        from: USER,
        to: PERMIT2,
        data: call(SELECTORS.permit2Approve, usdc, OTHER, MAX >> 96n, 0n),
      }).approvals,
    ).toEqual([
      {
        kind: 'permit',
        token: usdc,
        spender: OTHER,
        amount: MAX >> 96n,
        bits: 160,
      },
    ])
  })

  it('reads NFT transfers in both directions', () => {
    const nft = addr(0xcc)
    expect(
      decodeCalldata({
        from: USER,
        to: nft,
        data: call(SELECTORS.safeTransferFrom721, USER, OTHER, 7n),
      }).changes,
    ).toEqual([
      {
        direction: 'out',
        kind: 'erc721',
        token: nft,
        tokenId: 7n,
        counterparty: OTHER,
      },
    ])
    expect(
      decodeCalldata({
        from: USER,
        to: nft,
        data: call(SELECTORS.transferFrom, OTHER, USER, 7n),
      }).changes,
    ).toEqual([
      {
        direction: 'in',
        kind: 'erc20or721',
        token: nft,
        amount: 7n,
        counterparty: OTHER,
      },
    ])
    // safeBatchTransferFrom(from, to, ids, amounts, data)
    const batch =
      SELECTORS.safeBatchTransferFrom +
      [USER, OTHER, 0xa0n, 0x100n, 0x160n, 2n, 1n, 2n, 2n, 10n, 20n, 0n]
        .map(pad)
        .join('')
    expect(
      decodeCalldata({ from: USER, to: nft, data: batch }).changes,
    ).toEqual([
      {
        direction: 'out',
        kind: 'erc1155',
        token: nft,
        tokenId: 1n,
        amount: 10n,
        counterparty: OTHER,
      },
      {
        direction: 'out',
        kind: 'erc1155',
        token: nft,
        tokenId: 2n,
        amount: 20n,
        counterparty: OTHER,
      },
    ])
  })

  it('ignores unknown calls', () => {
    expect(
      decodeCalldata({ from: USER, to: OTHER, data: '0xdeadbeef' + pad(1n) }),
    ).toEqual({ changes: [], approvals: [] })
  })
})

describe('reading traces', () => {
  it('counts value and token events of frames that did not revert', () => {
    const frame: CallFrame = {
      type: 'CALL',
      from: USER,
      to: OTHER,
      value: '0x10',
      gasUsed: '0x5208',
      logs: [
        {
          address: usdc,
          topics: [TOPICS.transfer, '0x' + pad(USER), '0x' + pad(OTHER)],
          data: '0x' + pad(5n),
        },
        {
          address: usdc,
          topics: [TOPICS.approval, '0x' + pad(USER), '0x' + pad(OTHER)],
          data: '0x' + pad(MAX),
        },
      ],
      calls: [
        {
          type: 'CALL',
          from: OTHER,
          to: USER,
          value: '0x3',
        },
        {
          type: 'CALL',
          from: OTHER,
          to: usdc,
          error: 'execution reverted',
          logs: [
            {
              address: usdc,
              topics: [TOPICS.transfer, '0x' + pad(USER), '0x' + pad(OTHER)],
              data: '0x' + pad(1000n),
            },
          ],
        },
        // DELEGATECALL repeats the parent's value; it moves nothing
        { type: 'DELEGATECALL', from: OTHER, to: addr(1), value: '0x10' },
      ],
    }
    const result = parseTrace(frame, USER)
    expect(result.ok).toBe(true)
    expect(result.gasUsed).toBe(21000n)
    expect(result.changes).toEqual([
      { direction: 'out', kind: 'native', amount: 16n, counterparty: OTHER },
      {
        direction: 'out',
        kind: 'erc20',
        token: usdc,
        amount: 5n,
        counterparty: OTHER,
      },
      { direction: 'in', kind: 'native', amount: 3n, counterparty: OTHER },
    ])
    expect(result.approvals).toEqual([
      { kind: 'erc20', token: usdc, spender: OTHER, amount: MAX },
    ])
  })

  it('reports a revert with its reason', () => {
    const result = parseTrace(
      {
        type: 'CALL',
        from: USER,
        to: usdc,
        error: 'execution reverted',
        output: '0x08c379a0' + encodeAbiStringForTest('too much').slice(2),
      },
      USER,
    )
    expect(result).toMatchObject({ ok: false, revertReason: 'too much' })
    expect(result.changes).toEqual([])
  })
})

describe('simulate', () => {
  it('traces an ETH transfer, with its value in dollars', async () => {
    const { rpc } = fakeRpc({
      debug_traceCall: ([tx]) => ({
        type: 'CALL',
        from: USER,
        to: OTHER,
        value: (tx as { value: string }).value,
        gasUsed: '0x5208',
      }),
      eth_getCode: () => '0x',
    })
    const result = await simulate(rpc, { value: (10n ** 18n).toString() })
    expect(result).toEqual({
      ok: true,
      method: 'trace',
      changes: [
        {
          direction: 'out',
          kind: 'native',
          amount: '1000000000000000000',
          counterparty: OTHER,
        },
      ],
      approvals: [],
      warnings: [],
      gasEstimate: '21000',
      usdOut: '3000.00',
    })
  })

  it('decodes when the node cannot trace, and flags unlimited approvals', async () => {
    const { rpc, calls } = fakeRpc({
      eth_call: () => '0x' + pad(1n),
      eth_estimateGas: () => '0xb411',
    })
    const result = await simulate(rpc, {
      to: USDC,
      data: call(SELECTORS.approve, OTHER, MAX),
    })
    expect(calls).toContain('debug_traceCall')
    expect(result).toMatchObject({
      ok: true,
      method: 'decode',
      gasEstimate: '46097',
      approvals: [
        {
          kind: 'erc20',
          token: { address: usdc, symbol: 'USDC', decimals: 6 },
          spender: OTHER,
          amount: MAX.toString(),
          unlimited: true,
        },
      ],
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'unlimitedApproval',
        severity: 'danger',
        address: OTHER,
      }),
    ])
  })

  it('takes token movements from the calldata when the trace has no logs', async () => {
    const { rpc } = fakeRpc({
      // A node that ignores withLog
      debug_traceCall: () => ({
        type: 'CALL',
        from: USER,
        to: usdc,
        gasUsed: '0xb411',
      }),
    })
    const result = await simulate(rpc, {
      to: USDC,
      data: call(SELECTORS.approve, OTHER, MAX),
    })
    expect(result.method).toBe('trace')
    expect(result.approvals).toMatchObject([
      { kind: 'erc20', spender: OTHER, unlimited: true },
    ])
  })

  it('judges approvals against the total supply', async () => {
    const token = addr(0xcc)
    const { rpc } = fakeRpc({
      eth_call: () => '0x',
      eth_getCode: () => '0x6080',
      tryCall: ([, data]) =>
        (data as string).startsWith('0x18160ddd') // totalSupply()
          ? '0x' + pad(1000n)
          : (data as string).startsWith('0x95d89b41') // symbol()
            ? encodeAbiStringForTest('TKN')
            : null,
    })
    const result = await simulate(rpc, {
      to: token,
      data: call(SELECTORS.approve, OTHER, 1000n),
    })
    expect(result.approvals).toEqual([
      {
        kind: 'erc20',
        token: { address: token, symbol: 'TKN' },
        spender: OTHER,
        amount: '1000',
        unlimited: true,
      },
    ])
    expect(result.warnings.map((w) => w.code)).toEqual([
      'unlimitedApproval',
      'unknownContract',
    ])
  })

  it('reports a revert from eth_call', async () => {
    const { rpc } = fakeRpc({
      eth_call: () => {
        throw new RpcError(
          'eth_call: execution reverted: ERC20: transfer amount exceeds balance',
          3,
          '0x08c379a0' +
            encodeAbiStringForTest(
              'ERC20: transfer amount exceeds balance',
            ).slice(2),
        )
      },
    })
    const result = await simulate(rpc, {
      to: USDC,
      data: call(SELECTORS.transfer, OTHER, 10n ** 12n),
    })
    expect(result).toMatchObject({
      ok: false,
      method: 'decode',
      revertReason: 'ERC20: transfer amount exceeds balance',
    })
    expect(result.warnings[0]).toMatchObject({
      code: 'reverts',
      severity: 'danger',
    })
    // What it tried to do is still shown
    expect(result.changes).toMatchObject([
      { direction: 'out', kind: 'erc20', amount: '1000000000000' },
    ])
  })

  it('still decodes when the node is down', async () => {
    const rpc = {
      request: async () => {
        throw new TypeError('fetch failed')
      },
      tryCall: async () => {
        throw new TypeError('fetch failed')
      },
    }
    const result = await simulate(rpc, { value: '0x10' })
    expect(result).toMatchObject({
      ok: false,
      method: 'decode',
      changes: [{ direction: 'out', kind: 'native', amount: '16' }],
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'simulationUnavailable',
        severity: 'warning',
      }),
    ])
  })

  it('warns about EIP-7702 delegations, unknown ones loudest', async () => {
    const { rpc } = fakeRpc({ eth_call: () => '0x', eth_getCode: () => '0x' })
    const delegate = addr(0xdd)
    const unknown = await simulate(rpc, {
      authorizationList: [{ address: delegate, chainId: '8453' }],
    })
    expect(unknown.warnings).toEqual([
      expect.objectContaining({
        code: 'eip7702Delegation',
        severity: 'danger',
        address: delegate,
      }),
    ])
    const known = await simulate(
      rpc,
      { authorizationList: [{ address: delegate }] },
      { knownDelegates: [delegate] },
    )
    expect(known.warnings[0]).toMatchObject({
      code: 'eip7702Delegation',
      severity: 'warning',
    })
  })

  it('warns about unsafe origins and lookalike addresses', async () => {
    const { rpc } = fakeRpc({ eth_call: () => '0x', eth_getCode: () => '0x' })
    const real = '0xabcd000000000000000000000000000000001234'
    const fake = '0xabcd999999999999999999999999999999991234'
    await upsertWallet(db, {
      uri: 'at://did:plc:victim/net.krao.actor.wallet/1',
      did: 'did:plc:victim',
      account: `${BASE}:${real}`,
      accountRaw: `${BASE}:${real}`,
      evmAddress: real,
      label: null,
      status: 'verified',
      reason: null,
      showPrimaryName: 1,
      createdAt: 'x',
      indexedAt: 'x',
    })
    const result = await simulate(
      rpc,
      { to: fake, value: '1', origin: 'https://drainer.test' },
      { isUnsafe: (url) => url.includes('drainer.test') },
    )
    expect(result.warnings.map((w) => [w.code, w.severity])).toEqual([
      ['unsafeOrigin', 'danger'],
      ['lookalikeAddress', 'danger'],
    ])
    expect(result.warnings[1].address).toBe(fake)
  })

  it('tells NFT transfers from token transfers', async () => {
    const nft = addr(0xcc)
    const { rpc } = fakeRpc({
      eth_call: () => '0x',
      eth_getCode: () => '0x6080',
      // supportsInterface(ERC-721)
      tryCall: ([, data]) =>
        (data as string).startsWith('0x01ffc9a7') ? '0x' + pad(1n) : null,
    })
    const result = await simulate(rpc, {
      to: nft,
      data: call(SELECTORS.transferFrom, USER, OTHER, 42n),
    })
    expect(result.changes).toEqual([
      {
        direction: 'out',
        kind: 'erc721',
        token: { address: nft },
        tokenId: '42',
        counterparty: OTHER,
      },
    ])
  })

  it('takes Base only, and well-formed input', async () => {
    const { rpc } = fakeRpc()
    await expect(
      simulateTransaction(
        { db, rpcs: new Map([[BASE, rpc]]) },
        { chain: 'eip155:1', from: USER, to: OTHER },
      ),
    ).rejects.toMatchObject({ code: 'UnsupportedChain' })
    await expect(simulate(rpc, { to: '0x1234' })).rejects.toMatchObject({
      code: 'InvalidAddress',
    })
    await expect(simulate(rpc, { value: '-1' })).rejects.toBeInstanceOf(
      PreviewError,
    )
    await expect(simulate(rpc, { data: '0xzz' })).rejects.toBeInstanceOf(
      PreviewError,
    )
  })

  it('caps the gas and time the node may spend', async () => {
    const seen: unknown[][] = []
    const { rpc } = fakeRpc({
      debug_traceCall: (params) => {
        seen.push(params)
        return { type: 'CALL', from: USER, to: OTHER, gasUsed: '0x5208' }
      },
      eth_getCode: () => '0x',
    })
    await simulate(rpc, { value: '1' })
    const [tx, , config] = seen[0] as [
      { gas: string },
      string,
      { timeout: string },
    ]
    expect(BigInt(tx.gas)).toBe(PREVIEW_GAS_CAP)
    expect(config.timeout).toBe('5s')
  })

  it('keeps contract-made text within the output limits', async () => {
    const token = addr(0xcc)
    const longText = 'ệ'.repeat(300)
    const { rpc } = fakeRpc({
      // A token whose symbol and name are long multi-byte strings
      debug_traceCall: () => ({
        type: 'CALL',
        from: USER,
        to: token,
        gasUsed: '0x5208',
        logs: [
          {
            address: token,
            topics: [TOPICS.approval, '0x' + pad(USER), '0x' + pad(OTHER)],
            data: '0x' + pad(MAX),
          },
        ],
      }),
      eth_getCode: () => '0x6080',
      tryCall: ([, data]) =>
        (data as string).startsWith('0x95d89b41') || // symbol()
        (data as string).startsWith('0x06fdde03') // name()
          ? encodeAbiStringForTest(longText)
          : null,
    })
    const result = await simulate(rpc, { to: token })
    const info = result.approvals[0].token
    expect(Buffer.byteLength(info.symbol!)).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(info.name!)).toBeLessThanOrEqual(256)
    expect(result.warnings[0]).toMatchObject({ code: 'unlimitedApproval' })
    // A revert with a long reason
    const { rpc: reverting } = fakeRpc({
      debug_traceCall: () => ({
        type: 'CALL',
        from: USER,
        to: OTHER,
        error: 'execution reverted',
        revertReason: longText,
      }),
      eth_getCode: () => '0x',
    })
    const reverted = await simulate(reverting, {})
    expect(Buffer.byteLength(reverted.revertReason!)).toBeLessThanOrEqual(1000)
    expect(
      Buffer.byteLength(reverted.warnings[0].message!),
    ).toBeLessThanOrEqual(1000)
  })

  it('warns when the account is already delegated to an unknown contract', async () => {
    const delegate = addr(0xdd)
    const code = (address: unknown) =>
      address === USER ? '0xef0100' + delegate.slice(2) : '0x'
    const traced = fakeRpc({
      debug_traceCall: () => ({
        type: 'CALL',
        from: USER,
        to: OTHER,
        gasUsed: '0x5208',
      }),
      eth_getCode: ([address]) => code(address),
    })
    expect((await simulate(traced.rpc, { value: '1' })).warnings).toEqual([
      expect.objectContaining({
        code: 'eip7702Delegation',
        severity: 'warning',
        address: delegate,
      }),
    ])
    // Only decoded: what the delegate's code does is not seen
    const decoded = fakeRpc({
      eth_call: () => '0x',
      eth_getCode: ([address]) => code(address),
    })
    expect((await simulate(decoded.rpc, { value: '1' })).warnings).toEqual([
      expect.objectContaining({
        code: 'eip7702Delegation',
        severity: 'danger',
        address: delegate,
      }),
    ])
    // A delegate Krao trusts
    expect(
      (
        await simulate(
          decoded.rpc,
          { value: '1' },
          { knownDelegates: [delegate] },
        )
      ).warnings,
    ).toEqual([])
  })
})

describe('EvmRpc.request', () => {
  it('refuses answers that are too large', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: 'x'.repeat(RPC_REQUEST_MAX_BYTES),
        }),
      )
    })
    server.listen(0)
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    try {
      const rpc = new EvmRpc(`http://127.0.0.1:${port}`)
      await expect(rpc.request('debug_traceCall', [])).rejects.toThrow(
        /too large/,
      )
    } finally {
      server.close()
    }
  })
})
