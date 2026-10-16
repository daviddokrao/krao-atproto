import { once } from 'node:events'
import type http from 'node:http'
import { rpcForChains } from '@krao/wallet'
import { IdResolver } from '@atproto/identity'
import {
  AdminAuditOutbox,
  RewardsAuditSender,
  RewardsRoles,
  roleCheck,
} from './admin-roles.js'
import { EvmRpc } from './chain.js'
import { type Database, createDb, migrateDb } from './db.js'
import { HolderFeeds } from './holders.js'
import { FirehoseIndexer } from './indexer.js'
import { RewardsHumanCheck } from './human.js'
import { RewardsEventsClient } from './rewards-events.js'
import { createApp } from './server.js'
import { type S3MediaConfig, S3MediaStore } from './media-store.js'
import { createPushClient } from './push-client.js'
import { SafetyList } from './safety.js'
import { TokenCatalog } from './token.js'

export * from './db.js'
export * from './wallets.js'
export * from './tips.js'
export * from './membership.js'
export * from './creator.js'
export * from './chain.js'
export * from './nft.js'
export * from './gate.js'
export * from './feed.js'
export * from './safety.js'
export * from './address-check.js'
export * from './token.js'
export * from './names.js'
export * from './language.js'
export * from './onchain.js'
export * from './holders.js'
export * from './miniapp.js'
export * from './admin-roles.js'

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
  /**
   * JSON-RPC endpoints by CAIP-2 chain id, used to verify tips and smart
   * contract wallet links
   */
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
  /**
   * Moderator accounts and moderation services (eg Krao's Ozone) that may
   * read gated content, with every read logged
   */
  gateModeratorDids?: string[]
  /** Whether moderators may read gated content (default true) */
  gateModerationAccess?: boolean
  /**
   * Open phishing list to sync every 6 hours, in the shape of MetaMask's
   * eth-phishing-detect config.json. Unset: only built-in and admin entries.
   */
  phishingListUrl?: string
  /** Accounts that may change the unsafe domain list */
  safetyAdminDids?: string[]
  /**
   * Krao's rewards service, asked whether an account verified a phone or
   * passed KYC ("verified" communities and polls), and told about first
   * wallets and first posts (/internal/events). Also the source of Krao
   * admin roles (safety, moderator) beyond the DIDs above, and keeper of
   * the shared admin log (M35). Unset: nobody counts as verified, no
   * events are sent, only the DIDs above are admins.
   */
  rewards?: { url: string; token: string }
  /**
   * Ethereum mainnet JSON-RPC, for verified ENS names next to handles
   * (default: rpcUrls['eip155:1']). Unset: Basenames only.
   */
  ensRpcUrl?: string
  /**
   * Token catalog prices: the Uniswap v3 factory on Base whose pools price
   * the tokens (default Uniswap's), and how often prices are read (default
   * 5 minutes). Prices need an RPC for eip155:8453 in rpcUrls.
   */
  tokens?: { factory?: string; sampleIntervalMs?: number }
  /**
   * The holders-<symbol> feeds: the value in US dollars a holder's wallets
   * must hold (default 1), and how long balances are reused (default 15
   * minutes, 0: off)
   */
  holderFeed?: { minUsd?: number; cacheMs?: number }
  /**
   * Krao's official accounts (eg krao.net's): only holders-<symbol> feed
   * generators they publish are linked from token pages. Empty: none are.
   */
  officialFeedDids?: string[]
  /**
   * Development: Mini Apps may be served from http://localhost (any port).
   * Never in production.
   */
  devMode?: boolean
  /**
   * Krao's PDS over http(s), where Mini App icons are read from (default:
   * the firehose URL as http)
   */
  pdsUrl?: string
  /** Transaction previews: contracts Krao knows beyond its token and NFT catalogs */
  knownContracts?: string[]
  /** Transaction previews: EIP-7702 delegate contracts Krao trusts (none by default) */
  knownDelegates?: string[]
  /** How long the on-chain profile tab reuses NFT holdings (default 10 min, 0: off) */
  onchainCacheMs?: number
}

export class KraoIndexer {
  private server?: http.Server
  private auditTimer?: NodeJS.Timeout
  private auditRunning = false

  private constructor(
    public cfg: KraoIndexerConfig,
    public db: Database,
    public indexer: FirehoseIndexer,
    private app: ReturnType<typeof createApp>,
    private gateModerators: Set<string>,
    public safety: SafetyList,
    private safetyAdmins: Set<string>,
    public tokens: TokenCatalog,
    private officialFeedDids: Set<string>,
    public audit: AdminAuditOutbox,
  ) {
    audit.onQueued = () => this.deliverAudit()
  }

