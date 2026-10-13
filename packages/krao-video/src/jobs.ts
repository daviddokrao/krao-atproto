import { createHash } from 'node:crypto'
import { createReadStream, openAsBlob } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { cidForRawHash, getBlobCidString, xrpc } from '@atproto/lex'
import {
  type FfmpegTools,
  type ProbeResult,
  encodeHls,
  probe,
  toPlayableMp4,
} from './ffmpeg.js'
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
  onFailed: () => void
}

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

async function sha256File(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return new Uint8Array(hash.digest())
}

/**
 * Runs uploaded videos through probe -> mp4 -> HLS -> PDS upload, a few at a
 * time. Job statuses are kept in memory for {@link RETENTION_MS}.
 */
export class JobQueue {
  private statuses = new Map<string, { status: JobStatus; endedAt?: number }>()
  private queue: VideoJob[] = []
  private running = 0
  /** Encodes in progress by HLS folder, so a video is only encoded once */
  private encoding = new Map<string, Promise<void>>()

  constructor(
    private dataDir: string,
    private tools: FfmpegTools,
    private limits: ProcessingLimits,
    private concurrency: number,
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
    this.statuses.set(job.jobId, { status })
    this.queue.push(job)
    this.next()
    return status
  }

  private update(jobId: string, patch: Partial<JobStatus>) {
    const entry = this.statuses.get(jobId)
    if (!entry) return
    entry.status = { ...entry.status, ...patch }
    if (
      entry.status.state === 'JOB_STATE_COMPLETED' ||
      entry.status.state === 'JOB_STATE_FAILED'
    ) {
      entry.endedAt = Date.now()
    }
  }

  private next() {
    while (this.running < this.concurrency && this.queue.length) {
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
      this.update(job.jobId, { state: 'JOB_STATE_ENCODING', progress: 0 })
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
      const blob = await this.uploadToPds(job, mp4)
      if (getBlobCidString(blob) !== cid) {
        throw new JobFailure(
          'pds_upload_failure',
          'The PDS stored the video under an unexpected CID',
        )
      }
      this.update(job.jobId, {
        state: 'JOB_STATE_COMPLETED',
        progress: 100,
        blob,
      })
    } catch (err) {
      const failure =
        err instanceof JobFailure
          ? err
          : new JobFailure('generic_failure', (err as Error).message)
      console.error(`krao-video job ${job.jobId} failed`, failure.message)
      job.onFailed()
      this.update(job.jobId, {
        state: 'JOB_STATE_FAILED',
        failureCode: failure.code,
        error: failure.message,
      })
    } finally {
      await rm(job.workDir, { recursive: true, force: true })
    }
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
  }
}
