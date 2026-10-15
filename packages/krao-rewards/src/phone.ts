import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'
import type { Database } from './db.js'
import { RewardsError } from './service.js'

/*
 * Phone verification (Decree 147: accounts that post or chat must have a
 * verified phone number). Numbers are kept two ways: an HMAC, unique, so one
 * number belongs to one account and lookups need no plaintext, and an
 * AES-256-GCM ciphertext, kept for the authorities while the account exists.
 * Codes are stored as HMACs too.
 */

export const CODE_TTL_MS = 5 * 60_000
export const MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_MS = 60_000
/** Codes sent per account, and per number, in an hour */
export const SENDS_PER_HOUR = 5

const E164_RE = /^\+[1-9]\d{6,14}$/

/**
 * A number in E.164 form, or null. Spaces, dots, dashes and brackets are
 * dropped; 00 stands for +; a Vietnamese national number (0 and 9 digits)
 * gets +84, and so does a +84 number written with its leading 0.
 */
export function normalizePhone(raw: string): string | null {
  let phone = raw.trim().replace(/[\s.\-()]/g, '')
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`
  if (/^0\d{9}$/.test(phone)) phone = `+84${phone.slice(1)}`
  if (phone.startsWith('+840')) phone = `+84${phone.slice(4)}`
  return E164_RE.test(phone) ? phone : null
}

/** +84912345678 -> +84******678 */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone.replace(/\d/g, '*')
  return phone.slice(0, 3) + '*'.repeat(phone.length - 6) + phone.slice(-3)
}

export type PhoneSecrets = {
  /** Keys the number and code HMACs (at least 32 characters) */
  hmacSecret: string
  /** AES-256 key: 32 bytes, as 64 hex characters or base64 */
  encKey: string
}

export function parseEncKey(value: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) {
    throw new Error(
      'KRAO_PHONE_ENC_KEY must be 32 bytes (64 hex characters or base64)',
    )
  }
  return key
}

export class PhoneCrypto {
  private key: Buffer

  constructor(private secrets: PhoneSecrets) {
    if (secrets.hmacSecret.length < 32) {
      throw new Error('KRAO_PHONE_HMAC_SECRET must be at least 32 characters')
    }
    this.key = parseEncKey(secrets.encKey)
  }

  /** The lookup key of a normalized number */
  hash(phone: string): string {
    return createHmac('sha256', this.secrets.hmacSecret)
      .update(`phone:${phone}`)
      .digest('hex')
  }

  /** The stored form of a code, bound to the account and the number */
  codeHash(did: string, phoneHash: string, code: string): string {
    return createHmac('sha256', this.secrets.hmacSecret)
      .update(`otp:${did}:${phoneHash}:${code}`)
      .digest('hex')
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`
  }

  decrypt(stored: string): string {
    if (!stored.startsWith('v1:')) throw new Error('Unknown phone cipher')
    const raw = Buffer.from(stored.slice(3), 'base64')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      raw.subarray(0, 12),
    )
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString('utf8')
  }
}

/** Sends the codes (an SMS gateway) */
export interface SmsProvider {
  readonly name: string
  send(to: string, text: string): Promise<void>
}

/** Development: codes go to the log */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log'
  async send(to: string, text: string) {
    console.log(`Krao rewards: SMS to ${maskPhone(to)}: ${text}`)
  }
}

/**
 * Any gateway with a JSON API: POST {to, text} with a bearer token. A small
 * relay in front of a provider's own API fits here too.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http'

  constructor(
    private cfg: { url: string; token: string },
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(to: string, text: string) {
    const res = await this.fetchFn(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({ to, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`SMS gateway answered ${res.status}`)
  }
}

/** The SMS text. Without diacritics: they double the cost of an SMS */
export const smsText = (code: string) =>
  `Krao: ma xac thuc cua ban la ${code}, het han sau 5 phut. Khong chia se ma nay voi ai.`

const iso = (ms: number) => new Date(ms).toISOString()

export type PhoneStatus = {
  verified: boolean
  verifiedAt?: string
  maskedPhone?: string
}

export class PhoneService {
  /** Development only: the last code sent to each account */
  devCodes?: Map<string, string>

  constructor(
    private db: Database,
    private crypto: PhoneCrypto,
    private sms: SmsProvider,
    private clock: () => number = Date.now,
  ) {}

  private parse(raw: string) {
    const phone = normalizePhone(raw)
    if (!phone) {
      throw new RewardsError(
        'InvalidPhone',
        'Enter the phone number with its country code, eg +84912345678',
      )
    }
    return { phone, phoneHash: this.crypto.hash(phone) }
  }

  private async takenByOther(did: string, phoneHash: string) {
    const row = await this.db
      .selectFrom('phone_verification')
      .select('did')
      .where('phoneHash', '=', phoneHash)
      .executeTakeFirst()
    return !!row && row.did !== did
  }