  /** Sends queued admin log entries to the rewards service */
  private deliverAudit() {
    if (this.auditRunning) return
    this.auditRunning = true
    this.audit
      .deliver()
      .catch((err: unknown) =>
        console.error('Krao indexer: admin log delivery failed', err),
      )
      .finally(() => {
        this.auditRunning = false
      })
  }

  /** Makes an account official for token holder feeds (eg one made at startup) */
  addOfficialFeedDid(did: string) {
    this.officialFeedDids.add(did)
  }

  /** Lets an account read gated content as a moderator (eg one made at startup) */
  addGateModerator(did: string) {
    this.gateModerators.add(did)
  }

  /** Lets an account change the unsafe domain list (eg one made at startup) */
  addSafetyAdmin(did: string) {
    this.safetyAdmins.add(did)
  }

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
    indexer.walletRpc = rpcForChains(cfg.rpcUrls ?? {})
    const safety = new SafetyList(db, {
      listUrl: cfg.phishingListUrl,
      allowHttp: cfg.insecureFetch,
    })
    await safety.init()
    indexer.safety = safety
    const human = cfg.rewards
      ? new RewardsHumanCheck(cfg.rewards.url, cfg.rewards.token)
      : undefined
    indexer.human = human
    // First verified wallet and first post, rewarded by the rewards service
    indexer.rewardsEvents = cfg.rewards
      ? new RewardsEventsClient(cfg.rewards.url, cfg.rewards.token)
      : undefined
    const ensRpcUrl = cfg.ensRpcUrl ?? cfg.rpcUrls?.['eip155:1']
    indexer.ensRpc = ensRpcUrl ? new EvmRpc(ensRpcUrl) : undefined
    // Mini Apps may not be served from Krao's own web app origin
    indexer.miniAppRules = {
      devMode: cfg.devMode,
      webOrigins: [cfg.webUrl ?? 'https://krao.net'],
    }
    const tokens = new TokenCatalog(db, {
      rpc: rpcs.get('eip155:8453'),
      factory: cfg.tokens?.factory,
      sampleIntervalMs: cfg.tokens?.sampleIntervalMs,
    })
    await tokens.init()
    indexer.tokens = tokens
    const gateModerators = new Set(cfg.gateModeratorDids ?? [])
    const safetyAdmins = new Set(cfg.safetyAdminDids ?? [])
    // M35: roles granted in the app (rewards service) count too
    const roles = cfg.rewards
      ? new RewardsRoles(cfg.rewards.url, cfg.rewards.token)
      : undefined
    const audit = new AdminAuditOutbox(
      db,
      cfg.rewards
        ? new RewardsAuditSender(cfg.rewards.url, cfg.rewards.token)
        : undefined,
    )
    const officialFeedDids = new Set(cfg.officialFeedDids ?? [])
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
        gateModerators: roleCheck(gateModerators, 'moderator', roles),
        gateModerationAccess: cfg.gateModerationAccess,
        safety,
        safetyAdmins: roleCheck(safetyAdmins, 'safety', roles),
        audit,
        replayFailedEvents: (limit) => indexer.replayFailedEvents(limit),
        human,
        tokens,
        holderFeeds: new HolderFeeds(db, {
          rpc: rpcs.get('eip155:8453'),
          minUsd: cfg.holderFeed?.minUsd,
          cacheMs: cfg.holderFeed?.cacheMs,
        }),
        officialFeedDids,
        onchainCacheMs: cfg.onchainCacheMs,
        pdsUrl: cfg.pdsUrl ?? cfg.firehoseUrl.replace(/^ws/, 'http'),
        knownContracts: cfg.knownContracts,
        knownDelegates: cfg.knownDelegates,
      }),
      gateModerators,
      safety,
      safetyAdmins,
      tokens,
      officialFeedDids,
      audit,
    )
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.indexer.start()
    this.safety.start()
    this.tokens.start()
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    // Retries of the admin log (entries are sent as soon as they are queued)
    this.auditTimer = setInterval(() => this.deliverAudit(), 15_000)
    this.auditTimer.unref()
    return this.server
  }

  async destroy(): Promise<void> {
    clearInterval(this.auditTimer)
    await this.indexer.destroy()
    await this.safety.destroy()
    await this.tokens.destroy()
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
