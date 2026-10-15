import { once } from 'node:events'
import type http from 'node:http'
import { IdResolver } from '@atproto/identity'
import { type Database, createDb, migrateDb } from './db.js'
import {
  type ManualReviewConfig,
  type SumsubConfig,
  SumsubProvider,
} from './kyc.js'
import { pushRewardChanges } from './notifications.js'
import {
  type PhoneSecrets,
  PhoneCrypto,
  PhoneService,
  type SmsProvider,
} from './phone.js'
import { type PushClient, createPushClient } from './push-client.js'
import { createApp } from './server.js'
import { RewardsService } from './service.js'

export { RewardsService } from './service.js'
export { SumsubProvider } from './kyc.js'
export {
  HttpSmsProvider,
  LogSmsProvider,
  PhoneService,
  type SmsProvider,
} from './phone.js'

export type KraoRewardsConfig = {
  port: number
  /** DID users address their service auth tokens to */
  serviceDid: string
  /** SQLite file, or ':memory:' */
  dbLocation: string
  plcUrl: string
  /** Shared with the PDS (PDS_KRAO_REWARDS_TOKEN) */
  internalToken: string
  /** Public URL of this service, published in its did:web document */
  publicUrl?: string
  /** May call every admin method */
  adminDids?: string[]
  /** May call the KYC admin methods only */
  kycReviewerDids?: string[]
  /** No provider: users cannot start verification, admins still review */
  sumsub?: SumsubConfig
  manualReview?: Partial<ManualReviewConfig>
  /** Allow plain http identity lookups. Only for local development. */
  insecureFetch?: boolean
  /** Krao's push service, to tell people about points and KYC */
  push?: { url: string; token: string }
  /**
   * A campaign code made at startup if missing, so the first accounts of a
   * new network (the admins) can sign up. Disable it once they have.
   */
  bootstrapCode?: { code: string; maxUses: number }
  /** Phone verification (net.krao.phone.*); unavailable without it */
  phone?: { sms: SmsProvider; secrets: PhoneSecrets }
  /**
   * Development and rehearsals only: with the log SMS driver, the codes sent
   * can be read at /internal/dev/last-otp (internal token)
   */
  devMode?: boolean
}

export class KraoRewards {
  private server?: http.Server
  private pushTimer?: NodeJS.Timeout
  private pruneTimer?: NodeJS.Timeout

  private constructor(
    public cfg: KraoRewardsConfig,
    public db: Database,
    public service: RewardsService,
    public phone: PhoneService | null,
    private admins: Set<string>,
    private app: ReturnType<typeof createApp>,
    private push?: PushClient,
  ) {}

  /** Lets an account call the admin methods (eg one created at startup) */
  addAdmin(did: string) {
    this.admins.add(did)
  }

  static async create(cfg: KraoRewardsConfig): Promise<KraoRewards> {
    const db = createDb(cfg.dbLocation)
    await migrateDb(db)
    const service = new RewardsService(db)
    await service.seedRules()
    if (cfg.bootstrapCode) {
      await service
        .createCode('system', {
          code: cfg.bootstrapCode.code,
          kind: 'campaign',
          maxUses: cfg.bootstrapCode.maxUses,
          note: 'Bootstrap code for the first accounts',
        })
        .catch((err: unknown) => {
          if ((err as { error?: string }).error !== 'CodeTaken') throw err
        })
    }
    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
      ...(cfg.insecureFetch ? { fetch: globalThis.fetch } : {}),
    })
    const admins = new Set(cfg.adminDids ?? [])
    const phone = cfg.phone
      ? new PhoneService(db, new PhoneCrypto(cfg.phone.secrets), cfg.phone.sms)
      : null
    if (phone && cfg.devMode && cfg.phone?.sms.name === 'log') {
      phone.devCodes = new Map()
    }
    const push = createPushClient(cfg.push?.url, cfg.push?.token)
    const app = createApp({
      service,
      idResolver,
      serviceDid: cfg.serviceDid,
      publicUrl: cfg.publicUrl,
      internalToken: cfg.internalToken,
      adminDids: admins,
      kycReviewerDids: new Set(cfg.kycReviewerDids ?? []),
      kycProvider: cfg.sumsub ? new SumsubProvider(cfg.sumsub) : null,
      manualReview: {
        dailyLimit: cfg.manualReview?.dailyLimit ?? 5,
        requireSecondApprover: cfg.manualReview?.requireSecondApprover ?? false,
      },
      phone,
      pushDevices: push ? (did) => push.devices(did) : undefined,
    })
    return new KraoRewards(cfg, db, service, phone, admins, app, push)
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    if (this.phone) {
      const phone = this.phone
      this.pruneTimer = setInterval(
        () =>
          void phone.prune().catch((err: unknown) => {
            console.error('Krao rewards: phone pruning failed', err)
          }),
        60 * 60_000,
      )
      this.pruneTimer.unref()
    }
    if (this.push) {
      const push = this.push
      // Changes from before this start are not announced
      let since = new Date().toISOString()
      let running = false
      this.pushTimer = setInterval(() => {
        if (running) return
        running = true
        pushRewardChanges(this.db, push, since)
          .then((next) => {
            since = next
          })
          .catch((err: unknown) => {
            console.error('Krao rewards: push failed', err)
          })
          .finally(() => {
            running = false
          })
      }, 15_000)
      this.pushTimer.unref()
    }
    return this.server
  }

  async destroy(): Promise<void> {
    clearInterval(this.pushTimer)
    clearInterval(this.pruneTimer)
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
