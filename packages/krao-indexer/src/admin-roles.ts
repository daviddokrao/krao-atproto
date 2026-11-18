import { randomUUID } from 'node:crypto'
import type { Database } from './db.js'

/*
 * Krao admin roles and the shared admin log (M35). The rewards service
 * keeps both: roles granted in the app are read from its /internal/roles
 * (cached briefly) and added to the accounts in this service's own config;
 * admin actions here are queued in `admin_audit_outbox` and delivered to its
 * /internal/audit with retries (like rewards_outbox).
 */

/** Who may call a group of admin methods: a Set fits too */
export interface RoleCheck {
  has(did: string): boolean | Promise<boolean>
}

export interface RoleSource {
  /** The account's roles (`admin` expanded to all); [] when unknown */
  roles(did: string): Promise<string[]>
}

/** Answers are reused this long, so a new role works within a minute */
const ROLES_TTL_MS = 30_000
/** Failures are retried this soon (only the config's accounts pass meanwhile) */
const ROLES_FAILURE_TTL_MS = 5_000
const ROLES_CACHE_MAX = 10_000

export class RewardsRoles implements RoleSource {
  private cache = new Map<string, { roles: string[]; until: number }>()

  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async roles(did: string): Promise<string[]> {
    const at = this.now()
    const cached = this.cache.get(did)
    if (cached && cached.until > at) return cached.roles
    let roles: string[] = []
    let ttl = ROLES_TTL_MS
    try {
      const url = new URL('/internal/roles', this.url)
      url.searchParams.set('did', did)
      const res = await this.fetchFn(url, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) throw new Error(`roles: HTTP ${res.status}`)
      const body = (await res.json()) as { roles?: unknown }
      roles = Array.isArray(body.roles)
        ? body.roles.filter((r): r is string => typeof r === 'string')
        : []
    } catch (err) {
      // Fail closed: only the accounts in this service's config pass
      console.error('Krao indexer: could not read admin roles', err)
      ttl = ROLES_FAILURE_TTL_MS
    }
    if (this.cache.size > ROLES_CACHE_MAX) this.cache.clear()
    this.cache.set(did, { roles, until: at + ttl })
    return roles
  }
}

/**
 * The accounts in `env` (this service's config, a live set), and those
 * holding `role` (or admin) at the rewards service
 */
export function roleCheck(
  env: Set<string>,
  role: string,
  source?: RoleSource,
): RoleCheck {
  return {
    has: async (did: string) => {
      if (env.has(did)) return true
      if (!source) return false
      const roles = await source.roles(did)
      return roles.includes(role) || roles.includes('admin')
    },
  }
}

export type AdminAuditEntry = {
  actor: string
  action: string
  subject?: string
  details?: Record<string, unknown>
  /** `indexer` (default) or `moderation` (automatic moderation) */
  service?: 'indexer' | 'moderation'
}

export interface AdminAuditLog {
  record(entry: AdminAuditEntry): Promise<void>
}

export interface AuditSender {
  /** Throws when the entry was not taken */
  send(entry: AuditOutboxEntry): Promise<void>
}

export type AuditOutboxEntry = AdminAuditEntry & {
  service: 'indexer' | 'moderation'
  createdAt: string
  /** Kept once at the rewards service, however often it is sent */
  key: string
}

export class RewardsAuditSender implements AuditSender {
  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(entry: AuditOutboxEntry) {
    const res = await this.fetchFn(new URL('/internal/audit', this.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`admin audit: HTTP ${res.status}`)
  }
}

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60 * 60 * 1000
/** Sent entries are dropped after this long (the rewards service keeps them) */
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Queues admin actions for the rewards service; a no-op without one */
export class AdminAuditOutbox implements AdminAuditLog {
  /** Called after an entry is queued (eg to deliver it right away) */
  onQueued?: () => void

  constructor(
    private db: Database,
    private sender?: AuditSender,
  ) {}

  async record(entry: AdminAuditEntry) {
    if (!this.sender) return
    const createdAt = new Date().toISOString()
    await this.db
      .insertInto('admin_audit_outbox')
      .values({
        key: randomUUID(),
        service: entry.service ?? 'indexer',
        actor: entry.actor,
        action: entry.action,
        subject: entry.subject ?? null,
        details:
          entry.details === undefined ? null : JSON.stringify(entry.details),
        createdAt,
        sentAt: null,
        attempts: 0,
        nextAttemptAt: createdAt,
        error: null,
      })
      .execute()
    this.onQueued?.()
  }

  /** Sends the entries that are due, oldest first; failures wait longer */
  async deliver(now = Date.now(), limit = 100) {
    if (!this.sender) return
    const rows = await this.db
      .selectFrom('admin_audit_outbox')
      .selectAll()
      .where('sentAt', 'is', null)
      .where('nextAttemptAt', '<=', new Date(now).toISOString())
      .orderBy('id', 'asc')
      .limit(limit)
      .execute()
    for (const row of rows) {
      try {
        let details: Record<string, unknown> | undefined
        try {
          details = row.details ? JSON.parse(row.details) : undefined
        } catch {
          details = undefined
        }
        await this.sender.send({
          service: row.service === 'moderation' ? 'moderation' : 'indexer',
          actor: row.actor,
          action: row.action,
          ...(row.subject ? { subject: row.subject } : {}),
          ...(details ? { details } : {}),
          createdAt: row.createdAt,
          key: row.key,
        })
        await this.db
          .updateTable('admin_audit_outbox')
          .set({ sentAt: new Date().toISOString(), error: null })
          .where('id', '=', row.id)
          .execute()
      } catch (err) {
        const delay = Math.min(RETRY_BASE_MS * 2 ** row.attempts, RETRY_MAX_MS)
        await this.db
          .updateTable('admin_audit_outbox')
          .set({
            attempts: row.attempts + 1,
            nextAttemptAt: new Date(now + delay).toISOString(),
            error: String((err as Error)?.message ?? err).slice(0, 500),
          })
          .where('id', '=', row.id)
          .execute()
      }
    }
    await this.db
      .deleteFrom('admin_audit_outbox')
      .where('sentAt', 'is not', null)
      .where('sentAt', '<', new Date(now - SENT_RETENTION_MS).toISOString())
      .execute()
  }
}
