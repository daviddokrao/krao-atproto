import type { Database } from './db.js'

/*
 * Krao admin roles (M35), kept here for every Krao service. `admin` manages
 * roles and implies the others. Roles come from the services' configuration
 * (`env`: always there, not removable through the API) and from admins
 * (`db`, the admin_role table). The indexer and chat ask /internal/roles.
 */

export const ROLES = [
  'admin',
  'rewards',
  'kyc',
  'safety',
  'moderator',
  'analytics',
] as const
export type Role = (typeof ROLES)[number]

export const isRole = (value: unknown): value is Role =>
  ROLES.includes(value as Role)

/** Services that write to the shared admin log */
export const AUDIT_SERVICES = [
  'rewards',
  'indexer',
  'chat',
  'moderation',
] as const
export type AuditService = (typeof AUDIT_SERVICES)[number]

/**
 * Accounts named in the configuration, as live sets (accounts made at
 * startup can be added):
 * - rewards admins (KRAO_REWARDS_ADMIN_DIDS): admin, rewards and analytics
 * - KYC reviewers (KRAO_KYC_REVIEWER_DIDS): kyc
 * - KRAO_SAFETY_ADMIN_DIDS: safety
 * - KRAO_GATE_MODERATOR_DIDS: moderator
 */
export type EnvRoleSets = {
  adminDids: Set<string>
  kycReviewerDids: Set<string>
  safetyAdminDids?: Set<string>
  gateModeratorDids?: Set<string>
}

export function envRolesOf(env: EnvRoleSets, did: string): Role[] {
  const roles: Role[] = []
  if (env.adminDids.has(did)) roles.push('admin', 'rewards', 'analytics')
  if (env.kycReviewerDids.has(did)) roles.push('kyc')
  if (env.safetyAdminDids?.has(did)) roles.push('safety')
  if (env.gateModeratorDids?.has(did)) roles.push('moderator')
  return roles
}

/** Every role, when `admin` is among them; otherwise as given */
export function expandRoles(roles: Iterable<Role>): Role[] {
  const set = new Set(roles)
  if (set.has('admin')) return [...ROLES]
  return ROLES.filter((r) => set.has(r))
}

export type RoleGrant = {
  role: Role
  source: 'env' | 'db'
  grantedBy?: string
  grantedAt?: string
}

export class RoleError extends Error {
  constructor(
    message: string,
    public error: 'UnknownRole' | 'EnvRole' | 'OwnAdminRole',
  ) {
    super(message)
  }
}

export class RoleStore {
  constructor(
    private db: Database,
    private env: EnvRoleSets,
  ) {}

  /** The roles `did` holds (env and granted), `admin` expanded to all */
  async rolesOf(did: string): Promise<Role[]> {
    const rows = await this.db
      .selectFrom('admin_role')
      .select('role')
      .where('did', '=', did)
      .execute()
    return expandRoles([
      ...envRolesOf(this.env, did),
      ...rows.map((r) => r.role).filter(isRole),
    ])
  }

  async has(did: string, role: Role): Promise<boolean> {
    return (await this.rolesOf(did)).includes(role)
  }

  /** Grants of `did`, env ones first; a role in both shows as env */
  async grantsOf(did: string): Promise<RoleGrant[]> {
    return (await this.members()).get(did) ?? []
  }

  /** Every account with a role, and its grants (not expanded) */
  async members(): Promise<Map<string, RoleGrant[]>> {
    const members = new Map<string, RoleGrant[]>()
    const envDids = new Set([
      ...this.env.adminDids,
      ...this.env.kycReviewerDids,
      ...(this.env.safetyAdminDids ?? []),
      ...(this.env.gateModeratorDids ?? []),
    ])
    for (const did of envDids) {
      members.set(
        did,
        [...new Set(envRolesOf(this.env, did))].map((role) => ({
          role,
          source: 'env' as const,
        })),
      )
    }
    const rows = await this.db
      .selectFrom('admin_role')
      .selectAll()
      .orderBy('grantedAt', 'asc')
      .execute()
    for (const row of rows) {
      if (!isRole(row.role)) continue
      const grants = members.get(row.did) ?? []
      if (grants.some((g) => g.role === row.role)) continue
      grants.push({
        role: row.role,
        source: 'db',
        grantedBy: row.grantedBy,
        grantedAt: row.grantedAt,
      })
      members.set(row.did, grants)
    }
    for (const grants of members.values()) {
      grants.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
    }
    return members
  }

