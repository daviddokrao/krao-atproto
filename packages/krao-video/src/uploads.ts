import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { InvalidRequestError } from '@atproto/xrpc-server'

export type UploadLimits = {
  /** Largest video accepted, in bytes */
  maxBytes: number
  /** Videos one account may upload per UTC day */
  dailyVideos: number
  /** Bytes one account may upload per UTC day */
  dailyBytes: number
  /** Multipart uploads one account may have open at once */
  maxOpenUploads: number
}

export const DEFAULT_LIMITS: UploadLimits = {
  maxBytes: 100 * 1024 * 1024,
  dailyVideos: 25,
  dailyBytes: 10 * 1024 * 1024 * 1024,
  maxOpenUploads: 3,
}

export const SUPPORTED_MIME_TYPES = [
  'video/mp4',
  'video/mpeg',
  'video/webm',
  'video/quicktime',
  'image/gif',
]

/** Parts are 8 MiB, above the 5 MiB minimum clients plan for */
export const PART_SIZE_BYTES = 8 * 1024 * 1024
const UPLOAD_TTL_MS = 60 * 60 * 1000
/** How long finished uploads stay readable through getUploadStatus */
const RETENTION_MS = 24 * 60 * 60 * 1000

export type UploadState =
  'created' | 'finishing' | 'completed' | 'failed' | 'aborted' | 'expired'

export type UploadSession = {
  jobId: string
  did: string
  sizeBytes: number
  mimeType: string
  partSizeBytes: number
  partCount: number
  received: Set<number>
  state: UploadState
  expiresAt: Date
  /** When the session reached a terminal state */
  endedAt?: number
  failureReason?: string
  dir: string
}

/**
 * Per-account daily allowance, counted when an upload starts (a reservation)
 * and given back when it is aborted, expires or fails to process. Kept in
 * memory: a restart resets the day's counts.
 */
export class Quotas {
  private day = ''
  private used = new Map<string, { videos: number; bytes: number }>()

  constructor(private limits: UploadLimits) {}

  private usage(did: string) {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== this.day) {
      this.day = today
      this.used.clear()
    }
    let usage = this.used.get(did)
    if (!usage) {
      usage = { videos: 0, bytes: 0 }
      this.used.set(did, usage)
    }
    return usage
  }

  remaining(did: string) {
    const usage = this.usage(did)
    return {
      videos: Math.max(0, this.limits.dailyVideos - usage.videos),
      bytes: Math.max(0, this.limits.dailyBytes - usage.bytes),
    }
  }

  reserve(did: string, bytes: number) {
    const left = this.remaining(did)
    if (left.videos < 1) {
      throw new InvalidRequestError(
        'You have reached the daily video upload limit',
        'DailyLimitExceeded',
      )
    }
    if (left.bytes < bytes) {
      throw new InvalidRequestError(
        'This video is larger than your remaining daily upload allowance',
        'VideoTooLarge',
      )
    }
    const usage = this.usage(did)
    usage.videos += 1
    usage.bytes += bytes
  }

  /** Counts a video already accepted (a job resumed after a restart) */
  charge(did: string, bytes: number) {
    const usage = this.usage(did)
    usage.videos += 1
    usage.bytes += bytes
  }

  release(did: string, bytes: number) {
    const usage = this.usage(did)
    usage.videos = Math.max(0, usage.videos - 1)
    usage.bytes = Math.max(0, usage.bytes - bytes)
  }
}

function expectedPartSize(session: UploadSession, partNumber: number) {
  return partNumber < session.partCount
    ? session.partSizeBytes
    : session.sizeBytes - session.partSizeBytes * (session.partCount - 1)
}

function terminalError(session: UploadSession) {
  switch (session.state) {
    case 'finishing':
      return new InvalidRequestError(
        'The upload is being finished',
        'UploadNotReady',
      )
    case 'completed':
      return new InvalidRequestError(
        'The upload is already complete',
        'UploadAlreadyCompleted',
      )
    case 'failed':
      return new InvalidRequestError(
        session.failureReason ?? 'The upload failed',
        'UploadFailed',
      )
    case 'aborted':
      return new InvalidRequestError('The upload was aborted', 'UploadAborted')
    case 'expired':
      return new InvalidRequestError('The upload expired', 'UploadExpired')
    default:
      return null
  }
}

/** Counts the bytes going through and stops once there are more than `max` */
function byteCounter(max: number) {
  let count = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      count += chunk.length
      if (count > max) cb(new Error('too many bytes'))
      else cb(null, chunk)
    },
  })
  return { counter, count: () => count }
}

/**
 * Multipart upload sessions. Parts are written to `<dataDir>/uploads/<jobId>`
 * and joined into one `source` file on finish. Sessions live in memory: a
 * restart drops the ones in flight, and clients start over.
 */
export class UploadStore {
  private sessions = new Map<string, UploadSession>()

  constructor(
    private dataDir: string,
    private limits: UploadLimits,
    private quotas: Quotas,
  ) {}

  openUploads(did: string) {
    let count = 0
    for (const s of this.sessions.values()) {
      if (s.did === did && (s.state === 'created' || s.state === 'finishing')) {
        count++
      }
    }
    return count
  }

