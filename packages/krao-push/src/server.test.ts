import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Struct } from '@bufbuild/protobuf'
import { ConnectError, createPromiseClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppviewClient } from './appview.js'
import { type Database, createDb, migrateDb } from './db.js'
import { Service } from './proto/courier_connect.js'
import { AppPlatform } from './proto/courier_pb.js'
import { FcmSender, LogSender } from './senders.js'
import { createApp } from './server.js'
import { PushService } from './service.js'

const COURIER_KEY = 'courier-key-courier-key-courier-key'
const INTERNAL = 'internal-token-internal-token-internal'

const appview = {
  profiles: async (dids: string[]) =>
    new Map(
      dids.map((did) => [
        did,
        { did, handle: 'alice.krao.test', displayName: 'Alice' },
      ]),
    ),
  postTexts: async () => new Map(),
} as unknown as AppviewClient

describe('krao-push server', () => {
  let db: Database
  let server: http.Server
  let base: string
  let ios: LogSender
  let android: LogSender

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    ios = new LogSender('ios')
    android = new LogSender('android')
    const push = new PushService(db, { ios, android })
    const app = createApp(push, appview, {
      courierKey: COURIER_KEY,
      internalToken: INTERNAL,
      logSenders: [ios, android],
    })
    server = app.listen(0)
    await once(server, 'listening')
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    server.close()
    await db.destroy()
  })

  const courier = (key = COURIER_KEY) =>
    createPromiseClient(
      Service,
      createConnectTransport({
        baseUrl: base,
        httpVersion: '1.1',
        interceptors: [
          (next) => (req) => {
            req.header.set('authorization', `Bearer ${key}`)
            return next(req)
          },
        ],
      }),
    )

  const notify = (body: unknown, token = INTERNAL) =>
    fetch(`${base}/internal/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

  it('registers and unregisters device tokens for the AppView', async () => {
    const client = courier()
    await client.registerDeviceToken({
      did: 'did:example:bob',
      token: 'tok-1',
      appId: 'io.krao.app',
      platform: AppPlatform.IOS,
    })
    await client.registerDeviceToken({
      did: 'did:example:bob',
      token: 'tok-1',
      appId: 'io.krao.app',
      platform: AppPlatform.IOS,
      ageRestricted: true,
    })
    let rows = await db.selectFrom('device_token').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ platform: 'ios', ageRestricted: 1 })
    await client.unregisterDeviceToken({
      did: 'did:example:bob',
      token: 'tok-1',
    })
    rows = await db.selectFrom('device_token').selectAll().execute()
    expect(rows).toHaveLength(0)
  })

  it('refuses a wrong courier key', async () => {
    await expect(
      courier('wrong').registerDeviceToken({
        did: 'did:example:bob',
        token: 'tok-1',
        appId: 'io.krao.app',
        platform: AppPlatform.ANDROID,
      }),
    ).rejects.toBeInstanceOf(ConnectError)
    expect(await db.selectFrom('device_token').selectAll().execute()).toEqual(
      [],
    )
  })

  it('passes the AppView read-state sync on silently', async () => {
    const client = courier()
    await client.registerDeviceToken({
      did: 'did:example:bob',
      token: 'tok-a',
      appId: 'io.krao.app',
      platform: AppPlatform.ANDROID,
    })
    const n = {
      id: 'n1',
      recipientDid: 'did:example:bob',
      clientControlled: true,
      collapseKey: 'mark-read-generic',
      additional: Struct.fromJson({ reason: 'mark-read-generic' }),
    }
    await client.pushNotifications({ notifications: [n] })
    await client.pushNotifications({ notifications: [n] })
    expect(android.recent).toHaveLength(1)
    expect(android.recent[0].msg).toMatchObject({
      silent: true,
      data: { reason: 'mark-read-generic', recipientDid: 'did:example:bob' },
    })
  })

  it('pushes Krao events once, to every device of the recipients', async () => {
    const client = courier()
    for (const [token, platform] of [
      ['phone', AppPlatform.IOS],
      ['tablet', AppPlatform.ANDROID],
    ] as const) {
      await client.registerDeviceToken({
        did: 'did:example:bob',
        token,
        appId: 'io.krao.app',
        platform,
      })
    }
    const evt = {
      kind: 'chat',
      id: 'm1',
      recipientDids: ['did:example:bob', 'did:example:nodevice'],
      senderDid: 'did:example:alice',
      convoId: 'c1',
      messageId: 'm1',
      text: 'hello there',
    }
    let res = await notify(evt)
    expect(await res.json()).toEqual({ delivered: 2 })
    res = await notify(evt)
    expect(await res.json()).toEqual({ delivered: 0 })
    expect(ios.recent[0].msg).toMatchObject({
      title: 'Alice',
      body: 'hello there',
      data: {
        reason: 'chat-message',
        convoId: 'c1',
        messageId: 'm1',
        recipientDid: 'did:example:bob',
      },
    })

    expect((await notify({ kind: 'nope', id: 'x' })).status).toBe(400)
    expect((await notify(evt, 'wrong')).status).toBe(401)

    await notify({
      kind: 'kyc',
      id: 'kyc1',
      recipientDid: 'did:example:bob',
      status: 'approved',
    })
    expect(android.recent.at(-1)?.msg.data.reason).toBe('krao-kyc')
  })
})

describe('FcmSender', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })

  it('sends data messages and reports dead tokens', async () => {
    const calls: { url: string; body: string }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) })
      if (url.includes('oauth2')) {
        return Response.json({ access_token: 'at', expires_in: 3600 })
      }
      if (String(init.body).includes('"token":"dead"')) {
        return Response.json(
          { error: { status: 'NOT_FOUND', message: 'UNREGISTERED' } },
          { status: 404 },
        )
      }
      return Response.json({ name: 'projects/p/messages/1' })
    }) as typeof fetch
    const fcm = new FcmSender(
      {
        project_id: 'p',
        client_email: 'push@p.iam.gserviceaccount.com',
        private_key: privateKey,
      },
      fetchFn,
    )
    const msg = { title: 'Alice', body: 'hi', data: { reason: 'reply' } }
    expect(await fcm.send('live', msg)).toBe('ok')
    expect(await fcm.send('dead', msg)).toBe('invalid-token')
    // One access token for both
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1)
    const sent = JSON.parse(calls[1].body)
    expect(sent.message.data).toEqual({
      reason: 'reply',
      title: 'Alice',
      message: 'hi',
    })
  })
})
