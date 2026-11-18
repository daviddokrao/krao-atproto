import { afterEach, describe, expect, it, vi } from 'vitest'
import { Appview } from './appview.js'

/** Stubs the global fetch with an AppView knowing `known()` at call time */
const stubAppview = (known: () => string[], calls: string[][]) =>
  vi.stubGlobal('fetch', async (url: URL) => {
    const actors = url.searchParams.getAll('actors')
    calls.push(actors)
    const profiles = actors
      .filter((did) => known().includes(did))
      .map((did) => ({ did, handle: `${did.slice(8)}.test` }))
    return new Response(JSON.stringify({ profiles }))
  })

describe('Appview profile cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps a found profile for a while', async () => {
    const calls: string[][] = []
    stubAppview(() => ['did:plc:ana'], calls)
    const appview = new Appview('http://appview.test')
    expect((await appview.getProfile('did:plc:ana'))?.did).toBe('did:plc:ana')
    expect((await appview.getProfile('did:plc:ana'))?.did).toBe('did:plc:ana')
    expect(calls).toHaveLength(1)
  })

  it('finds a brand-new account seconds after a miss', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const known: string[] = []
    stubAppview(() => known, [])
    const appview = new Appview('http://appview.test')
    expect(await appview.getProfile('did:plc:cam')).toBeNull()
    known.push('did:plc:cam') // the AppView indexes the sign-up
    expect(await appview.getProfile('did:plc:cam')).toBeNull() // still cached
    vi.advanceTimersByTime(3_500)
    expect((await appview.getProfile('did:plc:cam'))?.did).toBe('did:plc:cam')
  })
})
