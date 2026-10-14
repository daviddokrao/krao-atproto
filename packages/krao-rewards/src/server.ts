import { timingSafeEqual } from 'node:crypto'
import cors from 'cors'
import express, { type Express, json as jsonBody, raw } from 'express'
import type { IdResolver } from '@atproto/identity'
import {
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  type MethodAuthContext,
  ResponseType,
  XRPCError,
  createServer,
  verifyJwt,
} from '@atproto/xrpc-server'
import { sql } from 'kysely'
import { catchAsyncErrors, errorHandler } from './async-routes.js'
import type { CodeKind, KycStatus } from './db.js'
import {
  type KycProvider,
  type ManualReviewConfig,
  WebhookSignatureError,
  pendingSecondApproval,
  reviewKyc,
} from './kyc.js'
import { net } from './lexicons/index.js'
import {
  type EntryView,
  RewardsError,
  type RewardsService,
  type Rule,
} from './service.js'

/** Drops null and undefined fields: lexicon outputs omit absent values */
const clean = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && v !== undefined),
  )

const json = (body: unknown) => ({
  encoding: 'application/json' as const,
  body: body as never,
})

const asXrpcError = (err: unknown) =>
  err instanceof RewardsError
    ? new InvalidRequestError(err.message, err.error)
    : err

/** Runs a handler, turning RewardsErrors into XRPC errors */
const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn()
  } catch (err) {
    throw asXrpcError(err)
  }
}

const entryView = (e: EntryView) =>
  clean({
    id: e.id,
    amount: e.amount,
    status: e.status,
    ruleId: e.ruleId,
    relatedDid: e.relatedDid,
    waitingFor: e.waitingFor,
    note: e.note,
    createdAt: e.createdAt,
    decidedAt: e.decidedAt,
  })

const ruleView = (r: Rule) => clean(r)

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A small fixed window limit per client IP, for the public code check */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (key: string) => {
    const at = Date.now()
    const hit = hits.get(key)
    if (!hit || hit.resetAt <= at) {
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= at) hits.delete(k)
      }
      hits.set(key, { count: 1, resetAt: at + 60_000 })
      return true
    }
    hit.count++
    return hit.count <= perMinute
  }
}

export type AppOptions = {
  service: RewardsService
  idResolver: IdResolver
  /** DID users address their service auth tokens to */
  serviceDid: string
  publicUrl?: string
  /** Shared with the PDS, for /internal/referrals */
  internalToken: string
  /** May call every admin method (a live set: admins can be added) */
  adminDids: Set<string>
  /** May call the KYC admin methods only */
  kycReviewerDids: Set<string>
  kycProvider: KycProvider | null
  manualReview: ManualReviewConfig
}

