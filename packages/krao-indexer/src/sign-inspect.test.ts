import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LINK_STATEMENT, formatSignInMessage } from '@krao/wallet'
import { type Database, createDb, migrateDb } from './db.js'
import { inspectSignature, personalMessageText } from './sign-inspect.js'
import { PERMIT2 } from './simulate.js'
import { TokenCatalog, USDC } from './token.js'

const BASE = 'eip155:8453'
const USER = '0x' + 'aa'.padStart(40, '0')
const SPENDER = '0x' + 'bb'.padStart(40, '0')
const MAX160 = ((1n << 160n) - 1n).toString()
const MAX256 = ((1n << 256n) - 1n).toString()
const usdc = USDC.toLowerCase()

let db: Database
const rpc = {
  request: async <T>() => '0x' as T,
  tryCall: async () => null,
}

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  await new TokenCatalog(db).init()
})

afterEach(async () => {
  await db.destroy()
})

const inspect = (
  input: { method: string; payload: string; origin?: string },
  opts: { knownDelegates?: string[] } = {},
) =>
  inspectSignature(
    {
      db,
      rpcs: new Map([[BASE, rpc]]),
      webOrigins: ['https://krao.net'],
      isUnsafe: (url) => url.includes('drainer.test'),
      ...opts,
    },
    { chain: BASE, from: USER, ...input },
  )

const typed = (
  domain: Record<string, unknown>,
  primaryType: string,
  message: Record<string, unknown>,
) => ({
  method: 'eth_signTypedData_v4',
  payload: JSON.stringify({ domain, primaryType, message, types: {} }),
})

const siwe = (domain: string, statement: string) =>
  formatSignInMessage({
    domain,
    chain: 'Ethereum',
    address: '0x' + 'ab'.repeat(20),
    statement,
    uri: 'did:plc:someone',
    version: '1',
    chainId: '8453',
    nonce: 'abcdef1234',
    issuedAt: '2026-10-16T00:00:00.000Z',
    resources: [],
  })

