import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  CODE_TTL_MS,
  PhoneCrypto,
  PhoneService,
  RESEND_COOLDOWN_MS,
  maskPhone,
  normalizePhone,
} from './phone.js'
import { RewardsService } from './service.js'

const ALICE = 'did:plc:alice'
const BOB = 'did:plc:bob'
const SECRETS = { hmacSecret: 's'.repeat(32), encKey: '01'.repeat(32) }

describe('normalizePhone', () => {
  it('turns Vietnamese national numbers into E.164', () => {
    expect(normalizePhone('0912345678')).toBe('+84912345678')
    expect(normalizePhone('091 234 5678')).toBe('+84912345678')
    expect(normalizePhone('+84 (0)91-234-5678')).toBe('+84912345678')
    expect(normalizePhone('0084912345678')).toBe('+84912345678')
  })

  it('keeps E.164 numbers of other countries', () => {
    expect(normalizePhone('+1 415 555 0100')).toBe('+14155550100')
  })

  it('rejects what is not E.164', () => {
    for (const bad of [
      '',
      '12345',
      '84912345678',
      '+0123456789',
      'abc',
      '+8491234567890123',
    ]) {
      expect(normalizePhone(bad)).toBeNull()
    }
  })

  it('masks all but the country code and last digits', () => {
    expect(maskPhone('+84912345678')).toBe('+84******678')
  })
})

describe('PhoneCrypto', () => {
  it('round-trips numbers through AES-GCM, with a fresh IV each time', () => {
    const crypto = new PhoneCrypto(SECRETS)
    const a = crypto.encrypt('+84912345678')
    const b = crypto.encrypt('+84912345678')
    expect(a).not.toBe(b)
    expect(crypto.decrypt(a)).toBe('+84912345678')
  })

  it('refuses a tampered ciphertext', () => {
    const crypto = new PhoneCrypto(SECRETS)
    const stored = crypto.encrypt('+84912345678')
    const raw = Buffer.from(stored.slice(3), 'base64')
    raw[raw.length - 1] ^= 1
    expect(() => crypto.decrypt(`v1:${raw.toString('base64')}`)).toThrow()
  })

  it('hashes a number the same way every time, and per secret', () => {
    const crypto = new PhoneCrypto(SECRETS)
    expect(crypto.hash('+84912345678')).toBe(crypto.hash('+84912345678'))
    expect(crypto.hash('+84912345678')).not.toBe(crypto.hash('+84912345679'))
    const other = new PhoneCrypto({ ...SECRETS, hmacSecret: 't'.repeat(32) })
    expect(other.hash('+84912345678')).not.toBe(crypto.hash('+84912345678'))
  })

  it('needs real secrets', () => {
    expect(() => new PhoneCrypto({ ...SECRETS, hmacSecret: 'short' })).toThrow()
    expect(() => new PhoneCrypto({ ...SECRETS, encKey: 'abcd' })).toThrow()
  })
})

