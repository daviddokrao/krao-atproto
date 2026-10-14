import { once } from 'node:events'
import type http from 'node:http'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { IdResolver } from '@atproto/identity'
import { PdsRegistry, VideoAuth } from './auth.js'
import { JobQueue, type ProcessingLimits } from './jobs.js'
import { createApp } from './server.js'
import {
  DEFAULT_LIMITS,
  Quotas,
  type UploadLimits,
  UploadStore,
} from './uploads.js'

export { hlsDir } from './jobs.js'

export type KraoVideoConfig = {
  port: number
  /** DID this service answers to (the audience of getUploadLimits tokens) */
  serviceDid: string
  /** Where uploads are staged and HLS files are kept */
  dataDir: string
  plcUrl: string
  /**
   * PDSes whose accounts may upload, as `<public url>` or `<public
   * url>=<internal url>` when this service reaches the PDS at another address
   */
  pdsUrls: string[]
  /** Public URL of this service, published in its did:web document */
  publicUrl?: string
  /** Allow plain http identity lookups. Only for local development. */
  insecureFetch?: boolean
  limits?: Partial<UploadLimits & ProcessingLimits>
  /** Videos processed at once (default 1) */
  concurrency?: number
  ffmpegPath?: string
  ffprobePath?: string
}

const SWEEP_INTERVAL_MS = 60_000

export class KraoVideo {
  private server?: http.Server
  private sweeper?: NodeJS.Timeout

  private constructor(
    public cfg: KraoVideoConfig,
    private uploads: UploadStore,
    private jobs: JobQueue,
    private app: ReturnType<typeof createApp>,
  ) {}

  static create(cfg: KraoVideoConfig): KraoVideo {
    const dataDir = path.resolve(cfg.dataDir)
    const limits: UploadLimits = { ...DEFAULT_LIMITS }
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof UploadLimits)[]) {
      const value = cfg.limits?.[key]
      if (value !== undefined) limits[key] = value
    }
    const idResolver = new IdResolver({
      plcUrl: cfg.plcUrl,
      ...(cfg.insecureFetch ? { fetch: globalThis.fetch } : {}),
    })
    const quotas = new Quotas(limits)
    const uploads = new UploadStore(dataDir, limits, quotas)
    const jobs = new JobQueue(
      dataDir,
      {
        ffmpeg: cfg.ffmpegPath ?? 'ffmpeg',
        ffprobe: cfg.ffprobePath ?? 'ffprobe',
      },
      { maxDurationSec: cfg.limits?.maxDurationSec ?? 3 * 60 },
      cfg.concurrency ??
        Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))),
    )
    const auth = new VideoAuth(
      idResolver,
      cfg.serviceDid,
      new PdsRegistry(cfg.pdsUrls),
    )
    const app = createApp({
      auth,
      uploads,
      quotas,
      jobs,
      limits,
      dataDir,
      serviceDid: cfg.serviceDid,
      publicUrl: cfg.publicUrl,
    })
    return new KraoVideo(cfg, uploads, jobs, app)
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    this.sweeper = setInterval(() => {
      this.uploads.sweep()
      this.jobs.sweep()
    }, SWEEP_INTERVAL_MS)
    this.sweeper.unref()
    return this.server
  }

  async destroy(): Promise<void> {
    clearInterval(this.sweeper)
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
  }
}