describe('inspectSignature', () => {
  it('reads an unlimited Permit2 permit', async () => {
    const result = await inspect(
      typed(
        { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
        'PermitSingle',
        {
          details: { token: USDC, amount: MAX160, expiration: 0, nonce: 0 },
          spender: SPENDER,
          sigDeadline: 0,
        },
      ),
    )
    expect(result).toMatchObject({
      kind: 'permit2',
      domain: { name: 'Permit2', chainId: '8453', verifyingContract: PERMIT2 },
      approvals: [
        {
          kind: 'permit',
          token: { address: usdc, symbol: 'USDC' },
          spender: SPENDER,
          amount: MAX160,
          unlimited: true,
        },
      ],
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'unlimitedApproval',
        severity: 'danger',
      }),
    ])
  })

  it('reads Permit2 batches and transfers', async () => {
    const batch = await inspect(
      typed({ name: 'Permit2', chainId: '8453' }, 'PermitBatch', {
        details: [
          { token: USDC, amount: '5000000' },
          { token: SPENDER, amount: MAX160 },
        ],
        spender: SPENDER,
      }),
    )
    expect(batch.approvals.map((a) => a.unlimited)).toEqual([false, true])
    const transfer = await inspect(
      typed({ name: 'Permit2', chainId: 8453 }, 'PermitTransferFrom', {
        permitted: { token: USDC, amount: '1000000' },
        spender: SPENDER,
      }),
    )
    expect(transfer.approvals).toMatchObject([
      { kind: 'permit', amount: '1000000', unlimited: false },
    ])
    expect(transfer.warnings).toEqual([])
  })

  it('reads EIP-2612 and DAI permits', async () => {
    const limited = await inspect(
      typed(
        { name: 'USD Coin', chainId: 8453, verifyingContract: USDC },
        'Permit',
        { owner: USER, spender: SPENDER, value: '5000000', nonce: 0 },
      ),
    )
    expect(limited).toMatchObject({
      kind: 'permit',
      approvals: [{ amount: '5000000', unlimited: false }],
      warnings: [],
    })
    const unlimited = await inspect(
      typed(
        { name: 'USD Coin', chainId: 8453, verifyingContract: USDC },
        'Permit',
        { owner: USER, spender: SPENDER, value: MAX256 },
      ),
    )
    expect(unlimited.warnings[0]).toMatchObject({ code: 'unlimitedApproval' })
    const dai = await inspect(
      typed({ name: 'Dai', chainId: 8453, verifyingContract: USDC }, 'Permit', {
        holder: USER,
        spender: SPENDER,
        allowed: true,
      }),
    )
    expect(dai.approvals).toMatchObject([{ kind: 'permit', unlimited: true }])
  })

  it('flags marketplace orders', async () => {
    const result = await inspect(
      typed({ name: 'Seaport', chainId: 8453 }, 'OrderComponents', {
        offerer: USER,
        offer: [],
        consideration: [],
      }),
    )
    expect(result.kind).toBe('order')
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'marketplaceOrder', severity: 'danger' }),
    ])
  })

  it('flags EIP-7702 authorizations', async () => {
    const delegate = '0x' + 'dd'.padStart(40, '0')
    const result = await inspect(
      typed({ name: 'x', chainId: 8453 }, 'Authorization', {
        chainId: 8453,
        address: delegate,
        nonce: 0,
      }),
    )
    expect(result.kind).toBe('eip7702Authorization')
    expect(result.warnings[0]).toMatchObject({
      code: 'eip7702Delegation',
      severity: 'danger',
      address: delegate,
    })
  })

  it('warns when typed data names another chain', async () => {
    const result = await inspect(
      typed({ name: 'App', chainId: 1 }, 'Mail', { contents: 'hi' }),
    )
    expect(result.kind).toBe('typedData')
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'chainMismatch', severity: 'warning' }),
    ])
  })

  it('reads a plain message without alarm', async () => {
    const result = await inspect({
      method: 'personal_sign',
      payload: 'Tôi bỏ phiếu cho lựa chọn A',
      origin: 'https://vote.example.com',
    })
    expect(result).toEqual({
      kind: 'message',
      summary: 'Tôi bỏ phiếu cho lựa chọn A',
      approvals: [],
      warnings: [],
    })
    // The same, as hex
    const hex = await inspect({
      method: 'personal_sign',
      payload: '0x' + Buffer.from('hello').toString('hex'),
    })
    expect(hex.summary).toBe('hello')
  })

  it('warns about signing bytes that are not text', async () => {
    const result = await inspect({
      method: 'personal_sign',
      payload: '0x' + 'ff00'.repeat(16),
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'blindSignature', severity: 'warning' }),
    ])
    expect(personalMessageText('0x' + 'ff'.repeat(4))).toBeUndefined()
  })

  it("flags Krao's wallet proofs asked for by another site", async () => {
    const proof = siwe('krao.net', LINK_STATEMENT)
    const fromApp = await inspect({
      method: 'personal_sign',
      payload: proof,
      origin: 'https://vote.example.com',
    })
    expect(fromApp.kind).toBe('loginProof')
    expect(fromApp.warnings).toEqual([
      expect.objectContaining({
        code: 'walletProofPhishing',
        severity: 'danger',
      }),
    ])
    // Krao itself asking is fine
    const fromKrao = await inspect({ method: 'personal_sign', payload: proof })
    expect(fromKrao.warnings).toEqual([])
    // Another site's sign-in message for a third domain
    const other = await inspect({
      method: 'personal_sign',
      payload: siwe('other.example', 'Sign in'),
      origin: 'https://vote.example.com',
    })
    expect(other.kind).toBe('message')
    expect(other.warnings[0]).toMatchObject({ code: 'walletProofPhishing' })
  })

  it('flags unsafe origins', async () => {
    const result = await inspect({
      method: 'personal_sign',
      payload: 'hi',
      origin: 'https://drainer.test',
    })
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'unsafeOrigin', severity: 'danger' }),
    ])
  })

  it('refuses malformed requests', async () => {
    await expect(
      inspect({ method: 'eth_signTypedData_v4', payload: '{not json' }),
    ).rejects.toMatchObject({ code: 'InvalidPayload' })
    await expect(
      inspect({ method: 'eth_sign', payload: '0x00' }),
    ).rejects.toMatchObject({ code: 'InvalidRequest' })
  })
})
