import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getBlobCidString, lexParse } from '@atproto/lex'
import { JobStore } from './job-store.js'
import {
  JobQueue,
  type JobStatus,
  MAX_JOB_ATTEMPTS,
  type VideoJob,
} from './jobs.js'
import { DEFAULT_LIMITS, Quotas } from './uploads.js'

const BLOB = lexParse(
  JSON.stringify({
    $type: 'blob',
    ref: {
      $link: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    },
    mimeType: 'video/mp4',
    size: 1234,
  }),
) as unknown as NonNullable<JobStatus['blob']>

/** A queue whose processing waits for the test to finish it */
class TestQueue extends JobQueue {
  started: string[] = []
  private finishers = new Map<string, (ok: boolean) => void>()

  protected override run(job: VideoJob) {
    this.started.push(job.jobId)
    return new Promise<NonNullable<JobStatus['blob']>>((resolve, reject) => {
      this.finishers.set(job.jobId, (ok) =>
        ok ? resolve(BLOB) : reject(new Error('ffmpeg exploded')),
      )
    })
  }

  finish(jobId: string, ok = true) {
    this.finishers.get(jobId)?.(ok)
  }
}

let dir: string
let dbFile: string
const stores: JobStore[] = []

function queue(quotas?: Quotas) {
  const store = new JobStore(dbFile)
  stores.push(store)
  return new TestQueue(
    dir,
    { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    { maxDurationSec: 180 },
    1,
    store,
    quotas,
  )
}

async function job(jobId: string): Promise<VideoJob> {
  const workDir = path.join(dir, 'uploads', jobId)
  await mkdir(workDir, { recursive: true })
  const source = path.join(workDir, 'source')
  await writeFile(source, 'video bytes')
  return {
    jobId,
    did: 'did:plc:alice',
    source,
    workDir,
    pdsUrl: 'http://localhost:2583',
    token: 'token',
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20))

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'krao-video-test-'))
  dbFile = path.join(dir, 'jobs.sqlite')
})

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('persistent job queue', () => {
  it('resumes queued and interrupted jobs after a restart', async () => {
    const before = queue()
    before.add(await job('a'))
    before.add(await job('b'))
    await tick()
    // a is processing, b waits in line (concurrency 1)
    expect(before.get('a')?.state).toBe('JOB_STATE_ENCODING')
    expect(before.get('b')?.state).toBe('JOB_STATE_CREATED')
    before.close() // the process stops

    const after = queue()
    expect(await after.resume()).toEqual(['a', 'b'])
    await tick()
    expect(after.started).toEqual(['a'])
    after.finish('a')
    await tick()
    expect(after.get('a')).toMatchObject({
      state: 'JOB_STATE_COMPLETED',
      progress: 100,
    })
    expect(after.started).toEqual(['a', 'b'])
    after.finish('b', false)
    await tick()
    expect(after.get('b')).toMatchObject({
      state: 'JOB_STATE_FAILED',
      failureCode: 'generic_failure',
      error: 'ffmpeg exploded',
    })
  })

  it('keeps finished statuses (with the blob) across restarts', async () => {
    const first = queue()
    first.add(await job('a'))
    await tick()
    first.finish('a')
    await tick()
    first.close()

    const second = queue()
    expect(await second.resume()).toEqual([])
    const status = second.get('a')
    expect(status?.state).toBe('JOB_STATE_COMPLETED')
    expect(status?.blob).toMatchObject({ size: 1234 })
    expect(getBlobCidString(status!.blob!)).toBe(getBlobCidString(BLOB))
    expect(second.started).toEqual([])
  })

  it('gives up a job interrupted too many times', async () => {
    let q = queue()
    q.add(await job('a'))
    for (let i = 1; i < MAX_JOB_ATTEMPTS; i++) {
      await tick()
      q.close()
      q = queue()
      expect(await q.resume()).toEqual(['a'])
    }
    await tick()
    q.close()
    q = queue()
    expect(await q.resume()).toEqual([])
    expect(q.get('a')).toMatchObject({
      state: 'JOB_STATE_FAILED',
      error: `Processing was interrupted ${MAX_JOB_ATTEMPTS} times`,
    })
  })

  it('fails a job whose upload is gone', async () => {
    const first = queue()
    const j = await job('a')
    first.add(j)
    first.close()
    await rm(j.workDir, { recursive: true, force: true })
    const second = queue()
    expect(await second.resume()).toEqual([])
    expect(second.get('a')).toMatchObject({
      state: 'JOB_STATE_FAILED',
      error: 'The uploaded video is gone',
    })
  })

  it('counts a resumed job against the allowance, refunded if it fails', async () => {
    const first = queue()
    first.add(await job('a'))
    await tick()
    first.close()

    // A restart starts the day's counts over
    const quotas = new Quotas({
      ...DEFAULT_LIMITS,
      dailyVideos: 5,
      dailyBytes: 1000,
    })
    const second = queue(quotas)
    expect(await second.resume()).toEqual(['a'])
    // 'video bytes' is 11 bytes
    expect(quotas.remaining('did:plc:alice')).toEqual({ videos: 4, bytes: 989 })
    await tick()
    second.finish('a', false)
    await tick()
    expect(second.get('a')?.state).toBe('JOB_STATE_FAILED')
    expect(quotas.remaining('did:plc:alice')).toEqual({
      videos: 5,
      bytes: 1000,
    })
  })

  it('only removes job folders under <dataDir>/uploads', async () => {
    const outside = path.join(dir, 'precious')
    await mkdir(outside, { recursive: true })
    const source = path.join(outside, 'source')
    await writeFile(source, 'video bytes')
    const q = queue()
    q.add({
      jobId: 'x',
      did: 'did:plc:alice',
      source,
      workDir: outside,
      pdsUrl: 'http://localhost:2583',
      token: 'token',
    })
    await tick()
    q.finish('x', false)
    await tick()
    expect(q.get('x')?.state).toBe('JOB_STATE_FAILED')
    await expect(access(source)).resolves.toBeUndefined()
  })
})
