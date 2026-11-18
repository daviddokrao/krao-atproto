import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IdResolver } from '@atproto/identity'
import { type Database, createDb, migrateDb } from './db.js'
import { createApp } from './server.js'
import { RewardsService } from './service.js'

const TOKEN = 'internal-token-for-tests-0123456789'

let db: Database
let service: RewardsService
let server: http.Server
let base: string

beforeEach(async () => {
  db = createDb(':memory:')
  await migrateDb(db)
  service = new RewardsService(db)
  await service.seedRules()
  const app = createApp({
    service,
    // Only user-authenticated XRPC methods resolve DIDs; not used here
    idResolver: {} as IdResolver,
    serviceDid: 'did:web:rewards.test',
    internalToken: TOKEN,
    adminDids: new Set(),
    kycReviewerDids: new Set(),
    kycProvider: null,
    manualReview: { dailyLimit: 10, requireSecondApprover: false },
  })
  server = app.listen(0)
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await db.destroy()
})

const internal = (path: string, init: RequestInit = {}, token = TOKEN) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })

describe('rewards HTTP routes', () => {
  it('answers health checks after checking the database', async () => {
    const res = await fetch(`${base}/_health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('guards the PDS routes with the shared token', async () => {
    const res = await internal('/internal/check-code?code=X', {}, 'wrong')
    expect(res.status).toBe(401)
    const none = await fetch(`${base}/internal/check-code?code=X`)
    expect(none.status).toBe(401)
  })

  it('checks codes for the PDS without the public rate limit', async () => {
    const code = await service.personalCode('did:plc:alice')
    for (let i = 0; i < 35; i++) {
      const res = await internal(`/internal/check-code?code=${code}`)
      expect(await res.json()).toEqual({ valid: true })
    }
  })

  it('rate limits the public code check', async () => {
    let limited = 0
    for (let i = 0; i < 35; i++) {
      const res = await fetch(
        `${base}/xrpc/net.krao.referral.checkCode?code=NOPE-NOPE`,
      )
      if (res.status === 429) limited++
    }
    expect(limited).toBe(5)
  })

  it('records a referral from the PDS outbox and refuses bad input', async () => {
    const code = await service.personalCode('did:plc:alice')
    const ok = await internal('/internal/referrals', {
      method: 'POST',
      body: JSON.stringify({
        did: 'did:plc:bob',
        code,
        createdAt: new Date().toISOString(),
      }),
    })
    expect(ok.status).toBe(200)
    const bad = await internal('/internal/referrals', {
      method: 'POST',
      body: JSON.stringify({ did: 'bob', code }),
    })
    expect(bad.status).toBe(400)
  })

  it('answers malformed JSON with a 400, not a 500', async () => {
    const res = await internal('/internal/takedowns', {
      method: 'POST',
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })
})
