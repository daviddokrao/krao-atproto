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

  const wrongFor = (did: string) =>
    codeFor(did) === '000000' ? '111111' : '000000'

  it('gives a number to one account only, telling only at verifyCode', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    // The same answer as for a free number, but no SMS
    expect(await errorOf(phone.requestCode(BOB, '0912345678'))).toBe('none')
    expect(sent).toHaveLength(1)
    expect(phone.devCodes!.has(BOB)).toBe(false)
    expect(await errorOf(phone.verifyCode(BOB, '+84912345678', '123456'))).toBe(
      'PhoneTaken',
    )
  })

  it('counts every request, also for numbers others hold', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    await phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))
    const errors = []
    for (let i = 0; i < 6; i++) {
      const number = i === 0 ? '+84912345678' : `+8491234567${i}`
      errors.push(await errorOf(phone.requestCode(BOB, number)))
      now += RESEND_COOLDOWN_MS
    }
    // Probing numbers is limited like asking for codes
    expect(errors).toEqual([
      'none',
      'none',
      'none',
      'none',
      'none',
      'RateLimitExceeded',
    ])
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
    await phone.requestCode(BOB, '+84912345678')
    expect(await errorOf(phone.verifyCode(BOB, '+84912345678', '123456'))).toBe(
      'PhoneTaken',
    )
    await rewards.accountDeleted(ALICE)
    expect(await phone.isVerified(ALICE)).toBe(false)
    now += RESEND_COOLDOWN_MS
    await phone.requestCode(BOB, '+84912345678')
    expect(
      await errorOf(phone.verifyCode(BOB, '+84912345678', codeFor(BOB))),
    ).toBe('none')
    // Its send log stays: the number's hourly limit still counts it
    const log = await db.selectFrom('phone_send_log').selectAll().execute()
    expect(log.filter((r) => r.did === ALICE)).toHaveLength(1)
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

  it('allows 5 attempts per code, then drops it', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    const errors = []
    for (let i = 0; i < 5; i++) {
      errors.push(
        await errorOf(phone.verifyCode(ALICE, '+84912345678', wrongFor(ALICE))),
      )
    }
    expect(errors).toEqual([
      'InvalidCode',
      'InvalidCode',
      'InvalidCode',
      'InvalidCode',
      'TooManyAttempts',
    ])
    // Even the right code is refused now: the code is gone
    expect(
      await errorOf(phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))),
    ).toBe('CodeExpired')
  })

  it('counts parallel guesses atomically', async () => {
    await phone.requestCode(ALICE, '+84912345678')
    const errors = await Promise.all(
      Array.from({ length: 20 }, () =>
        errorOf(phone.verifyCode(ALICE, '+84912345678', wrongFor(ALICE))),
      ),
    )
    expect(errors.filter((e) => e === 'InvalidCode')).toHaveLength(4)
    expect(errors.every((e) => e !== 'none')).toBe(true)
    expect(
      await errorOf(phone.verifyCode(ALICE, '+84912345678', codeFor(ALICE))),
    ).not.toBe('none')
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

  it('holds the limits under parallel requests', async () => {
    const sameNumber = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        errorOf(phone.requestCode(`did:plc:p${i}`, '+84912345678')),
      ),
    )
    expect(sameNumber.filter((e) => e === 'none')).toHaveLength(5)
    const sameAccount = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        errorOf(phone.requestCode(BOB, `+8490000000${i}`)),
      ),
    )
    expect(sameAccount.filter((e) => e === 'none')).toHaveLength(1)
  })

  it('caps codes per client address and in total', async () => {
    const capped = new PhoneService(
      db,
      new PhoneCrypto(SECRETS),
      { name: 'test', send: async () => {} },
      () => now,
      { ipHourlyCap: 2, globalHourlyCap: 3 },
    )
    const ask = (i: number, ip?: string) =>
      errorOf(capped.requestCode(`did:plc:c${i}`, `+8490000001${i}`, ip))
    expect(await ask(1, '10.0.0.1')).toBe('none')
    expect(await ask(2, '10.0.0.1')).toBe('none')
    expect(await ask(3, '10.0.0.1')).toBe('RateLimitExceeded')
    expect(await ask(4, '10.0.0.2')).toBe('none')
    // Three codes this hour: the global cap
    expect(await ask(5, '10.0.0.3')).toBe('RateLimitExceeded')
    expect(await ask(6)).toBe('RateLimitExceeded')
  })

  it('verifies only numbers of the allowed countries', async () => {
    expect(await errorOf(phone.requestCode(ALICE, '+14155550100'))).toBe(
      'PhoneNotSupported',
    )
    const us = new PhoneService(
      db,
      new PhoneCrypto(SECRETS),
      { name: 'test', send: async () => {} },
      () => now,
      { allowedPrefixes: ['+84', '+1'] },
    )
    expect(await errorOf(us.requestCode(ALICE, '+14155550100'))).toBe('none')
  })

  it('rejects numbers that are not E.164', async () => {
    expect(await errorOf(phone.requestCode(ALICE, '12345'))).toBe(
      'InvalidPhone',
    )
    expect(sent).toHaveLength(0)
  })
})