  async start(
    did: string,
    input: { sizeBytes: number; mimeType: string },
  ): Promise<UploadSession> {
    if (!SUPPORTED_MIME_TYPES.includes(input.mimeType)) {
      throw new InvalidRequestError(
        `Unsupported video type: ${input.mimeType}`,
        'UnsupportedContentType',
      )
    }
    if (input.sizeBytes > this.limits.maxBytes) {
      throw new InvalidRequestError(
        `Videos can be at most ${Math.floor(this.limits.maxBytes / 1024 / 1024)} MB`,
        'VideoTooLarge',
      )
    }
    if (this.openUploads(did) >= this.limits.maxOpenUploads) {
      throw new InvalidRequestError(
        'Too many video uploads in progress',
        'TooManyOpenUploads',
      )
    }
    this.quotas.reserve(did, input.sizeBytes)
    const jobId = randomUUID()
    const dir = path.join(this.dataDir, 'uploads', jobId)
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      this.quotas.release(did, input.sizeBytes)
      throw err
    }
    const session: UploadSession = {
      jobId,
      did,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      partSizeBytes: PART_SIZE_BYTES,
      partCount: Math.ceil(input.sizeBytes / PART_SIZE_BYTES),
      received: new Set(),
      state: 'created',
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
      dir,
    }
    this.sessions.set(jobId, session)
    return session
  }

  /** The caller's session; other accounts' uploads are reported as not found */
  get(did: string, jobId: string): UploadSession {
    const session = this.sessions.get(jobId)
    if (!session || session.did !== did) {
      throw new InvalidRequestError('Unknown upload', 'UploadNotFound')
    }
    this.expireIfDue(session)
    return session
  }

  async writePart(
    session: UploadSession,
    partNumber: number,
    contentLength: number,
    body: NodeJS.ReadableStream,
  ) {
    const error = terminalError(session)
    if (error) throw error
    if (partNumber < 1 || partNumber > session.partCount) {
      throw new InvalidRequestError(
        `Part number must be between 1 and ${session.partCount}`,
        'InvalidPartNumber',
      )
    }
    const expected = expectedPartSize(session, partNumber)
    if (contentLength !== expected) {
      throw new InvalidRequestError(
        `Part ${partNumber} must be ${expected} bytes`,
        'PartSizeMismatch',
      )
    }
    const file = path.join(session.dir, `part-${partNumber}`)
    const tmp = `${file}.${randomUUID()}.tmp`
    const { counter, count } = byteCounter(expected)
    try {
      await pipeline(body, counter, createWriteStream(tmp))
      if (count() !== expected) throw new Error('short part')
    } catch {
      await rm(tmp, { force: true })
      throw new InvalidRequestError(
        `Part ${partNumber} must be ${expected} bytes`,
        'PartSizeMismatch',
      )
    }
    // The session may have been aborted while the part was in flight
    if (session.state !== 'created') {
      await rm(tmp, { force: true })
      throw terminalError(session) ?? new Error('Upload is not open')
    }
    await rename(tmp, file)
    session.received.add(partNumber)
    return { partNumber, sizeBytes: expected }
  }

  /** Joins the parts into `<dir>/source`; the session moves on to processing */
  async assemble(session: UploadSession): Promise<string> {
    if (session.state !== 'created') {
      throw terminalError(session) ?? new Error('Upload is not open')
    }
    const missing: number[] = []
    for (let n = 1; n <= session.partCount; n++) {
      if (!session.received.has(n)) missing.push(n)
    }
    if (missing.length) {
      throw new InvalidRequestError(
        `Missing parts: ${missing.join(', ')}`,
        'MissingParts',
      )
    }
    session.state = 'finishing'
    const source = path.join(session.dir, 'source')
    try {
      const out = createWriteStream(source)
      for (let n = 1; n <= session.partCount; n++) {
        await pipeline(
          createReadStream(path.join(session.dir, `part-${n}`)),
          out,
          {
            end: false,
          },
        )
      }
      out.end()
      await new Promise<void>((resolve, reject) => {
        out.on('finish', resolve)
        out.on('error', reject)
      })
      const { size } = await stat(source)
      if (size !== session.sizeBytes) {
        throw new Error(
          `assembled ${size} bytes, expected ${session.sizeBytes}`,
        )
      }
      for (let n = 1; n <= session.partCount; n++) {
        await rm(path.join(session.dir, `part-${n}`), { force: true })
      }
    } catch (err) {
      this.fail(
        session,
        `Could not assemble the upload: ${(err as Error).message}`,
      )
      throw new InvalidRequestError(session.failureReason, 'UploadFailed')
    }
    return source
  }

  complete(session: UploadSession) {
    session.state = 'completed'
    session.endedAt = Date.now()
  }

  /** Marks the upload failed and gives the reservation back */
  fail(session: UploadSession, reason: string) {
    session.state = 'failed'
    session.failureReason = reason
    session.endedAt = Date.now()
    this.quotas.release(session.did, session.sizeBytes)
    void rm(session.dir, { recursive: true, force: true })
  }

  async abort(session: UploadSession) {
    this.expireIfDue(session)
    if (session.state === 'finishing') {
      throw new InvalidRequestError(
        'The upload is being finished',
        'UploadNotReady',
      )
    }
    if (session.state === 'created') {
      session.state = 'aborted'
      session.endedAt = Date.now()
      this.quotas.release(session.did, session.sizeBytes)
      await rm(session.dir, { recursive: true, force: true })
    }
  }

  private expireIfDue(session: UploadSession) {
    if (
      session.state === 'created' &&
      session.expiresAt.getTime() < Date.now()
    ) {
      session.state = 'expired'
      session.endedAt = Date.now()
      this.quotas.release(session.did, session.sizeBytes)
      void rm(session.dir, { recursive: true, force: true })
    }
  }

  /** Expires stale uploads and forgets old finished ones */
  sweep() {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      this.expireIfDue(session)
      if (session.endedAt && now - session.endedAt > RETENTION_MS) {
        this.sessions.delete(session.jobId)
      }
    }
  }
}