describe('PhoneService', () => {
  let db: Database
  let now: number
  let sent: Array<{ to: string; text: string }>
  let phone: PhoneService

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    now = Date.parse('2026-10-16T08:00:00Z')
    sent = []
    phone = new PhoneService(
      db,
      new PhoneCrypto(SECRETS),
      { name: 'test', send: async (to, text) => void sent.push({ to, text }) },
      () => now,
    )
    phone.devCodes = new Map()
  })

  afterEach(async () => {
    await db.destroy()
  })

  const codeFor = (did: string) => phone.devCodes!.get(did)!
  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => 'none',
      (err: { error?: string }) => err.error,
    )

  it('sends a 6 digit code and verifies the number with it', async () => {
    const { expiresAt } = await phone.requestCode(ALICE, '0912345678')
    expect(Date.parse(expiresAt) - now).toBe(CODE_TTL_MS)
    expect(sent[0].to).toBe('+84912345678')
    expect(codeFor(ALICE)).toMatch(/^\d{6}$/)
    expect(sent[0].text).toContain(codeFor(ALICE))
    const status = await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    expect(status).toMatchObject({
      verified: true,
      maskedPhone: '+84******678',
    })
    expect(await phone.isVerified(ALICE)).toBe(true)
  })

  it('stores neither the number nor the code in clear', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    const otp = await db
      .selectFrom('phone_otp')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(otp)).not.toContain('912345678')
    expect(JSON.stringify(otp)).not.toContain(codeFor(ALICE))
    await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    const row = await db
      .selectFrom('phone_verification')
      .selectAll()
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(row)).not.toContain('912345678')
  })

  it('gives a number to one account only', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    expect(await errorOf(phone.requestCode(BOB, '0912345678'))).toBe(
      'PhoneTaken',
    )
  })

  it('refuses a number another account verified meanwhile', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    await phone.requestCode(BOB, '+84912345678')
    await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    expect(
      await errorOf(phone.verifyCode(BOB, '+84912345678', codeFor(BOB))),
    ).toBe('PhoneTaken')
  })

  it('frees the number when the account is deleted, not when taken down', async () => {
    const rewards = new RewardsService(db)
    await phone.requestCode(ALICE, '+84912345678')
    await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    await rewards.takeDown(ALICE)
    expect(await errorOf(phone.requestCode(BOB, '+84912345678'))).toBe(
      'PhoneTaken',
    )
    await rewards.accountDeleted(ALICE)
    expect(await phone.isVerified(ALICE)).toBe(false)
    expect(await errorOf(phone.requestCode(BOB, '+84912345678'))).toBe('none')
  })

  it('expires codes after 5 minutes', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    now += CODE_TTL_MS + 1
    expect(
      await errorOf(phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))),
    ).toBe('CodeExpired')
  })

  it('takes a code only for the number it was sent to', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    expect(
      await errorOf(phone.verifyCode(ALICE, '+84912345679', codeFor(ALICE))),
    ).toBe('CodeExpired')
  })

  it('allows 5 attempts per code', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    const wrong = codeFor(ALICE) === '000000' ? '111111' : '000000'
    const errors = []
    for (let i = 0; i < 5; i++) {
      errors.push(await errorOf(phone.verifyCode(ALICE, '+84912345678', wrong)))
    }
    expect(errors).toEqual([
      'InvalidCode',
      'InvalidCode',
      'InvalidCode',
      'InvalidCode',
      'TooManyAttempts',
    ])
    // Even the right code is refused now
    expect(
      await errorOf(phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))),
    ).toBe('TooManyAttempts')
  })

  it('waits a minute between codes and sends at most 5 an hour', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    expect(await errorOf(phone.requestCode(ALICE, '+84912345678'))).toBe(
      'RateLimitExceeded',
    )
    for (let i = 0; i < 4; i++) {
      now += RESEND_COOLDOWN_MS
      await phone.requestCode(ALICE, '+84912345678')
    }
    now += RESEND_COOLDOWN_MS
    expect(await errorOf(phone.requestCode(ALICE, '+84912345678'))).toBe(
      'RateLimitExceeded',
    )
    now += 60 * 60_000
    expect(await errorOf(phone.requestCode(ALICE, '+84912345678'))).toBe('none')
  })

  it('limits the codes one number gets across accounts', async () => {
    const dids = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `did:plc:${x}`)
    const errors = []
    for (const did of dids) {
      errors.push(await errorOf(phone.requestCode(did, '+84912345678')))
    }
    expect(errors.slice(0, 5)).toEqual(['none', 'none', 'none', 'none', 'none'])
    expect(errors[5]).toBe('RateLimitExceeded')
  })

  it('rejects numbers that are not E.164', async () => {
    expect(await errorOf(phone.requestCode(ALICE, '12345'))).toBe(
      'InvalidPhone',
    )
    expect(sent).toHaveLength(0)
  })
})
