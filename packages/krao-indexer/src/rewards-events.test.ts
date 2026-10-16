import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  type AccountEvent,
  RewardsEventsClient,
  deleteAccountEventsForDid,
  deliverAccountEvents,
  queueAccountEvent,
  queueWalletLinked,
} from './rewards-events.js'

describe('rewards events outbox', () => {
  let db: Database

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('queues each event once per account, even after it was sent', async () => {
    const sent: string[] = []
    const sender = {
      send: async (type: AccountEvent, did: string) => {
        sent.push(`${type}:${did}`)
      },
    }
    expect(await queueAccountEvent(db, 'wallet.linked', 'did:a')).toBe(true)
    expect(await queueAccountEvent(db, 'wallet.linked', 'did:a')).toBe(false)
    expect(await queueAccountEvent(db, 'post.first', 'did:a')).toBe(true)
    await deliverAccountEvents(db, sender)
    // Unlink and relink, delete and post again: nothing new
    expect(await queueAccountEvent(db, 'wallet.linked', 'did:a')).toBe(false)
    expect(await queueAccountEvent(db, 'post.first', 'did:a')).toBe(false)
    await deliverAccountEvents(db, sender)
    expect(sent.sort()).toEqual(['post.first:did:a', 'wallet.linked:did:a'])
  })

  it('retries failed deliveries later, waiting longer each time', async () => {
    let up = false
    const sent: string[] = []
    const sender = {
      send: async (type: AccountEvent, did: string) => {
        if (!up) throw new Error('rewards down')
        sent.push(`${type}:${did}`)
      },
    }
    await queueAccountEvent(db, 'post.first', 'did:a')
    await deliverAccountEvents(db, sender, Date.now())
    const failed = await db
      .selectFrom('rewards_outbox')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(failed).toMatchObject({ attempts: 1, sentAt: null })
    expect(failed.error).toContain('rewards down')
    up = true
    // Not due yet
    await deliverAccountEvents(db, sender, Date.now())
    expect(sent).toEqual([])
    await deliverAccountEvents(db, sender, Date.now() + 60_000)
    expect(sent).toEqual(['post.first:did:a'])
  })

  it('forgets a deleted account', async () => {
    await queueAccountEvent(db, 'post.first', 'did:a')
    await deleteAccountEventsForDid(db, 'did:a')
    expect(await db.selectFrom('rewards_outbox').selectAll().execute()).toEqual(
      [],
    )
  })

  it('posts events to the rewards service with the internal token', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const client = new RewardsEventsClient(
      'http://rewards.test',
      'secret',
      (async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), init })
        return new Response('{}', { status: calls.length === 1 ? 200 : 503 })
      }) as unknown as typeof fetch,
    )
    await client.send('wallet.linked', 'did:a')
    expect(calls[0].url).toBe('http://rewards.test/internal/events')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      type: 'wallet.linked',
      did: 'did:a',
    })
    expect(
      (calls[0].init.headers as Record<string, string>).authorization,
    ).toBe('Bearer secret')
    await expect(client.send('post.first', 'did:a')).rejects.toThrow(/503/)
  })
  it('rewards a wallet once, even when relinked to other accounts', async () => {
    expect(await queueWalletLinked(db, 'did:a', '0xw')).toBe(true)
    // did:a unlinks it, did:b links it: nothing for did:b
    expect(await queueWalletLinked(db, 'did:b', '0xw')).toBe(false)
    // did:a deleted and recreated as did:c with the same wallet: nothing
    await deleteAccountEventsForDid(db, 'did:a')
    expect(await queueWalletLinked(db, 'did:c', '0xw')).toBe(false)
    // did:b's own new wallet still counts, once
    expect(await queueWalletLinked(db, 'did:b', '0xv')).toBe(true)
    expect(await queueWalletLinked(db, 'did:b', '0xu')).toBe(false)
    // 0xu earned nothing, so another account may still be rewarded for it
    expect(await queueWalletLinked(db, 'did:d', '0xu')).toBe(true)
  })
})
