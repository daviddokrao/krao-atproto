import { once } from 'node:events'
import type http from 'node:http'
import { IdResolver } from '@atproto/identity'
import { type Database, createDb, migrateDb } from './db.js'
import { FirehoseIndexer } from './indexer.js'
import { createApp } from './server.js'

export * from './db.js'
export * from './wallets.js'

export type KraoIndexerConfig = {
  port: number
  /** SQLite file, or ':memory:'. */
  dbLocation: string
  /** Firehose to index, eg `wss://bsky.network` or a PDS `ws://` URL. */
  firehoseUrl: string
  plcUrl: string
  /**
   * Service whose com.atproto.identity.resolveHandle is used when a handle
   * does not resolve through DNS or HTTPS (eg an AppView, or a dev PDS).
   */
  handleResolverUrl?: string
  /** Allow plain http identity lookups. Only for local development. */
  insecureFetch?: boolean
}

export class KraoIndexer {
  private server?: http.Server

  private constructor(
    public cfg: KraoIndexerConfig,
    public db: Database,
    public indexer: FirehoseIndexer,
    private app: ReturnType<typeof createApp>,
  ) {}

  static async create(cfg: KraoIndexerConfig): Promise<KraoIndexer> {
    const db = createDb(cfg.dbLocation)
    await migrateDb(db)
    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
      ...(cfg.insecureFetch ? { fetch: globalThis.fetch } : {}),
    })
    const indexer = new FirehoseIndexer(
      db,
      idResolver,
      cfg.firehoseUrl,
      (err) => console.error('krao-indexer firehose error', err),
    )
    return new KraoIndexer(
      cfg,
      db,
      indexer,
      createApp(db, idResolver, cfg.handleResolverUrl),
    )
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.indexer.start()
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    return this.server
  }

  async destroy(): Promise<void> {
    await this.indexer.destroy()
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
