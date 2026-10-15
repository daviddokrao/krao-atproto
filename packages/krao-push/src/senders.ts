import { createSign, sign as signData } from 'node:crypto'
import http2 from 'node:http2'
import type { Platform } from './db.js'

/** One notification for one device */
export type PushMessage = {
  title: string
  body: string
  /** For the app: reason, uri, subject, recipientDid, convoId, ... */
  data: Record<string, string>
  /** Newer pushes with the same key replace older ones on the device */
  collapseKey?: string
  /** Groups notifications on iOS */
  threadId?: string
  /** Shows nothing; the app acts on it in the background (badge sync) */
  silent?: boolean
}

/** 'invalid-token': the device is gone, forget the token */
export type SendResult = 'ok' | 'invalid-token' | 'error'

export interface Sender {
  send(token: string, msg: PushMessage): Promise<SendResult>
  close?(): void
}

/** What went out, for development and tests: nothing reaches a device */
export class LogSender implements Sender {
  recent: { platform: Platform; token: string; msg: PushMessage }[] = []

  constructor(private platform: Platform) {}

  async send(token: string, msg: PushMessage): Promise<SendResult> {
    this.recent.push({ platform: this.platform, token, msg })
    if (this.recent.length > 200) this.recent.shift()
    console.log(
      `krao-push [${this.platform}] ${token.slice(0, 8)}…`,
      JSON.stringify(msg),
    )
    return 'ok'
  }
}

const base64url = (data: string | Buffer) =>
  Buffer.from(data).toString('base64url')

export type FcmServiceAccount = {
  project_id: string
  client_email: string
  private_key: string
}

/** Android, through Firebase Cloud Messaging (HTTP v1 API) */
export class FcmSender implements Sender {
  private accessToken?: { value: string; expires: number }

  constructor(
    private account: FcmServiceAccount,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && this.accessToken.expires > now + 60_000) {
      return this.accessToken.value
    }
    const iat = Math.floor(now / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat,
        exp: iat + 3600,
      }),
    )
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(this.account.private_key, 'base64url')
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    })
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`)
    const body = (await res.json()) as {
      access_token: string
      expires_in: number
    }
    this.accessToken = {
      value: body.access_token,
      expires: now + body.expires_in * 1000,
    }
    return body.access_token
  }

  async send(token: string, msg: PushMessage): Promise<SendResult> {
    // Data-only, like Bluesky's: the app picks the channel and shows it
    const data = msg.silent
      ? msg.data
      : { ...msg.data, title: msg.title, message: msg.body }
    const res = await this.fetchFn(
      `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            data,
            android: {
              priority: msg.silent ? 'normal' : 'high',
              ...(msg.collapseKey ? { collapse_key: msg.collapseKey } : {}),
            },
          },
        }),
      },
    )
    if (res.ok) return 'ok'
    const text = await res.text()
    if (
      res.status === 404 ||
      /UNREGISTERED|registration-token-not-registered/.test(text) ||
      (res.status === 400 && /registration token/i.test(text))
    ) {
      return 'invalid-token'
    }
    console.error(`krao-push FCM ${res.status}: ${text.slice(0, 300)}`)
    return 'error'
  }
}

export type ApnsConfig = {
  /** Contents of the .p8 key */
  key: string
  keyId: string
  teamId: string
  /** The app's bundle id */
  topic: string
  production: boolean
}

/** iOS, through the Apple Push Notification service (token auth, HTTP/2) */
export class ApnsSender implements Sender {
  private session?: http2.ClientHttp2Session
  private jwt?: { value: string; issued: number }

  constructor(private cfg: ApnsConfig) {}

  private bearer(): string {
    const now = Date.now()
    // Apple wants a token newer than an hour, but not a new one per request
    if (this.jwt && now - this.jwt.issued < 40 * 60_000) return this.jwt.value
    const header = base64url(
      JSON.stringify({ alg: 'ES256', kid: this.cfg.keyId }),
    )
    const claims = base64url(
      JSON.stringify({ iss: this.cfg.teamId, iat: Math.floor(now / 1000) }),
    )
    const signature = signData(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: this.cfg.key, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url')
    this.jwt = { value: `${header}.${claims}.${signature}`, issued: now }
    return this.jwt.value
  }

  private connect(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session
    }
    const host = this.cfg.production
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com'
    const session = http2.connect(host)
    session.on('error', (err) => {
      console.error('krao-push APNs connection error', err)
    })
    session.on('close', () => {
      if (this.session === session) this.session = undefined
    })
    this.session = session
    return session
  }

  send(token: string, msg: PushMessage): Promise<SendResult> {
    const payload = msg.silent
      ? { aps: { 'content-available': 1 }, ...msg.data }
      : {
          aps: {
            alert: { title: msg.title, body: msg.body },
            sound: 'default',
            // Lets the app's notification service extension adjust it
            'mutable-content': 1,
            ...(msg.threadId ? { 'thread-id': msg.threadId } : {}),
          },
          ...msg.data,
        }
    return new Promise((resolve) => {
      let req: http2.ClientHttp2Stream
      try {
        req = this.connect().request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${this.bearer()}`,
          'apns-topic': this.cfg.topic,
          'apns-push-type': msg.silent ? 'background' : 'alert',
          'apns-priority': msg.silent ? '5' : '10',
          ...(msg.collapseKey
            ? { 'apns-collapse-id': msg.collapseKey.slice(0, 64) }
            : {}),
        })
      } catch (err) {
        console.error('krao-push APNs request failed', err)
        resolve('error')
        return
      }
      let status = 0
      let body = ''
      req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL))
      req.on('response', (headers) => {
        status = Number(headers[':status'])
      })
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        if (status === 200) return resolve('ok')
        if (
          status === 410 ||
          /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body)
        ) {
          return resolve('invalid-token')
        }
        console.error(`krao-push APNs ${status}: ${body.slice(0, 300)}`)
        resolve('error')
      })
      req.on('error', (err) => {
        console.error('krao-push APNs stream error', err)
        resolve('error')
      })
      req.end(JSON.stringify(payload))
    })
  }

  close() {
    this.session?.close()
  }
}
