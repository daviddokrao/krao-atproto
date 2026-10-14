import { createHmac, timingSafeEqual } from 'node:crypto'
import type { KycStatus } from './db.js'
import { RewardsError, type RewardsService } from './service.js'

/** An identity verification provider (Sumsub, or another one later) */
export interface KycProvider {
  readonly name: string
  /** A link to the provider's verification flow for this account */
  startSession(did: string): Promise<{ url: string }>
  /**
   * Checks a webhook's signature and reads the outcome. Returns null for
   * events that do not change the status.
   */
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): KycOutcome | null
}

export type KycOutcome = {
  did: string
  status: KycStatus
  providerRef: string | null
  rejectReason: string | null
  duplicate: boolean
}

export class WebhookSignatureError extends Error {}

export type SumsubConfig = {
  appToken: string
  secretKey: string
  /** Verification level, set up in the Sumsub dashboard */
  levelName: string
  /** Secret key of the webhook, from the Sumsub dashboard */
  webhookSecret: string
  baseUrl?: string
  /** How long a verification link stays valid */
  linkTtlSecs?: number
}

const DIGEST_ALGS: Record<string, string> = {
  HMAC_SHA1_HEX: 'sha1',
  HMAC_SHA256_HEX: 'sha256',
  HMAC_SHA512_HEX: 'sha512',
}

