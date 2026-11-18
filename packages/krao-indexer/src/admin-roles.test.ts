import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AdminAuditOutbox,
  type AuditOutboxEntry,
  type AuditSender,
  RewardsRoles,
  roleCheck,
} from './admin-roles.js'
import { type Database, createDb, migrateDb } from './db.js'

const ENV_ADMIN = 'did:plc:env'
const GRANTED = 'did:plc:granted'
const ADMIN = 'did:plc:admin'
const NOBODY = 'did:plc:nobody'

describe('admin roles from the rewards service', () => {
  let calls: string[]
  let down: boolean
  let now: number
  let roles: Record<string, string[]>
  const fakeFetch = (async (url: URL) => {
    const did = url.searchParams.get('did') ?? ''
    calls.push(did)
    if (down) throw new Error('connection refused')
    return new Response(JSON.stringify({ roles: roles[did] ?? [] }))
  }) as unknown as typeof fetch

  beforeEach(() => {
    calls = []
    down = false
    now = 1_000_000
    roles = { [GRANTED]: ['safety'], [ADMIN]: ['admin', 'safety', 'moderator'] }
  })

  it('adds granted roles to the configured accounts', async () => {
    const source = new RewardsRoles('http://rewards', 't', fakeFetch, () => now)
    const safety = roleCheck(new Set([ENV_ADMIN]), 'safety', source)
    const moderator = roleCheck(new Set(), 'moderator', source)
    expect(await safety.has(ENV_ADMIN)).toBe(true)
    expect(await safety.has(GRANTED)).toBe(true)
    expect(await safety.has(NOBODY)).toBe(false)
    expect(await moderator.has(GRANTED)).toBe(false)
    expect(await moderator.has(ADMIN)).toBe(true)
    // The configured account needs no call
    expect(calls).not.toContain(ENV_ADMIN)
  })

  it('reuses answers for a while, then sees changes', async () => {
    const source = new RewardsRoles('http://rewards', 't', fakeFetch, () => now)
    const safety = roleCheck(new Set(), 'safety', source)
    expect(await safety.has(GRANTED)).toBe(true)
    roles[GRANTED] = []
    expect(await safety.has(GRANTED)).toBe(true)
    expect(calls).toEqual([GRANTED])
    now += 31_000
    expect(await safety.has(GRANTED)).toBe(false)
  })

  it('fails closed but for the configured accounts', async () => {
    const source = new RewardsRoles('http://rewards', 't', fakeFetch, () => now)
    const safety = roleCheck(new Set([ENV_ADMIN]), 'safety', source)
    down = true
    expect(await safety.has(GRANTED)).toBe(false)
    expect(await safety.has(ENV_ADMIN)).toBe(true)
    // Retried soon
    down = false
    now += 6_000
    expect(await safety.has(GRANTED)).toBe(true)
  })

  it('takes only the configured accounts without a rewards service', async () => {
    const safety = roleCheck(new Set([ENV_ADMIN]), 'safety')
    expect(await safety.has(ENV_ADMIN)).toBe(true)
    expect(await safety.has(GRANTED)).toBe(false)
  })
})

describe('admin log outbox', () => {
  let db: Database
  let sent: AuditOutboxEntry[]
  let failing: boolean
  const sender: AuditSender = {
    send: async (entry) => {
      if (failing) throw new Error('rewards down')
      sent.push(entry)
    },
  }

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    sent = []
    failing = false
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('delivers entries with a stable key, retrying failures later', async () => {
    const outbox = new AdminAuditOutbox(db, sender)
    let queued = 0
    outbox.onQueued = () => queued++
    await outbox.record({
      actor: ADMIN,
      action: 'domain.add',
      subject: 'phish.test',
      details: { reason: 'drainer' },
    })
    expect(queued).toBe(1)
    failing = true
    const t0 = Date.now()
    await outbox.deliver(t0)
    expect(sent).toEqual([])
    failing = false
    // Not due yet
    await outbox.deliver(t0 + 1_000)
    expect(sent).toEqual([])
    await outbox.deliver(t0 + 6_000)
    expect(sent).toMatchObject([
      {
        service: 'indexer',
        actor: ADMIN,
        action: 'domain.add',
        subject: 'phish.test',
        details: { reason: 'drainer' },
      },
    ])
    expect(sent[0].key).toMatch(/^[0-9a-f-]{36}$/)
    // Sent once
    await outbox.deliver(t0 + 60_000)
    expect(sent).toHaveLength(1)
  })

  it('keeps automatic moderation apart', async () => {
    const outbox = new AdminAuditOutbox(db, sender)
    await outbox.record({
      service: 'moderation',
      actor: 'did:web:gate.test',
      action: 'impersonation.label',
      subject: NOBODY,
    })
    await outbox.deliver()
    expect(sent[0]).toMatchObject({
      service: 'moderation',
      action: 'impersonation.label',
    })
  })

  it('queues nothing without a rewards service', async () => {
    const outbox = new AdminAuditOutbox(db)
    await outbox.record({ actor: ADMIN, action: 'token.put' })
    const rows = await db.selectFrom('admin_audit_outbox').selectAll().execute()
    expect(rows).toEqual([])
  })
})
