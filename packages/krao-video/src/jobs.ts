import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob } from 'node:fs'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { cidForRawHash, getBlobCidString, xrpc } from '@atproto/lex'
import {
  type FfmpegTools,
  type ProbeResult,
  encodeHls,
  probe,
  toPlayableMp4,
} from './ffmpeg.js'
import type { JobStore } from './job-store.js'
import { type app, com } from './lexicons/index.js'

export type JobStatus = app.bsky.video.defs.JobStatus

export type ProcessingLimits = {
  /** Longest video accepted, in seconds */
  maxDurationSec: number
}

/** A finished upload waiting to become a video */
export type VideoJob = {
  jobId: string
  did: string
  /** The assembled upload */
  source: string
  /** Folder holding the upload, removed when the job ends */
  workDir: string
  /** Where to upload the blob: the account's PDS, as this service reaches it */
  pdsUrl: string
  /** The account's service auth token for com.atproto.repo.uploadBlob */
  token: string
  /** Called when the job fails, to give the upload allowance back */
  onFailed?: () => void
}

type Blob = NonNullable<JobStatus['blob']>

type FailureCode =
  | 'validation_failure'
  | 'encoding_failure'
  | 'pds_upload_failure'
  | 'pds_upload_unsupported_blob_size'
  | 'generic_failure'

class JobFailure extends Error {
  constructor(
    public code: FailureCode,
    message: string,
  ) {
    super(message)
  }
}

/** Finished jobs stay readable through getJobStatus for this long */
const RETENTION_MS = 24 * 60 * 60 * 1000

/** A job interrupted by restarts this many times is given up */
export const MAX_JOB_ATTEMPTS = 3

/** Where a video's HLS files live: `<dataDir>/hls/<did>/<cid>` */
export function hlsDir(dataDir: string, did: string, cid: string) {
  return path.join(dataDir, 'hls', did, cid)
}

async function exists(file: string) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** When a JWT expires (its exp claim), in ms; undefined if unreadable */
export function tokenExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

async function sha256File(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return new Uint8Array(hash.digest())
}

/**
 * Runs uploaded videos through probe -> mp4 -> HLS -> PDS upload, a few at a
 * time. Jobs are kept in a {@link JobStore}: after a restart, `resume` puts
 * waiting and interrupted jobs back in line (up to {@link MAX_JOB_ATTEMPTS}
 * starts each), and finished ones stay readable for {@link RETENTION_MS}.
 */
export class JobQueue {
  private statuses = new Map<string, { status: JobStatus; endedAt?: number }>()
  private queue: VideoJob[] = []
  private running = 0
  private closed = false
  /** Encodes in progress by HLS folder, so a video is only encoded once */
  private encoding = new Map<string, Promise<void>>()

  constructor(
    private dataDir: string,
    private tools: FfmpegTools,
    private limits: ProcessingLimits,
    private concurrency: number,
    private store: JobStore,
    /** The daily allowance: resumed jobs count again, and are refunded */
    private quota?: {
      charge(did: string, bytes: number): void
      release(did: string, bytes: number): void
    },
  ) {}

  get(jobId: string): JobStatus | undefined {
    return this.statuses.get(jobId)?.status
  }

  add(job: VideoJob): JobStatus {
    const status: JobStatus = {
      jobId: job.jobId,
      did: job.did as JobStatus['did'],
      state: 'JOB_STATE_CREATED',
    }
    this.store.insert({
      jobId: job.jobId,
      did: job.did,
      status,
      source: job.source,
      workDir: job.workDir,
      pdsUrl: job.pdsUrl,
      token: job.token,
      createdAt: Date.now(),
    })
    this.statuses.set(job.jobId, { status })
    this.queue.push(job)
    this.next()
    return status
  }

