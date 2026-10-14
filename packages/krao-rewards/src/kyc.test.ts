import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import {
  SumsubProvider,
  WebhookSignatureError,
  pendingSecondApproval,
  reviewKyc,
} from './kyc.js'
import { RewardsService } from './service.js'

const SECRET = 'webhook-secret'

const sumsub = new SumsubProvider({
  appToken: 'app-token',
  secretKey: 'secret-key',
  levelName: 'basic-kyc-level',
  webhookSecret: SECRET,
})

const signed = (payload: unknown, alg = 'sha256') => {
  const body = Buffer.from(JSON.stringify(payload))
  const name = `HMAC_${alg.toUpperCase()}_HEX`
  return {
    body,
    headers: {
      'x-payload-digest': createHmac(alg, SECRET).update(body).digest('hex'),
      'x-payload-digest-alg': name,
    },
  }
}

describe('SumsubProvider', () => {
  it('signs API requests as Sumsub documents', () => {
    const sig = sumsub.signRequest('post', '/resources/x?y=1', '{}', 1700000000)
    expect(sig).toBe(
      createHmac('sha256', 'secret-key')
        .update('1700000000POST/resources/x?y=1{}')
        .digest('hex'),
    )
  })

  it('reads approvals, retries and rejections', () => {
    const base = {
      type: 'applicantReviewed',
      applicantId: 'app1',
      externalUserId: 'did:plc:bob',
    }
    const green = signed({ ...base, reviewResult: { reviewAnswer: 'GREEN' } })
    expect(sumsub.parseWebhook(green.headers, green.body)).toEqual({
      did: 'did:plc:bob',
      status: 'approved',
      providerRef: 'app1',
      rejectReason: null,
      duplicate: false,
    })

    const retry = signed({
      ...base,
      reviewResult: {
        reviewAnswer: 'RED',
        reviewRejectType: 'RETRY',
        rejectLabels: ['BAD_PROOF_OF_IDENTITY'],
      },
    })
    expect(sumsub.parseWebhook(retry.headers, retry.body)).toMatchObject({
      status: 'retry',
      rejectReason: 'BAD_PROOF_OF_IDENTITY',
    })

    const dup = signed(
      {
        ...base,
        reviewResult: {
          reviewAnswer: 'RED',
          // A duplicate is final even when Sumsub allows a retry
          reviewRejectType: 'RETRY',
          rejectLabels: ['DUPLICATE'],
        },
      },
      'sha512',
    )
    expect(sumsub.parseWebhook(dup.headers, dup.body)).toMatchObject({
      status: 'rejected',
      duplicate: true,
    })
  })

  it('ignores events that do not change the status', () => {
    const created = signed({
      type: 'applicantCreated',
      externalUserId: 'did:plc:bob',
    })
    expect(sumsub.parseWebhook(created.headers, created.body)).toBeNull()
  })

  it('rejects bad or missing signatures', () => {
    const { body, headers } = signed({ type: 'applicantReviewed' })
    const tampered = Buffer.from(body.toString().replace('Reviewed', 'Pending'))
    expect(() => sumsub.parseWebhook(headers, tampered)).toThrow(
      WebhookSignatureError,
    )
    expect(() => sumsub.parseWebhook({}, body)).toThrow(WebhookSignatureError)
    expect(() =>
      sumsub.parseWebhook(
        { ...headers, 'x-payload-digest-alg': 'HMAC_MD5_HEX' },
        body,
      ),
    ).toThrow(WebhookSignatureError)
  })
})

describe('manual KYC review', () => {
  let db: Database
  let service: RewardsService

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new RewardsService(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  const review = (
    reviewer: string,
    did: string,
    opts: { dailyLimit?: number; second?: boolean } = {},
  ) =>
    reviewKyc(
      service,
      {
        dailyLimit: opts.dailyLimit ?? 5,
        requireSecondApprover: opts.second ?? false,
      },
      reviewer,
      {
        did,
        decision: 'approve',
        reasonCode: 'provider_outage',
        note: 'Checked the passport on a video call',
      },
    )

  it('applies a decision and logs it', async () => {
    await review('did:plc:r1', 'did:plc:bob')
    expect((await service.kycRecord('did:plc:bob'))?.status).toBe('approved')
    const log = await db
      .selectFrom('audit_log')
      .select('action')
      .where('subject', '=', 'did:plc:bob')
      .execute()
    expect(log.map((l) => l.action)).toEqual(['kyc.review', 'kyc.status'])
  })

  it('refuses reviews of the reviewer’s own account', async () => {
    await expect(review('did:plc:bob', 'did:plc:bob')).rejects.toMatchObject({
      error: 'SelfReview',
    })
  })

  it('stops at the daily limit', async () => {
    await review('did:plc:r1', 'did:plc:a', { dailyLimit: 2 })
    await review('did:plc:r1', 'did:plc:b', { dailyLimit: 2 })
    await expect(
      review('did:plc:r1', 'did:plc:c', { dailyLimit: 2 }),
    ).rejects.toMatchObject({ error: 'DailyLimitReached' })
  })

  it('can require two different reviewers to approve', async () => {
    await review('did:plc:r1', 'did:plc:bob', { second: true })
    expect(await service.kycRecord('did:plc:bob')).toBeUndefined()
    expect(await pendingSecondApproval(service, ['did:plc:bob'])).toEqual(
      new Set(['did:plc:bob']),
    )
    await expect(
      review('did:plc:r1', 'did:plc:bob', { second: true }),
    ).rejects.toMatchObject({ error: 'SameReviewer' })
    await review('did:plc:r2', 'did:plc:bob', { second: true })
    expect((await service.kycRecord('did:plc:bob'))?.status).toBe('approved')
    expect((await pendingSecondApproval(service, ['did:plc:bob'])).size).toBe(0)
  })
})
