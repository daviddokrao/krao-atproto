import { once } from 'node:events'
import type http from 'node:http'
import { type Database, createDb, migrateDb } from './db.js'
import { PlcMirror } from './mirror.js'
import { createApp } from './server.js'

export { PlcMirror, type ExportEntry, type IngestResult } from './mirror.js'
export { opCid, validateNextOp } from './validate.js'
export { createDb, migrateDb } from './db.js'
export { enableMockExport } from './dev.js'

export type KraoPlcMirrorConfig = {
  port: number
  /** SQLite file, or ':memory:' */
  dbLocation: string
  /** The PLC directory to copy (default https://plc.directory) */
  source?: string
  /** Wait between polls once caught up (default 5 s) */
  pollMs?: number
  /** Longest wait between retries when the source fails (default 60 s) */
  maxBackoffMs?: number
  /** Ask the source for a DID the mirror lacks (default true) */
  fallback?: boolean
  /** Where the first sync starts (ISO time or `seq:<n>`); unset: everything */
  startAfter?: string
}

export class KraoPlcMirror {
  private server?: http.Server

  private constructor(
    public cfg: KraoPlcMirrorConfig,
    public db: Database,
    public mirror: PlcMirror,
    private app: ReturnType<typeof createApp>,
  ) {}

  static async create(cfg: KraoPlcMirrorConfig): Promise<KraoPlcMirror> {
    const db = createDb(cfg.dbLocation)
    await migrateDb(db)
    const mirror = new PlcMirror(db, {
      source: cfg.source ?? 'https://plc.directory',
      pollMs: cfg.pollMs,
      maxBackoffMs: cfg.maxBackoffMs,
      fallback: cfg.fallback,
      startAfter: cfg.startAfter,
    })
    return new KraoPlcMirror(cfg, db, mirror, createApp(mirror))
  }

  get url() {
    return `http://localhost:${this.cfg.port}`
  }

  async start(): Promise<http.Server> {
    this.server = this.app.listen(this.cfg.port)
    await once(this.server, 'listening')
    this.mirror.start()
    return this.server
  }

  async destroy(): Promise<void> {
    await this.mirror.stop()
    if (this.server) {
      this.server.close()
      await once(this.server, 'close')
    }
    await this.db.destroy()
  }
}