  async requestCode(did: string, raw: string): Promise<{ expiresAt: string }> {
    const { phone, phoneHash } = this.parse(raw)
    if (await this.takenByOther(did, phoneHash)) {
      throw new RewardsError(
        'PhoneTaken',
        'This phone number is already verified on another account',
      )
    }
    const now = this.clock()
    const pending = await this.db
      .selectFrom('phone_otp')
      .select('createdAt')
      .where('did', '=', did)
      .executeTakeFirst()
    if (pending && now - Date.parse(pending.createdAt) < RESEND_COOLDOWN_MS) {
      throw new RewardsError(
        'RateLimitExceeded',
        'Please wait a minute before asking for another code',
      )
    }
    const hourAgo = iso(now - 60 * 60_000)
    const [byDid, byPhone] = await Promise.all([
      this.sendCount('did', did, hourAgo),
      this.sendCount('phoneHash', phoneHash, hourAgo),
    ])
    if (byDid >= SENDS_PER_HOUR || byPhone >= SENDS_PER_HOUR) {
      throw new RewardsError(
        'RateLimitExceeded',
        'Too many codes asked for, try again in an hour',
      )
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    // Counted before sending: a failing gateway is not retried faster
    await this.db
      .insertInto('phone_send_log')
      .values({ did, phoneHash, sentAt: iso(now) })
      .execute()
    try {
      await this.sms.send(phone, smsText(code))
    } catch (err) {
      console.error('Krao rewards: SMS failed', err)
      throw new RewardsError(
        'SmsFailed',
        'The code could not be sent, try again later',
      )
    }
    const row = {
      did,
      phoneHash,
      codeHash: this.crypto.codeHash(did, phoneHash, code),
      attempts: 0,
      expiresAt: iso(now + CODE_TTL_MS),
      createdAt: iso(now),
    }
    await this.db
      .insertInto('phone_otp')
      .values(row)
      .onConflict((oc) => oc.column('did').doUpdateSet(row))
      .execute()
    this.devCodes?.set(did, code)
    return { expiresAt: row.expiresAt }
  }

  private async sendCount(
    column: 'did' | 'phoneHash',
    value: string,
    since: string,
  ) {
    const row = await this.db
      .selectFrom('phone_send_log')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where(column, '=', value)
      .where('sentAt', '>=', since)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async verifyCode(did: string, raw: string, code: string) {
    const { phone, phoneHash } = this.parse(raw)
    const now = this.clock()
    const otp = await this.db
      .selectFrom('phone_otp')
      .selectAll()
      .where('did', '=', did)
      .executeTakeFirst()
    if (
      !otp ||
      otp.phoneHash !== phoneHash ||
      Date.parse(otp.expiresAt) <= now
    ) {
      throw new RewardsError(
        'CodeExpired',
        'The code expired or was sent to another number: ask for a new one',
      )
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      throw new RewardsError(
        'TooManyAttempts',
        'Too many wrong codes: ask for a new one',
      )
    }
    await this.db
      .updateTable('phone_otp')
      .set({ attempts: otp.attempts + 1 })
      .where('did', '=', did)
      .execute()
    const given = Buffer.from(this.crypto.codeHash(did, phoneHash, code.trim()))
    const expected = Buffer.from(otp.codeHash)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      const left = MAX_ATTEMPTS - otp.attempts - 1
      throw new RewardsError(
        left > 0 ? 'InvalidCode' : 'TooManyAttempts',
        left > 0
          ? `Wrong code, ${left} ${left === 1 ? 'try' : 'tries'} left`
          : 'Too many wrong codes: ask for a new one',
      )
    }
    const row = {
      did,
      phoneHash,
      phoneEnc: this.crypto.encrypt(phone),
      verifiedAt: iso(now),
    }
    try {
      await this.db.transaction().execute(async (tx) => {
        await tx
          .insertInto('phone_verification')
          .values(row)
          .onConflict((oc) => oc.column('did').doUpdateSet(row))
          .execute()
        await tx.deleteFrom('phone_otp').where('did', '=', did).execute()
        await tx
          .insertInto('audit_log')
          .values({
            actor: did,
            action: 'phone.verified',
            subject: did,
            data: null,
            createdAt: row.verifiedAt,
          })
          .execute()
      })
    } catch (err) {
      // Another account verified the number in the meantime (unique index)
      if (String((err as Error)?.message).includes('UNIQUE')) {
        throw new RewardsError(
          'PhoneTaken',
          'This phone number is already verified on another account',
        )
      }
      throw err
    }
    this.devCodes?.delete(did)
    return this.status(did)
  }

  async isVerified(did: string) {
    return !!(await this.db
      .selectFrom('phone_verification')
      .select('did')
      .where('did', '=', did)
      .executeTakeFirst())
  }

  async status(did: string): Promise<PhoneStatus> {
    const row = await this.db
      .selectFrom('phone_verification')
      .selectAll()
      .where('did', '=', did)
      .executeTakeFirst()
    if (!row) return { verified: false }
    let maskedPhone: string | undefined
    try {
      maskedPhone = maskPhone(this.crypto.decrypt(row.phoneEnc))
    } catch (err) {
      console.error('Krao rewards: cannot read a stored phone number', err)
    }
    return { verified: true, verifiedAt: row.verifiedAt, maskedPhone }
  }

  /** Old send log rows and expired codes */
  async prune() {
    const dayAgo = iso(this.clock() - 24 * 60 * 60_000)
    await this.db
      .deleteFrom('phone_send_log')
      .where('sentAt', '<', dayAgo)
      .execute()
    await this.db
      .deleteFrom('phone_otp')
      .where('expiresAt', '<', iso(this.clock()))
      .execute()
  }
}
