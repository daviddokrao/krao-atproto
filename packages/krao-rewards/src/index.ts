import { once } from 'node:events'
import type http from 'node:http'
import { IdResolver } from '@atproto/identity'
import { type Database, createDb, migrateDb } from './db.js'
import {
  type ManualReviewConfig,
  type SumsubConfig,
  SumsubProvider,
} from './kyc.js'
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
}

export class KraoRewards {
  private server?: http.Server

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
    return this.server
  }

  async destroy(): Promise<void> {
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
