import { describe, expect, it } from 'vitest'
import { RewardsHumanCheck } from './human.js'

describe('RewardsHumanCheck', () => {
  it('asks the rewards service with its token and caches answers', async () => {
    const calls: string[] = []
    let status = 200
    const fetchFn = (async (url: URL, init: RequestInit) => {
      calls.push(
        `${url.pathname}${url.search} ${(init.headers as Record<string, string>).authorization}`,
      )
      return new Response(
        JSON.stringify({ human: url.searchParams.get('did') === 'did:plc:a' }),
        { status },
      )
    }) as unknown as typeof fetch
    const check = new RewardsHumanCheck('http://rewards', 'secret', fetchFn)
    expect(await check.isHuman('did:plc:a')).toBe(true)
    expect(await check.isHuman('did:plc:a')).toBe(true)
    expect(await check.isHuman('did:plc:b')).toBe(false)
    expect(calls).toEqual([
      '/internal/human-status?did=did%3Aplc%3Aa Bearer secret',
      '/internal/human-status?did=did%3Aplc%3Ab Bearer secret',
    ])
    // Errors are not answers
    status = 502
    await expect(check.isHuman('did:plc:c')).rejects.toThrow()
  })
})
