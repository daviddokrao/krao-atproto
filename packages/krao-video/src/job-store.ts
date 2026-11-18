import SqliteDB from 'better-sqlite3'
import { type LexValue, lexParse, lexStringify } from '@atproto/lex'
import type { JobStatus } from './jobs.js'

/** A job as kept on disk, enough to run it again after a restart */
export type StoredJob = {
  jobId: string
  did: string
  status: JobStatus
  source: string
  workDir: string
  pdsUrl: string
  /** Cleared once the job ends: it is only needed to store the video */
  token: string
  /** Times processing started */
  attempts: number
  createdAt: number
  endedAt: number | null
}

type Row = Omit<StoredJob, 'status'> & { state: string; status: string }

/**
 * The video job queue in SQLite (`<dataDir>/jobs.sqlite`): jobs waiting or
 * running survive a restart, and finished ones keep answering getJobStatus.
 */
export class JobStore {
  private db: SqliteDB.Database

  constructor(location: string) {
    this.db = new SqliteDB(location)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      create table if not exists job (
        jobId text primary key,
        did text not null,
        state text not null,
        status text not null,
        source text not null,
        workDir text not null,
        pdsUrl text not null,
        token text not null,
        attempts integer not null default 0,
        createdAt integer not null,
        endedAt integer
      );
      create index if not exists job_open_idx on job (endedAt);
    `)
  }

  insert(job: Omit<StoredJob, 'attempts' | 'endedAt'>) {
    this.db
      .prepare(
        `insert into job (jobId, did, state, status, source, workDir, pdsUrl,
           token, attempts, createdAt, endedAt)
         values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, null)`,
      )
      .run(
        job.jobId,
        job.did,
        job.status.state,
        lexStringify(job.status as LexValue),
        job.source,
        job.workDir,
        job.pdsUrl,
        job.token,
        job.createdAt,
      )
  }

  /** Saves a status; a finished job forgets its token */
  setStatus(jobId: string, status: JobStatus, endedAt?: number) {
    this.db
      .prepare(
        `update job set state = ?, status = ?, endedAt = ?,
           token = case when ? is null then token else '' end
         where jobId = ?`,
      )
      .run(
        status.state,
        lexStringify(status as LexValue),
        endedAt ?? null,
        endedAt ?? null,
        jobId,
      )
  }

  /** Counts a processing attempt; returns the new count */
  startAttempt(jobId: string): number {
    const row = this.db
      .prepare(
        'update job set attempts = attempts + 1 where jobId = ? returning attempts',
      )
      .get(jobId) as { attempts: number } | undefined
    return row?.attempts ?? 0
  }

  /** Jobs not finished, and jobs finished after `since` (ms), oldest first */
  load(since: number): StoredJob[] {
    const rows = this.db
      .prepare(
        `select * from job where endedAt is null or endedAt > ?
         order by createdAt, jobId`,
      )
      .all(since) as Row[]
    return rows.map(({ state: _state, status, ...row }) => ({
      ...row,
      status: lexParse(status) as unknown as JobStatus,
    }))
  }

  /** Forgets jobs that ended before `before` (ms) */
  prune(before: number) {
    this.db.prepare('delete from job where endedAt < ?').run(before)
  }

  close() {
    this.db.close()
  }
}
