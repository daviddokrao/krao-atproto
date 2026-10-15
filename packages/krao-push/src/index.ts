import { once } from 'node:events'
import type http from 'node:http'
import { AppviewClient, AppviewNotifications, createPool } from './appview.js'
import { type Database, type Platform, createDb, migrateDb } from './db.js'
import {
  type ApnsConfig,
  ApnsSender,
  type FcmServiceAccount,
  FcmSender,
  LogSender,
  type Sender,
} from './senders.js'
import { createApp } from './server.js'
import { PushService } from './service.js'

export { PushService } from './service.js'
export type { KraoEvent } from './krao-events.js'

export type KraoPushConfig = {
  port: number
  /** SQLite file, or ':memory:' */
  dbLocation: string
  /** API key the AppView uses as its courier key (BSKY_COURIER_API_KEY) */
  courierKey: string
  /** Token of Krao's services for /internal/notify */
  internalToken: string
  /** The AppView's Postgres, whose notifications become pushes */
  appviewDb?: { url: string; schema?: string }
  /** The AppView, to name people and quote posts */
  appviewUrl: string
  /** Real delivery; without either, pushes are only logged */
  fcm?: FcmServiceAccount
  apns?: ApnsConfig
  /** How often the AppView's notifications are read (default 1s) */
  pollMs?: number
}

export class KraoPush {
  private server?: http.Server
  private pruneTimer?: NodeJS.Timeout

  private constructor(
    public cfg: KraoPushConfig,
    public db: Database,
    public push: PushService,
    public notifications: AppviewNotifications | undefined,
    private app: ReturnType<typeof createApp>,
    private senders: Sender[],
  ) {}

  static async create(cfg: KraoPushConfig): Promise<KraoPush> {
    const db = createDb(cfg.dbLocation)
    await migrateDb(db)
    const senders: Partial<Record<Platform, Sender>> = {}
    const logSenders: LogSender[] = []
    if (cfg.fcm) senders.android = new FcmSender(cfg.fcm)
    if (cfg.apns) senders.ios = new ApnsSender(cfg.apns)
    if (!cfg.fcm && !cfg.apns) {
      for (const platform of ['ios', 'android'] as const) {
        const log = new LogSender(platform)
        senders[platform] = log
        logSenders.push(log)
      }
    }
    const push = new PushService(db, senders)
    const appview = new AppviewClient(cfg.appviewUrl)
    const notifications = cfg.appviewDb
      ? new AppviewNotifications(
          createPool(cfg.appviewDb.url, cfg.appviewDb.schema),
          push,
          appview,
          cfg.pollMs,
        )
      : undefined
    const app = createApp(push, appview, {
      courierKey: cfg.courierKey,
      internalToken: cfg.internalToken,
      logSenders: logSenders.length ? logSenders : undefined,
    })
    return new KraoPush(
      cfg,
      db,
      push,
      notifications,
      app,
      Object.values(senders),
    )
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    this.notifications?.start()
    this.pruneTimer = setInterval(
      () =>
        void this.push.pruneSent().catch((err: unknown) => {
          console.error('krao-push: pruning failed', err)
        }),
      60 * 60 * 1000,
    )
    this.pruneTimer.unref()
    return this.server
  }

  async destroy(): Promise<void> {
    clearInterval(this.pruneTimer)
    await this.notifications?.destroy()
    for (const s of this.senders) s.close?.()
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
