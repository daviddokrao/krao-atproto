import { once } from 'node:events'
import type http from 'node:http'
import { IdResolver } from '@atproto/identity'
import { Appview } from './appview.js'
import { type Database, createDb, migrateDb } from './db.js'
import { createApp } from './server.js'
import { ChatService } from './service.js'

export type KraoChatConfig = {
  port: number
  /**
   * DID this service answers to: PDSes forward chat.bsky.* calls to the
   * `#bsky_chat` service of this DID, with tokens addressed to it
   */
  serviceDid: string
  /** SQLite file, or ':memory:' */
  dbLocation: string
  plcUrl: string
  /** Krao's AppView, for profiles, follows and blocks */
  appviewUrl: string
  /** Public URL of this service, published in its did:web document */
  publicUrl?: string
  /** DIDs of the moderation services that may call chat.bsky.moderation.* */
  moderatorDids?: string[]
  /** Allow plain http identity lookups. Only for local development. */
  insecureFetch?: boolean
}

export class KraoChat {
  private server?: http.Server

  private constructor(
    public cfg: KraoChatConfig,
    public db: Database,
    private app: ReturnType<typeof createApp>,
    private service: ChatService,
  ) {}

  static async create(cfg: KraoChatConfig): Promise<KraoChat> {
    const db = createDb(cfg.dbLocation)
    await migrateDb(db)
    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
      ...(cfg.insecureFetch ? { fetch: globalThis.fetch } : {}),
    })
    const service = new ChatService(db, new Appview(cfg.appviewUrl))
    const app = createApp({
      service,
      idResolver,
      serviceDid: cfg.serviceDid,
      publicUrl: cfg.publicUrl,
      moderatorDids: cfg.moderatorDids,
    })
    return new KraoChat(cfg, db, app, service)
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  private pruneTimer?: NodeJS.Timeout

  async start(): Promise<http.Server> {
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    // The event log has one row per member per event: keep 90 days of it
    this.pruneTimer = setInterval(
      () =>
        void this.service.pruneLog().catch((err: unknown) => {
          console.error('Krao chat: log pruning failed', err)
        }),
      60 * 60 * 1000,
    )
    this.pruneTimer.unref()
    return this.server
  }

  async destroy(): Promise<void> {
    clearInterval(this.pruneTimer)
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
