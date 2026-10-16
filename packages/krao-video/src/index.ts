import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import type http from 'node:http'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { IdResolver } from '@atproto/identity'
import { PdsRegistry, VideoAuth } from './auth.js'
import { JobStore } from './job-store.js'
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
  /** The job queue's SQLite file (default `<dataDir>/jobs.sqlite`) */
  jobsDbLocation?: string
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
    private jobStore: JobStore,
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
    mkdirSync(dataDir, { recursive: true })
    const jobStore = new JobStore(
      cfg.jobsDbLocation ?? path.join(dataDir, 'jobs.sqlite'),
    )
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
      jobStore,
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
    return new KraoVideo(cfg, uploads, jobs, jobStore, app)
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    // Upload sessions do not survive a restart, but queued videos do
    await this.removeStaleUploads()
    const resumed = await this.jobs.resume()
    if (resumed.length) {
      console.log(`krao-video: resumed ${resumed.length} queued video job(s)`)
    }
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
    this.jobs.close()
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    this.jobStore.close()
  }

  /** Upload folders of sessions lost in a restart, other than queued jobs */
  private async removeStaleUploads() {
    const dir = path.join(path.resolve(this.cfg.dataDir), 'uploads')
    const keep = this.jobs.openWorkDirs()
    const entries = await readdir(dir).catch(() => [] as string[])
    for (const entry of entries) {
      const workDir = path.join(dir, entry)
      if (!keep.has(workDir)) {
        await rm(workDir, { recursive: true, force: true })
      }
    }
  }
}
