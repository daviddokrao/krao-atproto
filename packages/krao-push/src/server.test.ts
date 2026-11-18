import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Struct } from '@bufbuild/protobuf'
import { ConnectError, createPromiseClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppviewClient } from './appview.js'
import { PREFERENCE_KEY, langOf, nameOf, socialTitle } from './compose.js'
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

  it('counts devices by platform for exports, and forgets deleted accounts', async () => {
    const client = courier()
    for (const [token, platform] of [
      ['tok-a', AppPlatform.IOS],
      ['tok-b', AppPlatform.ANDROID],
    ] as const) {
      await client.registerDeviceToken({
        did: 'did:example:dan',
        token,
        appId: 'io.krao.app',
        platform,
      })
    }
    const devices = () =>
      fetch(`${base}/internal/devices?did=did:example:dan`, {
        headers: { authorization: `Bearer ${INTERNAL}` },
      }).then((r) => r.json())
    expect(await devices()).toEqual({
      count: 2,
      platforms: { ios: 1, android: 1 },
    })
    const denied = await fetch(`${base}/internal/devices?did=did:example:dan`)
    expect(denied.status).toBe(401)
    await new PushService(db, {}).deleteAccount('did:example:dan')
    expect(await devices()).toEqual({ count: 0, platforms: {} })
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

  it('writes pushes in the language the account set', async () => {
    const client = courier()
    await client.registerDeviceToken({
      did: 'did:example:vy',
      token: 'tok-vy',
      appId: 'io.krao.app',
      platform: AppPlatform.ANDROID,
    })
    const setLanguage = (body: unknown, token = INTERNAL) =>
      fetch(`${base}/internal/language`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
    expect(
      (await setLanguage({ did: 'did:example:vy', language: 'vi' }, 'x'))
        .status,
    ).toBe(401)
    expect(
      (await setLanguage({ did: 'did:example:vy', language: '<b>' })).status,
    ).toBe(400)

    // English until the app says otherwise
    await notify({
      kind: 'points',
      id: 'p1',
      recipientDid: 'did:example:vy',
      points: 100,
    })
    expect(android.recent.at(-1)?.msg).toMatchObject({
      title: 'Your points were approved',
      body: '+100 points',
    })

    const res = await setLanguage({ did: 'did:example:vy', language: 'vi-VN' })
    expect(await res.json()).toEqual({ language: 'vi' })
    await notify({
      kind: 'points',
      id: 'p2',
      recipientDid: 'did:example:vy',
      points: 100,
    })
    expect(android.recent.at(-1)?.msg).toMatchObject({
      title: 'Điểm của bạn đã được duyệt',
      body: '+100 điểm',
    })
    await notify({
      kind: 'chat',
      id: 'm9',
      recipientDids: ['did:example:vy'],
      senderDid: 'did:example:alice',
      convoId: 'c1',
      messageId: 'm9',
      reaction: '❤️',
    })
    expect(android.recent.at(-1)?.msg.body).toBe(
      'Đã bày tỏ cảm xúc ❤️ với tin nhắn của bạn',
    )
    const devices = await fetch(`${base}/internal/devices?did=did:example:vy`, {
      headers: { authorization: `Bearer ${INTERNAL}` },
    }).then((r) => r.json())
    expect(devices).toEqual({
      count: 1,
      platforms: { android: 1 },
      language: 'vi-vn',
    })
  })
})

describe('push text', () => {
  it('has English and Vietnamese for every notification reason', () => {
    for (const reason of Object.keys(PREFERENCE_KEY)) {
      const en = socialTitle(reason, 'An', 'en')
      const vi = socialTitle(reason, 'An', 'vi')
      expect(en).toBeTruthy()
      expect(vi).toBeTruthy()
      expect(vi).not.toBe(en)
    }
    expect(socialTitle('like', 'An', 'vi')).toBe('An đã thích bài của bạn')
    expect(socialTitle('chat', 'An', 'vi')).toBeNull()
  })

  it('picks Vietnamese only for vi language tags', () => {
    expect(langOf('vi')).toBe('vi')
    expect(langOf('VI-vn')).toBe('vi')
    expect(langOf('en-US')).toBe('en')
    expect(langOf('fr')).toBe('en')
    expect(langOf(undefined)).toBe('en')
    expect(nameOf(undefined, 'vi')).toBe('Ai đó')
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
