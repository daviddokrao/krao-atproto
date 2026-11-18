import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'
import { type SelectQueryBuilder, sql } from 'kysely'
import type { Database, DatabaseSchema } from './db.js'
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
/** Code requests per account, and per number, in an hour */
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

export type PhoneLimits = {
  /** Numbers must start with one of these (default +84: Vietnam only) */
  allowedPrefixes: string[]
  /** Codes sent per hour across all accounts (an SMS budget) */
  globalHourlyCap: number
  /** Codes per hour from one client address */
  ipHourlyCap: number
}

export const DEFAULT_PHONE_LIMITS: PhoneLimits = {
  allowedPrefixes: ['+84'],
  globalHourlyCap: 500,
  ipHourlyCap: 30,
}

const rateLimited = (message: string) =>
  new RewardsError('RateLimitExceeded', message)

export class PhoneService {
  /** Development only: the last code sent to each account */
  devCodes?: Map<string, string>
  private limits: PhoneLimits

  constructor(
    private db: Database,
    private crypto: PhoneCrypto,
    private sms: SmsProvider,
    private clock: () => number = Date.now,
    limits: Partial<PhoneLimits> = {},
  ) {
    this.limits = { ...DEFAULT_PHONE_LIMITS, ...limits }
  }

  private parse(raw: string) {
    const phone = normalizePhone(raw)
    if (!phone) {
      throw new RewardsError(
        'InvalidPhone',
        'Enter the phone number with its country code, eg +84912345678',
      )
    }
    if (!this.limits.allowedPrefixes.some((p) => phone.startsWith(p))) {
      throw new RewardsError(
        'PhoneNotSupported',
        `Only numbers starting with ${this.limits.allowedPrefixes.join(', ')} can be verified`,
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

  /**
   * Counts the request against every limit and records it, in one
   * IMMEDIATE transaction so concurrent requests cannot both pass. Every
   * request counts, including those for numbers another account holds.
   */
  private async takeSendSlot(
    did: string,
    phoneHash: string,
    ip: string | undefined,
    now: number,
  ) {
    await this.db.connection().execute(async (conn) => {
      await sql`begin immediate`.execute(conn)
      try {
        const count = async (
          where: (qb: SendLogQuery) => SendLogQuery,
          since: number,
        ) => {
          const row = await where(
            conn
              .selectFrom('phone_send_log')
              .select((eb) => eb.fn.countAll<number>().as('count'))
              .where('sentAt', '>=', iso(since)),
          ).executeTakeFirstOrThrow()
          return Number(row.count)
        }
        const hourAgo = now - 60 * 60_000
        if (
          (await count(
            (qb) => qb.where('did', '=', did),
            now - RESEND_COOLDOWN_MS + 1,
          )) > 0
        ) {
          throw rateLimited(
            'Please wait a minute before asking for another code',
          )
        }
        if (
          (await count((qb) => qb.where('did', '=', did), hourAgo)) >=
            SENDS_PER_HOUR ||
          (await count(
            (qb) => qb.where('phoneHash', '=', phoneHash),
            hourAgo,
          )) >= SENDS_PER_HOUR ||
          (ip &&
            (await count((qb) => qb.where('ip', '=', ip), hourAgo)) >=
              this.limits.ipHourlyCap)
        ) {
          throw rateLimited('Too many codes asked for, try again in an hour')
        }
        if ((await count((qb) => qb, hourAgo)) >= this.limits.globalHourlyCap) {
          console.error('Krao rewards: the hourly SMS cap is reached')
          throw rateLimited('Codes cannot be sent right now, try again later')
        }
        await conn
          .insertInto('phone_send_log')
          .values({ did, phoneHash, ip: ip ?? null, sentAt: iso(now) })
          .execute()
        await sql`commit`.execute(conn)
      } catch (err) {
        await sql`rollback`.execute(conn)
        throw err
      }
    })
  }

  /**
   * Sends a code. A number another account verified gets the same answer
   * but no SMS (no enumeration here); verifyCode tells it apart.
   */
  async requestCode(
    did: string,
    raw: string,
    ip?: string,
  ): Promise<{ expiresAt: string }> {
    const { phone, phoneHash } = this.parse(raw)
    const now = this.clock()
    await this.takeSendSlot(did, phoneHash, ip, now)
    const taken = await this.takenByOther(did, phoneHash)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    if (!taken) {
      try {
        await this.sms.send(phone, smsText(code))
      } catch (err) {
        console.error('Krao rewards: SMS failed', err)
        throw new RewardsError(
          'SmsFailed',
          'The code could not be sent, try again later',
        )
      }
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
    if (!taken) this.devCodes?.set(did, code)
    return { expiresAt: row.expiresAt }
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
    // Counted atomically before the code is compared: parallel guesses
    // cannot get more tries
    const counted = await this.db
      .updateTable('phone_otp')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('did', '=', did)
      .where('codeHash', '=', otp.codeHash)
      .where('attempts', '<', MAX_ATTEMPTS)
      .returning('attempts')
      .executeTakeFirst()
    if (!counted) {
      throw new RewardsError(
        'TooManyAttempts',
        'Too many wrong codes: ask for a new one',
      )
    }
    const dropCode = () =>
      this.db
        .deleteFrom('phone_otp')
        .where('did', '=', did)
        .where('codeHash', '=', otp.codeHash)
        .execute()
    if (await this.takenByOther(did, phoneHash)) {
      await dropCode()
      throw new RewardsError(
        'PhoneTaken',
        'This phone number is already verified on another account',
      )
    }
    const given = Buffer.from(this.crypto.codeHash(did, phoneHash, code.trim()))
    const expected = Buffer.from(otp.codeHash)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      const left = MAX_ATTEMPTS - counted.attempts
      if (left <= 0) {
        await dropCode()
        throw new RewardsError(
          'TooManyAttempts',
          'Too many wrong codes: ask for a new one',
        )
      }
      throw new RewardsError(
        'InvalidCode',
        `Wrong code, ${left} ${left === 1 ? 'try' : 'tries'} left`,
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

type SendLogQuery = SelectQueryBuilder<
  DatabaseSchema,
  'phone_send_log',
  { count: number }
>
