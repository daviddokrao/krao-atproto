import { describe, expect, it } from 'vitest'
import { PhoneGate } from './phone-gate.js'

const gate = (answers: Record<string, boolean>, calls: string[] = []) =>
  new PhoneGate(
    {
      rewardsUrl: 'http://rewards.test',
      token: 't'.repeat(32),
      required: true,
    },
    (async (url: URL) => {
      const did = url.searchParams.get('did') ?? ''
      calls.push(did)
      if (!(did in answers)) throw new Error('unreachable')
      return new Response(JSON.stringify({ verified: answers[did] }))
    }) as unknown as typeof fetch,
  )

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => 'none',
    (err: { customErrorName?: string; type?: number }) =>
      err.customErrorName ?? String(err.type),
  )

describe('PhoneGate', () => {
  it('lets verified accounts send and stops the others', async () => {
    const g = gate({ 'did:plc:ok': true, 'did:plc:no': false })
    expect(await errorOf(g.assertVerified('did:plc:ok'))).toBe('none')
    expect(await errorOf(g.assertVerified('did:plc:no'))).toBe(
      'PhoneVerificationRequired',
    )
  })

  it('asks the rewards service once while the answer is cached', async () => {
    const calls: string[] = []
    const g = gate({ 'did:plc:ok': true }, calls)
    await g.assertVerified('did:plc:ok')
    await g.assertVerified('did:plc:ok')
    expect(calls).toEqual(['did:plc:ok'])
  })

  it('fails closed when the rewards service cannot be reached', async () => {
    const g = gate({})
    expect(await errorOf(g.assertVerified('did:plc:any'))).toBe('502')
  })

  it('checks nothing when off', async () => {
    const calls: string[] = []
    const g = gate({}, calls)
    g.cfg.required = false
    expect(await errorOf(g.assertVerified('did:plc:any'))).toBe('none')
    expect(calls).toEqual([])
  })
})