  /**
   * Grants or removes a role, logged. Env roles cannot be removed, and an
   * admin cannot remove their own admin role (someone must be left).
   * Returns whether anything changed.
   */
  async set(
    actor: string,
    did: string,
    role: string,
    enabled: boolean,
  ): Promise<boolean> {
    if (!isRole(role)) {
      throw new RoleError(`Unknown role: ${role}`, 'UnknownRole')
    }
    if (!enabled && envRolesOf(this.env, did).includes(role)) {
      throw new RoleError(
        'This role comes from the configuration and cannot be removed here',
        'EnvRole',
      )
    }
    if (!enabled && role === 'admin' && did === actor) {
      throw new RoleError(
        'You cannot remove your own admin role',
        'OwnAdminRole',
      )
    }
    return this.db.transaction().execute(async (tx) => {
      const at = new Date().toISOString()
      const changed = enabled
        ? Number(
            (
              await tx
                .insertInto('admin_role')
                .values({ did, role, grantedBy: actor, grantedAt: at })
                .onConflict((oc) => oc.columns(['did', 'role']).doNothing())
                .executeTakeFirst()
            ).numInsertedOrUpdatedRows ?? 0,
          ) > 0
        : Number(
            (
              await tx
                .deleteFrom('admin_role')
                .where('did', '=', did)
                .where('role', '=', role)
                .executeTakeFirst()
            ).numDeletedRows,
          ) > 0
      if (changed) {
        await recordAudit(tx, {
          service: 'rewards',
          actor,
          action: enabled ? 'role.grant' : 'role.revoke',
          subject: did,
          details: { role },
          createdAt: at,
        })
      }
      return changed
    })
  }
}

export type AuditEntryInput = {
  service: AuditService
  actor: string
  action: string
  subject?: string | null
  details?: unknown
  createdAt?: string
  /** Set by other services: the same key twice is kept once (retries) */
  sourceKey?: string
}

/** Adds an entry to the shared admin log; false when the key was seen */
export async function recordAudit(
  db: Database,
  entry: AuditEntryInput,
): Promise<boolean> {
  const result = await db
    .insertInto('admin_audit_log')
    .values({
      service: entry.service,
      actor: entry.actor,
      action: entry.action.slice(0, 128),
      subject: entry.subject ? entry.subject.slice(0, 2048) : null,
      details:
        entry.details === undefined ? null : JSON.stringify(entry.details),
      createdAt: entry.createdAt ?? new Date().toISOString(),
      sourceKey: entry.sourceKey ?? null,
    })
    .onConflict((oc) => oc.column('sourceKey').doNothing())
    .executeTakeFirst()
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0
}

export type AuditEntryView = {
  id: number
  service: string
  actor: string
  action: string
  subject?: string
  details?: unknown
  createdAt: string
}

/** The shared admin log, newest first */
export async function listAudit(
  db: Database,
  opts: {
    service?: string
    actor?: string
    limit: number
    cursor?: string
  },
): Promise<{ entries: AuditEntryView[]; cursor?: string }> {
  let query = db
    .selectFrom('admin_audit_log')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(opts.limit)
  if (opts.service) query = query.where('service', '=', opts.service)
  if (opts.actor) query = query.where('actor', '=', opts.actor)
  if (opts.cursor) {
    const id = Number(opts.cursor)
    if (Number.isInteger(id)) query = query.where('id', '<', id)
  }
  const rows = await query.execute()
  const last = rows[rows.length - 1]
  return {
    entries: rows.map((r) => {
      let details: unknown
      try {
        details = r.details === null ? undefined : JSON.parse(r.details)
      } catch {
        details = undefined
      }
      return {
        id: r.id,
        service: r.service,
        actor: r.actor,
        action: r.action,
        ...(r.subject ? { subject: r.subject } : {}),
        // Lexicon data: objects and arrays only (no bare numbers or null)
        ...(details !== null && typeof details === 'object'
          ? { details }
          : details !== undefined
            ? { details: { value: details } }
            : {}),
        createdAt: r.createdAt,
      }
    }),
    cursor: rows.length === opts.limit && last ? String(last.id) : undefined,
  }
}
