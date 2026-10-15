import { once } from 'node:events'
import type http from 'node:http'
import { IdResolver } from '@atproto/identity'
import { AccountDeletions } from './account-events.js'
import { Appview } from './appview.js'
import { type Database, createDb, migrateDb } from './db.js'
import { PhoneGate, type PhoneGateConfig } from './phone-gate.js'
import { createApp } from './server.js'
import { createPushClient } from './push-client.js'
import { ChatService } from './service.js'

const FIREHOSE_CURSOR = 'firehose_cursor'

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
  /** Krao's push service, to tell members about new messages */
  push?: { url: string; token: string }
  /** Sending needs a phone verified with Krao's rewards service (Decree 147) */
  phone?: PhoneGateConfig
  /** The PDS firehose, to remove the chat data of deleted accounts */
  firehoseUrl?: string
}

export class KraoChat {
  private server?: http.Server

  private constructor(
    public cfg: KraoChatConfig,
    public db: Database,
    private app: ReturnType<typeof createApp>,
    private service: ChatService,
    /** Set when phone verification is configured; `cfg.required` is live */
    public phone?: PhoneGate,
    private deletions?: AccountDeletions,
  ) {}

  static async create(cfg: KraoChatConfig): Promise<KraoChat> {
    const db = createDb(cfg.dbLocation)
    await migrateDb(db)
    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
      ...(cfg.insecureFetch ? { fetch: globalThis.fetch } : {}),
    })
    const service = new ChatService(db, new Appview(cfg.appviewUrl))
    service.push = createPushClient(cfg.push?.url, cfg.push?.token)
    const phone = cfg.phone ? new PhoneGate(cfg.phone) : undefined
    const app = createApp({
      service,
      idResolver,
      serviceDid: cfg.serviceDid,
      publicUrl: cfg.publicUrl,
      moderatorDids: cfg.moderatorDids,
      phone,
    })
    const deletions = cfg.firehoseUrl
      ? new AccountDeletions({
          service: cfg.firehoseUrl,
          idResolver,
          getCursor: async () => {
            const row = await db
              .selectFrom('state')
              .select('value')
              .where('key', '=', FIREHOSE_CURSOR)
              .executeTakeFirst()
            return row ? Number(row.value) : undefined
          },
          setCursor: async (seq) => {
            await db
              .insertInto('state')
              .values({ key: FIREHOSE_CURSOR, value: String(seq) })
              .onConflict((oc) =>
                oc.column('key').doUpdateSet({ value: String(seq) }),
              )
              .execute()
          },
          onDeleted: (did) => service.deleteAccount(did),
        })
      : undefined
    return new KraoChat(cfg, db, app, service, phone, deletions)
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
    this.deletions?.start()
    return this.server
  }

  async destroy(): Promise<void> {
    clearInterval(this.pruneTimer)
    await this.deletions?.destroy()
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
