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
import { type PushClient, createPushClient } from './push-client.js'
import { createApp } from './server.js'
import { RewardsService } from './service.js'

export { RewardsService } from './service.js'
export { SumsubProvider } from './kyc.js'

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
}

export class KraoRewards {
  private server?: http.Server
  private pushTimer?: NodeJS.Timeout
  private push?: PushClient

  private constructor(
    public cfg: KraoRewardsConfig,
    public db: Database,
    public service: RewardsService,
    private admins: Set<string>,
    private app: ReturnType<typeof createApp>,
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
    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
      ...(cfg.insecureFetch ? { fetch: globalThis.fetch } : {}),
    })
    const admins = new Set(cfg.adminDids ?? [])
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
    })
    return new KraoRewards(cfg, db, service, admins, app)
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    this.push = createPushClient(this.cfg.push?.url, this.cfg.push?.token)
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
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