  /**
   * Loads the stored jobs after a restart. Jobs that were waiting or running
   * go back in line and start over from the uploaded file (an HLS encode
   * that finished is reused). Returns the ids of the jobs put back in line.
   */
  async resume(): Promise<string[]> {
    const now = Date.now()
    this.store.prune(now - RETENTION_MS)
    const resumed: string[] = []
    for (const stored of this.store.load(now - RETENTION_MS)) {
      if (
        stored.status.state === 'JOB_STATE_COMPLETED' ||
        stored.status.state === 'JOB_STATE_FAILED'
      ) {
        this.statuses.set(stored.jobId, {
          status: stored.status,
          endedAt: stored.endedAt ?? now,
        })
        continue
      }
      this.statuses.set(stored.jobId, {
        status: {
          jobId: stored.jobId,
          did: stored.did as JobStatus['did'],
          state: 'JOB_STATE_CREATED',
        },
      })
      const job: VideoJob = {
        jobId: stored.jobId,
        did: stored.did,
        source: stored.source,
        workDir: stored.workDir,
        pdsUrl: stored.pdsUrl,
        token: stored.token,
      }
      if (stored.attempts >= MAX_JOB_ATTEMPTS) {
        await this.giveUp(
          job,
          `Processing was interrupted ${stored.attempts} times`,
        )
      } else if (!(await exists(stored.source))) {
        await this.giveUp(job, 'The uploaded video is gone')
      } else {
        // Allowances are counted in memory: count this one again for today,
        // and give it back if the job fails, as for a new upload
        const { size } = await stat(stored.source)
        this.quota?.charge(job.did, size)
        job.onFailed = () => this.quota?.release(job.did, size)
        this.update(job.jobId, { state: 'JOB_STATE_CREATED' })
        this.queue.push(job)
        resumed.push(job.jobId)
      }
    }
    this.next()
    return resumed
  }

  /** Folders of jobs that may still run, which startup cleanup must keep */
  openWorkDirs(): Set<string> {
    return new Set(
      this.store
        .load(Date.now())
        .filter((j) => j.endedAt === null)
        .map((j) => path.resolve(j.workDir)),
    )
  }

  private async giveUp(job: VideoJob, error: string) {
    this.update(job.jobId, {
      state: 'JOB_STATE_FAILED',
      failureCode: 'generic_failure',
      error,
    })
    await this.removeWorkDir(job.workDir)
  }

  /**
   * Removes a job's upload folder, which must be under `<dataDir>/uploads`:
   * the path comes from the job store, so it is checked before deleting.
   */
  private async removeWorkDir(workDir: string) {
    const uploads = path.join(path.resolve(this.dataDir), 'uploads') + path.sep
    const dir = path.resolve(workDir)
    if (!dir.startsWith(uploads) || dir.length <= uploads.length) {
      console.error(`krao-video: not removing ${workDir}, outside the uploads`)
      return
    }
    await rm(dir, { recursive: true, force: true })
  }

  /**
   * Stops starting jobs and saving progress. Jobs that were running stay
   * open in the store and are resumed on the next start.
   */
  close() {
    this.closed = true
    this.queue = []
  }

  protected update(jobId: string, patch: Partial<JobStatus>) {
    const entry = this.statuses.get(jobId)
    if (!entry) return
    entry.status = { ...entry.status, ...patch }
    if (
      entry.status.state === 'JOB_STATE_COMPLETED' ||
      entry.status.state === 'JOB_STATE_FAILED'
    ) {
      entry.endedAt = Date.now()
    }
    // Encoding progress only matters to this process: saved on state changes
    const stateChange = !(
      patch.state === 'JOB_STATE_ENCODING' && (patch.progress ?? 0) > 0
    )
    if (!this.closed && stateChange) {
      this.store.setStatus(jobId, entry.status, entry.endedAt)
    }
  }

  private next() {
    while (
      !this.closed &&
      this.running < this.concurrency &&
      this.queue.length
    ) {
      const job = this.queue.shift()!
      this.running++
      void this.process(job).finally(() => {
        this.running--
        this.next()
      })
    }
  }

  private async process(job: VideoJob) {
    try {
      this.store.startAttempt(job.jobId)
      this.update(job.jobId, { state: 'JOB_STATE_ENCODING', progress: 0 })
      const blob = await this.run(job)
      if (this.closed) return
      this.update(job.jobId, {
        state: 'JOB_STATE_COMPLETED',
        progress: 100,
        blob,
      })
    } catch (err) {
      // Shutting down: the job stays open and is resumed on the next start
      if (this.closed) return
      const failure =
        err instanceof JobFailure
          ? err
          : new JobFailure('generic_failure', (err as Error).message)
      console.error(`krao-video job ${job.jobId} failed`, failure.message)
      job.onFailed?.()
      this.update(job.jobId, {
        state: 'JOB_STATE_FAILED',
        failureCode: failure.code,
        error: failure.message,
      })
    }
    await this.removeWorkDir(job.workDir)
  }