const header = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
) => {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Sumsub. Uses its external WebSDK links, so apps only open a URL: nothing
 * to embed on web, iOS or Android. Turn on duplicate detection in the level
 * settings; duplicates come back as rejections labelled DUPLICATE.
 */
export class SumsubProvider implements KycProvider {
  readonly name = 'sumsub'
  private baseUrl: string

  constructor(private cfg: SumsubConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://api.sumsub.com'
  }

  /** Signs a request as Sumsub's API requires (X-App-Access-Sig) */
  signRequest(method: string, pathWithQuery: string, body: string, ts: number) {
    return createHmac('sha256', this.cfg.secretKey)
      .update(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`)
      .digest('hex')
  }

  async startSession(did: string) {
    const path = '/resources/sdkIntegrations/levels/-/websdkLink'
    const body = JSON.stringify({
      levelName: this.cfg.levelName,
      userId: did,
      ttlInSecs: this.cfg.linkTtlSecs ?? 1800,
    })
    const ts = Math.floor(Date.now() / 1000)
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-App-Token': this.cfg.appToken,
        'X-App-Access-Ts': String(ts),
        'X-App-Access-Sig': this.signRequest('POST', path, body, ts),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      throw new Error(`Sumsub websdkLink failed: HTTP ${res.status}`)
    }
    const { url } = (await res.json()) as { url?: string }
    if (!url) throw new Error('Sumsub websdkLink returned no url')
    return { url }
  }

  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): KycOutcome | null {
    const digest = header(headers, 'x-payload-digest')
    const alg = DIGEST_ALGS[header(headers, 'x-payload-digest-alg') ?? '']
    if (!digest || !alg) throw new WebhookSignatureError('Missing signature')
    const expected = createHmac(alg, this.cfg.webhookSecret)
      .update(rawBody)
      .digest()
    const given = Buffer.from(digest, 'hex')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new WebhookSignatureError('Bad signature')
    }

    const event = JSON.parse(rawBody.toString('utf8')) as {
      type?: string
      applicantId?: string
      externalUserId?: string
      reviewResult?: {
        reviewAnswer?: string
        reviewRejectType?: string
        rejectLabels?: string[]
        moderationComment?: string
      }
    }
    const did = event.externalUserId
    if (!did?.startsWith('did:')) return null
    const base = {
      did,
      providerRef: event.applicantId ?? null,
      rejectReason: null,
      duplicate: false,
    }
    if (event.type === 'applicantPending') {
      return { ...base, status: 'pending' }
    }
    if (event.type !== 'applicantReviewed') return null
    const review = event.reviewResult ?? {}
    if (review.reviewAnswer === 'GREEN') {
      return { ...base, status: 'approved' }
    }
    if (review.reviewAnswer !== 'RED') return null
    const labels = review.rejectLabels ?? []
    const duplicate = labels.includes('DUPLICATE')
    return {
      ...base,
      // A duplicate person is final whatever the reject type
      status:
        review.reviewRejectType === 'RETRY' && !duplicate
          ? 'retry'
          : 'rejected',
      rejectReason: labels.join(', ').slice(0, 500) || null,
      duplicate,
    }
  }
}

const SECOND_APPROVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type ManualReviewConfig = {
  /** Manual decisions allowed per UTC day, across all reviewers */
  dailyLimit: number
  /** Approvals need two different reviewers */
  requireSecondApprover: boolean
}

/**
 * Manual KYC decisions: the exception, for cases the provider cannot handle.
 * Each needs a reason and a note, counts against a daily limit, and is
 * logged.
 */
export async function reviewKyc(
  service: RewardsService,
  cfg: ManualReviewConfig,
  reviewer: string,
  input: {
    did: string
    decision: 'approve' | 'reject'
    reasonCode: string
    note: string
  },
) {
  if (reviewer === input.did) {
    throw new RewardsError('SelfReview', 'Reviewers cannot review themselves')
  }
  return service.db.transaction().execute(async (tx) => {
    const today = new Date().toISOString().slice(0, 10)
    const count = await tx
      .selectFrom('kyc_review')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('createdAt', '>=', today)
      .executeTakeFirstOrThrow()
    if (Number(count.count) >= cfg.dailyLimit) {
      throw new RewardsError(
        'DailyLimitReached',
        'The daily limit of manual reviews has been reached',
      )
    }

    let apply = true
    if (input.decision === 'approve' && cfg.requireSecondApprover) {
      /*
       * The first approval must be about the account's current state: newer
       * than its last KYC change, and recent
       */
      const record = await service.kycRecord(input.did, tx)
      const since = new Date(
        Date.now() - SECOND_APPROVAL_WINDOW_MS,
      ).toISOString()
      const first = await tx
        .selectFrom('kyc_review')
        .selectAll()
        .where('did', '=', input.did)
        .where('decision', '=', 'approve')
        .where('applied', '=', 0)
        .where('createdAt', '>=', since)
        .where('createdAt', '>', record?.updatedAt ?? '')
        .orderBy('id', 'desc')
        .executeTakeFirst()
      if (first?.reviewerDid === reviewer) {
        throw new RewardsError(
          'SameReviewer',
          'The second approval must come from another reviewer',
        )
      }
      apply = !!first
    }

    const at = new Date().toISOString()
    await tx
      .insertInto('kyc_review')
      .values({
        did: input.did,
        reviewerDid: reviewer,
        decision: input.decision,
        reasonCode: input.reasonCode,
        note: input.note,
        applied: apply ? 1 : 0,
        createdAt: at,
      })
      .execute()
    await service.audit(tx, reviewer, 'kyc.review', input.did, {
      ...input,
      applied: apply,
    })
    if (apply) {
      // Close any approval that was waiting for this one
      await tx
        .updateTable('kyc_review')
        .set({ applied: 1 })
        .where('did', '=', input.did)
        .where('applied', '=', 0)
        .execute()
      await service.setKycStatus(
        reviewer,
        input.did,
        {
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          provider: 'manual',
          rejectReason:
            input.decision === 'reject' ? `manual: ${input.reasonCode}` : null,
        },
        tx,
      )
    }
  })
}

/** Whether an approval of this account waits for a second reviewer */
export async function pendingSecondApproval(
  service: RewardsService,
  dids: string[],
) {
  if (!dids.length) return new Set<string>()
  const rows = await service.db
    .selectFrom('kyc_review')
    .select('did')
    .where('did', 'in', dids)
    .where('decision', '=', 'approve')
    .where('applied', '=', 0)
    .execute()
  return new Set(rows.map((r) => r.did))
}
