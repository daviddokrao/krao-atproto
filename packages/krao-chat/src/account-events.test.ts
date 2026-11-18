import { describe, expect, it } from 'vitest'
import type { IdResolver } from '@atproto/identity'
import { AccountDeletions } from './account-events.js'

describe('AccountDeletions', () => {
  it('keeps a failed cleanup and retries it until it works', async () => {
    let pending: string[] = []
    let failing = true
    const cleaned: string[] = []
    const deletions = new AccountDeletions({
      // Never started: no connection is made
      service: 'ws://localhost:1',
      idResolver: {} as IdResolver,
      getCursor: async () => undefined,
      setCursor: async () => {},
      getPending: async () => pending,
      setPending: async (dids) => {
        pending = dids
      },
      onDeleted: async (did) => {
        if (failing) throw new Error('database busy')
        cleaned.push(did)
      },
    })
    await deletions.cleanUp('did:plc:gone')
    expect(pending).toEqual(['did:plc:gone'])
    await deletions.retryPending()
    expect(pending).toEqual(['did:plc:gone'])
    failing = false
    await deletions.retryPending()
    expect(pending).toEqual([])
    expect(cleaned).toEqual(['did:plc:gone'])
  })
})