  /** The processing itself: probe, mp4, HLS, PDS upload; returns the blob */
  protected async run(job: VideoJob): Promise<Blob> {
    let info: ProbeResult
    try {
      info = await probe(this.tools, job.source)
    } catch (err) {
      throw new JobFailure('validation_failure', (err as Error).message)
    }
    if (info.durationSec > this.limits.maxDurationSec) {
      throw new JobFailure(
        'validation_failure',
        `Videos can be at most ${Math.floor(this.limits.maxDurationSec / 60)} minutes long`,
      )
    }

    const mp4 = path.join(job.workDir, 'video.mp4')
    try {
      await toPlayableMp4(this.tools, job.source, mp4, info)
    } catch (err) {
      throw new JobFailure('encoding_failure', (err as Error).message)
    }
    const cid = cidForRawHash(await sha256File(mp4)).toString()

    await this.ensureHls(job.did, cid, mp4, info, (progress) =>
      this.update(job.jobId, {
        state: 'JOB_STATE_ENCODING',
        progress: Math.round(progress * 100),
      }),
    )

    this.update(job.jobId, { state: 'JOB_STATE_UPLOADING', progress: 0 })
    // The token was made when the upload finished; a long wait in line can
    // outlast it, and the PDS would only say "unauthorized"
    const exp = tokenExpiry(job.token)
    if (exp !== undefined && exp - Date.now() < 10_000) {
      throw new JobFailure(
        'pds_upload_failure',
        'The video waited too long to be processed. Please try posting it again.',
      )
    }
    const blob = await this.uploadToPds(job, mp4)
    if (getBlobCidString(blob) !== cid) {
      throw new JobFailure(
        'pds_upload_failure',
        'The PDS stored the video under an unexpected CID',
      )
    }
    return blob
  }

  /**
   * Encodes the HLS files for a video unless they already exist. Output goes
   * to a temporary folder that is renamed into place, so a half-written
   * encode is never served.
   */
  async ensureHls(
    did: string,
    cid: string,
    mp4: string,
    info: ProbeResult,
    onProgress?: (progress: number) => void,
  ) {
    const dir = hlsDir(this.dataDir, did, cid)
    if (await exists(path.join(dir, 'playlist.m3u8'))) return
    let encoding = this.encoding.get(dir)
    if (!encoding) {
      encoding = (async () => {
        const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
        try {
          await mkdir(tmp, { recursive: true })
          await encodeHls(this.tools, mp4, tmp, info, onProgress)
          await rm(dir, { recursive: true, force: true })
          await rename(tmp, dir)
        } catch (err) {
          await rm(tmp, { recursive: true, force: true })
          throw new JobFailure('encoding_failure', (err as Error).message)
        }
      })().finally(() => this.encoding.delete(dir))
      this.encoding.set(dir, encoding)
    }
    await encoding
  }

  private async uploadToPds(job: VideoJob, mp4: string) {
    const res = await xrpc(job.pdsUrl, com.atproto.repo.uploadBlob, {
      body: await openAsBlob(mp4, { type: 'video/mp4' }),
      encoding: 'video/mp4',
      headers: { authorization: `Bearer ${job.token}` },
    }).catch((err: unknown) => {
      const message = (err as Error).message ?? String(err)
      throw new JobFailure(
        /too large|PayloadTooLarge/i.test(message)
          ? 'pds_upload_unsupported_blob_size'
          : 'pds_upload_failure',
        `Could not store the video on the PDS: ${message}`,
      )
    })
    return res.body.blob
  }

  /** Forgets old finished jobs */
  sweep() {
    const now = Date.now()
    for (const [jobId, entry] of this.statuses) {
      if (entry.endedAt && now - entry.endedAt > RETENTION_MS) {
        this.statuses.delete(jobId)
      }
    }
    if (!this.closed) this.store.prune(now - RETENTION_MS)
  }
}