export function createApp(opts: AppOptions): Express {
  const { service, idResolver, serviceDid } = opts
  const isAdmin = (did: string) => opts.adminDids.has(did)
  const isReviewer = (did: string) =>
    opts.adminDids.has(did) || opts.kycReviewerDids.has(did)
  const checkCodeLimit = rateLimiter(30)
  const server = createServer([], {})

  /*
   * Users call this service directly with atproto service auth: a short
   * lived JWT from their PDS (com.atproto.server.getServiceAuth), addressed
   * to this service and the method.
   */
  const userAuth = async ({ req }: MethodAuthContext) => {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Bearer ')) {
      throw new AuthRequiredError('Service auth token required')
    }
    const nsid = (req.url ?? '').split('?')[0].replace(/^\/xrpc\//, '')
    const payload = await verifyJwt(
      header.slice('Bearer '.length),
      serviceDid,
      nsid,
      (iss, forceRefresh) =>
        idResolver.did.resolveAtprotoKey(iss.split('#')[0], forceRefresh),
    )
    return { credentials: { did: payload.iss.split('#')[0] } }
  }

  const roleAuth =
    (allowed: (did: string) => boolean) => async (ctx: MethodAuthContext) => {
      const result = await userAuth(ctx)
      if (!allowed(result.credentials.did)) {
        throw new ForbiddenError('Only Krao admins may call this')
      }
      return result
    }
  const adminAuth = roleAuth(isAdmin)
  const reviewerAuth = roleAuth(isReviewer)

  const did = (auth: { credentials: unknown }) =>
    (auth.credentials as { did: string }).did

  // Referrals
  // ---------

  server.add(net.krao.referral.checkCode, async ({ params, req }) => {
    if (!checkCodeLimit(req.ip ?? 'unknown')) {
      throw new XRPCError(
        ResponseType.RateLimitExceeded,
        'Too many code checks, try again in a minute',
      )
    }
    const check = await service.checkCode(params.code)
    return json(
      check.valid
        ? clean({ valid: true, referrer: check.code.ownerDid })
        : { valid: false },
    )
  })

  server.add(net.krao.referral.getOverview, {
    auth: userAuth,
    handler: async ({ auth }) => {
      const viewer = did(auth)
      const code = await service.personalCode(viewer)
      const [referral, counts, points] = await Promise.all([
        service.db
          .selectFrom('referral')
          .select('referrerDid')
          .where('did', '=', viewer)
          .executeTakeFirst(),
        service.db
          .selectFrom('referral')
          .leftJoin('kyc_record', 'kyc_record.did', 'referral.did')
          .select((eb) => [
            eb.fn.countAll<number>().as('total'),
            eb.fn
              .sum<number>(
                eb
                  .case()
                  .when('kyc_record.status', '=', 'approved')
                  .then(1)
                  .else(0)
                  .end(),
              )
              .as('verified'),
          ])
          .where('referral.referrerDid', '=', viewer)
          .executeTakeFirstOrThrow(),
        service.personalReferralPoints(),
      ])
      return json(
        clean({
          code,
          invitedBy: referral?.referrerDid,
          referralCount: Number(counts.total ?? 0),
          verifiedCount: Number(counts.verified ?? 0),
          inviterPoints: points.referrer || undefined,
          inviteePoints: points.actor || undefined,
        }),
      )
    },
  })

  server.add(net.krao.referral.listReferrals, {
    auth: userAuth,
    handler: async ({ auth, params }) => {
      const limit = params.limit ?? 50
      let query = service.db
        .selectFrom('referral')
        .leftJoin('kyc_record', 'kyc_record.did', 'referral.did')
        .select([
          'referral.did',
          'referral.createdAt',
          'kyc_record.status as kycStatus',
        ])
        .where('referral.referrerDid', '=', did(auth))
        .orderBy('referral.createdAt', 'desc')
        .orderBy('referral.did', 'desc')
        .limit(limit)
      if (params.cursor) {
        const [createdAt, cursorDid] = params.cursor.split('::')
        query = query.where((eb) =>
          eb.or([
            eb('referral.createdAt', '<', createdAt),
            eb.and([
              eb('referral.createdAt', '=', createdAt),
              eb('referral.did', '<', cursorDid ?? ''),
            ]),
          ]),
        )
      }
      const rows = await query.execute()
      const last = rows[rows.length - 1]
      return json(
        clean({
          referrals: rows.map((r) => ({
            did: r.did,
            joinedAt: r.createdAt,
            verified: r.kycStatus === 'approved',
          })),
          cursor:
            rows.length === limit && last
              ? `${last.createdAt}::${last.did}`
              : undefined,
        }),
      )
    },
  })

  // Points
  // ------

  server.add(net.krao.points.getBalance, {
    auth: userAuth,
    handler: async ({ auth }) => json(await service.balance(did(auth))),
  })

  server.add(net.krao.points.listEntries, {
    auth: userAuth,
    handler: async ({ auth, params }) => {
      const page = await service.listEntries(
        did(auth),
        params.limit ?? 50,
        params.cursor,
      )
      return json(
        clean({ entries: page.entries.map(entryView), cursor: page.cursor }),
      )
    },
  })

  // KYC
  // ---

  server.add(net.krao.kyc.getStatus, {
    auth: userAuth,
    handler: async ({ auth }) => {
      const record = await service.kycRecord(did(auth))
      return json(
        clean({
          status: record?.status ?? 'none',
          available: !!opts.kycProvider,
          updatedAt: record?.updatedAt,
        }),
      )
    },
  })

  server.add(net.krao.kyc.startVerification, {
    auth: userAuth,
    handler: async ({ auth }) => {
      const viewer = did(auth)
      if (!opts.kycProvider) {
        throw new InvalidRequestError(
          'Identity verification is not available yet',
          'KycUnavailable',
        )
      }
      const record = await service.kycRecord(viewer)
      if (record?.status === 'approved') {
        throw new InvalidRequestError(
          'Your identity is already verified',
          'AlreadyVerified',
        )
      }
      if (record?.status === 'rejected') {
        throw new InvalidRequestError(
          'Identity verification was rejected and cannot be retried',
          'VerificationClosed',
        )
      }
      return json(await opts.kycProvider.startSession(viewer))
    },
  })

  // Admin
  // -----

  server.add(net.krao.rewards.getRoles, {
    auth: userAuth,
    handler: async ({ auth }) => {
      const viewer = did(auth)
      const roles = [
        ...(isAdmin(viewer) ? ['admin'] : []),
        ...(isReviewer(viewer) ? ['kyc_reviewer'] : []),
      ]
      return json({ roles })
    },
  })

  const admin = net.krao.rewards.admin

  server.add(admin.listKyc, {
    auth: reviewerAuth,
    handler: async ({ params }) => {
      const limit = params.limit ?? 50
      let query = service.db
        .selectFrom('kyc_record')
        .selectAll()
        .orderBy('updatedAt', 'desc')
        .orderBy('did', 'desc')
        .limit(limit)
      if (params.status) {
        query = query.where('status', '=', params.status as KycStatus)
      }
      if (params.did) query = query.where('did', '=', params.did)
      if (params.cursor) {
        const [updatedAt, cursorDid] = params.cursor.split('::')
        query = query.where((eb) =>
          eb.or([
            eb('updatedAt', '<', updatedAt),
            eb.and([
              eb('updatedAt', '=', updatedAt),
              eb('did', '<', cursorDid ?? ''),
            ]),
          ]),
        )
      }
      const rows = await query.execute()
      const waiting = await pendingSecondApproval(
        service,
        rows.map((r) => r.did),
      )
      const last = rows[rows.length - 1]
      return json(
        clean({
          records: rows.map((r) =>
            clean({
              did: r.did,
              status: r.status,
              provider: r.provider,
              rejectReason: r.rejectReason,
              pendingSecondApproval: waiting.has(r.did),
              updatedAt: r.updatedAt,
            }),
          ),
          cursor:
            rows.length === limit && last
              ? `${last.updatedAt}::${last.did}`
              : undefined,
        }),
      )
    },
  })

  server.add(admin.reviewKyc, {
    auth: reviewerAuth,
    handler: async ({ auth, input }) =>
      wrap(async () => {
        await reviewKyc(service, opts.manualReview, did(auth), {
          did: input.body.did,
          decision: input.body.decision as 'approve' | 'reject',
          reasonCode: input.body.reasonCode,
          note: input.body.note,
        })
        const record = await service.kycRecord(input.body.did)
        const waiting = await pendingSecondApproval(service, [input.body.did])
        return json(
          clean({
            did: input.body.did,
            status: record?.status ?? 'none',
            provider: record?.provider,
            rejectReason: record?.rejectReason,
            pendingSecondApproval: waiting.has(input.body.did),
            updatedAt: record?.updatedAt ?? new Date().toISOString(),
          }),
        )
      }),
  })

  const codeView = async (code: Awaited<ReturnType<typeof service.getCode>>) =>
    clean({
      ...code!,
      disabled: !!code!.disabled,
      uses: await service.codeUses(service.db, code!.code),
    })

  server.add(admin.createCode, {
    auth: adminAuth,
    handler: async ({ auth, input }) =>
      wrap(async () => {
        const row = await service.createCode(did(auth), {
          ...input.body,
          kind: input.body.kind as CodeKind,
        })
        return json(await codeView(row))
      }),
  })

  server.add(admin.updateCode, {
    auth: adminAuth,
    handler: async ({ auth, input }) =>
      wrap(async () => {
        const row = await service.updateCode(did(auth), input.body)
        return json(await codeView(row))
      }),
  })

  server.add(admin.listCodes, {
    auth: adminAuth,
    handler: async ({ params }) => {
      const limit = params.limit ?? 50
      let query = service.db
        .selectFrom('referral_code')
        .selectAll()
        .orderBy('createdAt', 'desc')
        .orderBy('code', 'desc')
        .limit(limit)
      if (params.kind) query = query.where('kind', '=', params.kind as CodeKind)
      if (params.ownerDid) query = query.where('ownerDid', '=', params.ownerDid)
      if (params.cursor) {
        const [createdAt, code] = params.cursor.split('::')
        query = query.where((eb) =>
          eb.or([
            eb('createdAt', '<', createdAt),
            eb.and([
              eb('createdAt', '=', createdAt),
              eb('code', '<', code ?? ''),
            ]),
          ]),
        )
      }
      const rows = await query.execute()
      const last = rows[rows.length - 1]
      return json(
        clean({
          codes: await Promise.all(rows.map(codeView)),
          cursor:
            rows.length === limit && last
              ? `${last.createdAt}::${last.code}`
              : undefined,
        }),
      )
    },
  })

  server.add(admin.listRules, {
    auth: adminAuth,
    handler: async () =>
      json({ rules: (await service.listRules()).map(ruleView) }),
  })

  server.add(admin.upsertRule, {
    auth: adminAuth,
    handler: async ({ auth, input }) => {
      const body = input.body
      const rule = await service.upsertRule(did(auth), {
        id: body.id,
        enabled: body.enabled,
        description: body.description ?? null,
        event: body.event as Rule['event'],
        beneficiary: body.beneficiary as Rule['beneficiary'],
        amount: body.amount,
        vesting: body.vesting as Rule['vesting'],
        codeKinds: (body.codeKinds ?? []) as Rule['codeKinds'],
        campaignId: body.campaignId ?? null,
        validFrom: body.validFrom ?? null,
        validUntil: body.validUntil ?? null,
        capPerBeneficiary: body.capPerBeneficiary ?? null,
        capPerDay: body.capPerDay ?? null,
      })
      return json(ruleView(rule))
    },
  })

  server.add(admin.adjustPoints, {
    auth: adminAuth,
    handler: async ({ auth, input }) => {
      const entry = await service.adjustPoints(
        did(auth),
        input.body.did,
        input.body.amount,
        input.body.note,
      )
      return json(entryView(entry))
    },
  })

  server.add(admin.revokePoints, {
    auth: adminAuth,
    handler: async ({ auth, input }) =>
      json(
        await service.revokePoints(did(auth), input.body.did, input.body.note),
      ),
  })

  server.add(admin.listAuditLog, {
    auth: adminAuth,
    handler: async ({ params }) => {
      const limit = params.limit ?? 50
      let query = service.db
        .selectFrom('audit_log')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(limit)
      if (params.subject) query = query.where('subject', '=', params.subject)
      if (params.cursor) query = query.where('id', '<', Number(params.cursor))
      const rows = await query.execute()
      const last = rows[rows.length - 1]
      return json(
        clean({
          entries: rows.map((r) => clean(r)),
          cursor: rows.length === limit && last ? String(last.id) : undefined,
        }),
      )
    },
  })

  // HTTP routes
  // -----------

  const app = express()
  catchAsyncErrors(app)
  // Client addresses (for the code check limit) come from a proxy on a
  // private network (eg Caddy); others cannot set X-Forwarded-For
  app.set('trust proxy', 'loopback, linklocal, uniquelocal')
  app.use(cors())
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Krao rewards service. Health: /_health')
  })
  app.get('/_health', async (_req, res) => {
    try {
      await sql`select 1`.execute(service.db)
      res.json({ ok: true, did: serviceDid })
    } catch {
      res.status(503).json({ ok: false, did: serviceDid, error: 'Database' })
    }
  })

  /*
   * The PDS's routes: code checks at sign-up (every sign-up comes from the
   * PDS's address, so they skip the public rate limit) and sign-ups from its
   * referral outbox. Guarded by a secret shared with the PDS.
   */
  const internalAuth: express.RequestHandler = (req, res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!opts.internalToken || !sameSecret(token, opts.internalToken)) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }

  app.get('/internal/check-code', internalAuth, (req, res, next) => {
    const code = typeof req.query.code === 'string' ? req.query.code : ''
    service
      .checkCode(code)
      .then((check) => res.json({ valid: check.valid }))
      .catch(next)
  })

  app.post(
    '/internal/referrals',
    internalAuth,
    jsonBody({ limit: '10kb' }),
    (req, res, next) => {
      const { did, code, createdAt } = req.body ?? {}
      if (
        typeof did !== 'string' ||
        !did.startsWith('did:') ||
        typeof code !== 'string' ||
        typeof createdAt !== 'string'
      ) {
        res.status(400).json({ error: 'InvalidRequest' })
        return
      }
      service
        .recordReferral(did, code, createdAt)
        .then(() => res.json({ ok: true }))
        .catch(next)
    },
  )

  /*
   * Takedowns by moderators: the account's points are taken back and it
   * earns nothing until the takedown is lifted
   */
  app.post(
    '/internal/takedowns',
    internalAuth,
    jsonBody({ limit: '10kb' }),
    (req, res, next) => {
      const { did, applied } = req.body ?? {}
      if (typeof did !== 'string' || !did.startsWith('did:')) {
        res.status(400).json({ error: 'InvalidRequest' })
        return
      }
      ;(applied === false ? service.liftTakedown(did) : service.takeDown(did))
        .then(() => res.json({ ok: true }))
        .catch(next)
    },
  )

  // Verification outcomes from the KYC provider, checked by signature
  app.post(
    '/webhooks/:provider',
    raw({ type: '*/*', limit: '1mb' }),
    (req, res, next) => {
      const provider = opts.kycProvider
      if (!provider || req.params.provider !== provider.name) {
        res.status(404).json({ error: 'NotFound' })
        return
      }
      let outcome
      try {
        outcome = provider.parseWebhook(
          req.headers,
          Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        )
      } catch (err) {
        if (err instanceof WebhookSignatureError) {
          res.status(401).json({ error: 'InvalidSignature' })
          return
        }
        if (err instanceof SyntaxError) {
          res.status(400).json({ error: 'InvalidRequest' })
          return
        }
        return next(err)
      }
      if (!outcome) {
        res.json({ ok: true })
        return
      }
      service
        .setKycStatus(provider.name, outcome.did, {
          status: outcome.status,
          provider: provider.name,
          providerRef: outcome.providerRef,
          rejectReason: outcome.rejectReason,
          duplicate: outcome.duplicate,
        })
        .then(() => res.json({ ok: true }))
        .catch(next)
    },
  )

  if (opts.publicUrl && serviceDid.startsWith('did:web:')) {
    app.get('/.well-known/did.json', (_req, res) => {
      res.json({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: serviceDid,
        service: [
          {
            id: '#krao_rewards',
            type: 'KraoRewardsService',
            serviceEndpoint: opts.publicUrl,
          },
        ],
      })
    })
  }
  app.use(server.router)
  app.use(errorHandler)
  return app
}
