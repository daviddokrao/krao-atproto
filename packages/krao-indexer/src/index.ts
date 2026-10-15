import { once } from 'node:events'
import type http from 'node:http'
import { IdResolver } from '@atproto/identity'
import { EvmRpc } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import { FirehoseIndexer } from './indexer.js'
import { createApp } from './server.js'
import { type S3MediaConfig, S3MediaStore } from './media-store.js'
import { createPushClient } from './push-client.js'

export * from './db.js'
export * from './wallets.js'
export * from './tips.js'
export * from './chain.js'
export * from './nft.js'
export * from './gate.js'
export * from './feed.js'

export type KraoIndexerConfig = {
  port: number
  /** SQLite file, or ':memory:'. */
  dbLocation: string
  /** Firehose to index, eg a PDS `wss://` URL or a relay. */
  firehoseUrl: string
  plcUrl: string
  /**
   * Service whose com.atproto.identity.resolveHandle is used when a handle
   * does not resolve through DNS or HTTPS (eg an AppView, or a dev PDS).
   */
  handleResolverUrl?: string
  /** Allow plain http identity lookups. Only for local development. */
  insecureFetch?: boolean
  /** JSON-RPC endpoints by CAIP-2 chain id, used to verify tips */
  rpcUrls?: Record<string, string>
  /** AppView used to hydrate tip senders' profiles */
  appviewUrl?: string
  /** DID this service answers to as a gate service (service auth audience) */
  gateDid?: string
  /** How often verified NFT avatars are re-checked on-chain (default 10m) */
  nftRecheckMs?: number
  /**
   * DID of this service as a feed generator (its DID doc must list it as
   * `#bsky_fg`). Set to serve Krao's "latest" feed.
   */
  feedGenDid?: string
  /** Krao's web app, where short links lead (default https://krao.net) */
  webUrl?: string
  /** Klipy API key for GIF search (GIF media is relayed without one) */
  klipyApiKey?: string
  /** Public URL of this service, for the link preview image URLs it returns */
  publicUrl?: string
  /** Secret that signs gated media URLs; random per process when unset */
  gateMediaSecret?: string
  /** Keep gated media bytes in this S3 bucket instead of the database */
  gateMediaS3?: S3MediaConfig
  /** Krao's push service, to tell people about tips they got */
  push?: { url: string; token: string }
  /** Only feed posts by accounts on this PDS, see FeedIndexingOptions */
  feedPdsUrl?: string
  /** How long feed rankings and suggestions are reused (default 30s, 0: off) */
  discoveryCacheMs?: number
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
    const rpcs = new Map(
      Object.entries(cfg.rpcUrls ?? {}).map(([chain, url]) => [
        chain,
        new EvmRpc(url),
      ]),
    )
    const indexer = new FirehoseIndexer(
      db,
      rpcs,
      idResolver,
      cfg.firehoseUrl,
      (err) => console.error('krao-indexer firehose error', err),
      cfg.nftRecheckMs,
      { did: cfg.feedGenDid, pdsUrl: cfg.feedPdsUrl },
    )
    const mediaBlobs = cfg.gateMediaS3
      ? new S3MediaStore(cfg.gateMediaS3)
      : undefined
    indexer.mediaBlobs = mediaBlobs
    indexer.push = createPushClient(cfg.push?.url, cfg.push?.token)
    return new KraoIndexer(
      cfg,
      db,
      indexer,
      createApp(db, rpcs, idResolver, {
        handleResolverUrl: cfg.handleResolverUrl,
        appviewUrl: cfg.appviewUrl,
        gateDid: cfg.gateDid ?? 'did:web:gate.krao.net',
        feedGenDid: cfg.feedGenDid,
        publicUrl: cfg.publicUrl,
        gateMediaSecret: cfg.gateMediaSecret,
        mediaBlobs,
        klipyApiKey: cfg.klipyApiKey,
        webUrl: cfg.webUrl,
        discoveryCacheMs: cfg.discoveryCacheMs,
      }),
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
