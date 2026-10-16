import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServiceJwt } from '@atproto/xrpc-server'
import { type Database, createDb, migrateDb } from './db.js'
import { RoleStore, expandRoles } from './roles.js'
import { createApp } from './server.js'
import { RewardsService } from './service.js'

const TOKEN = 'internal-token-for-tests-0123456789'
const SERVICE_DID = 'did:web:rewards.test'
const ADMIN = 'did:plc:admin'
const REVIEWER = 'did:plc:reviewer'
const SAFETY = 'did:plc:safety'
const USER = 'did:plc:user'
const OTHER = 'did:plc:other'

describe('Krao admin roles', () => {
  let db: Database
  let service: RewardsService
  let server: http.Server
  let base: string
  let keys: Map<string, Secp256k1Keypair>
  let roles: RoleStore

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    service = new RewardsService(db)
    await service.seedRules()
    keys = new Map()
    for (const did of [ADMIN, REVIEWER, SAFETY, USER, OTHER]) {
      keys.set(did, await Secp256k1Keypair.create())
    }
    const idResolver = {
      did: {
        resolveAtprotoKey: async (did: string) => keys.get(did)!.did(),
      },
    } as unknown as IdResolver
    const adminDids = new Set([ADMIN])
    const kycReviewerDids = new Set([REVIEWER])
    roles = new RoleStore(db, {
      adminDids,
      kycReviewerDids,
      safetyAdminDids: new Set([SAFETY]),
      gateModeratorDids: new Set(),
    })
    const app = createApp({
      service,
      idResolver,
      serviceDid: SERVICE_DID,
      internalToken: TOKEN,
      adminDids,
      kycReviewerDids,
      roles,
      handleOf: async (did) => `${did.split(':')[2]}.test`,
      kycProvider: null,
      manualReview: { dailyLimit: 10, requireSecondApprover: false },
      phone: null,
    })
    server = app.listen(0)
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    await db.destroy()
  })

  const call = async (
    as: string,
    method: string,
    { body, query = '' }: { body?: unknown; query?: string } = {},
  ) => {
    const token = await createServiceJwt({
      iss: as,
      aud: SERVICE_DID,
      lxm: method,
      keypair: keys.get(as)!,
    })
    const res = await fetch(`${base}/xrpc/${method}${query}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as any,
    }
  }

  const internal = (path: string, init: RequestInit = {}, token = TOKEN) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    })

  const setRole = (as: string, did: string, role: string, enabled: boolean) =>
    call(as, 'net.krao.admin.setRole', { body: { did, role, enabled } })

  it('expands admin to every role', () => {
    expect(expandRoles(['admin'])).toEqual([
      'admin',
      'rewards',
      'kyc',
      'safety',
      'moderator',
      'analytics',
    ])
    expect(expandRoles(['kyc', 'safety'])).toEqual(['kyc', 'safety'])
  })

  it('gives every account its roles, none for most', async () => {
    const mine = await call(USER, 'net.krao.admin.getMyRoles')
    expect(mine).toEqual({ status: 200, body: { roles: [] } })
    const admin = await call(ADMIN, 'net.krao.admin.getMyRoles')
    expect(admin.body.roles).toHaveLength(6)
    const reviewer = await call(REVIEWER, 'net.krao.admin.getMyRoles')
    expect(reviewer.body.roles).toEqual(['kyc'])
  })

  it('keeps the role list, the log and role changes for admins', async () => {
    for (const as of [USER, REVIEWER, SAFETY]) {
      expect((await call(as, 'net.krao.admin.listRoles')).status).toBe(403)
      expect((await call(as, 'net.krao.admin.getAuditLog')).status).toBe(403)
      expect((await setRole(as, USER, 'safety', true)).status).toBe(403)
    }
  })

  it('lists env roles as locked and granted ones with who granted them', async () => {
    const granted = await setRole(ADMIN, USER, 'safety', true)
    expect(granted.status).toBe(200)
    expect(granted.body).toMatchObject({
      did: USER,
      handle: 'user.test',
      roles: [{ role: 'safety', source: 'db', grantedBy: ADMIN }],
    })
    const list = await call(ADMIN, 'net.krao.admin.listRoles')
    const byDid = Object.fromEntries(
      list.body.members.map((m: any) => [m.did, m.roles]),
    )
    expect(byDid[ADMIN]).toEqual([
      { role: 'admin', source: 'env' },
      { role: 'rewards', source: 'env' },
      { role: 'analytics', source: 'env' },
    ])
    expect(byDid[REVIEWER]).toEqual([{ role: 'kyc', source: 'env' }])
    expect(byDid[SAFETY]).toEqual([{ role: 'safety', source: 'env' }])
    expect(byDid[USER]).toMatchObject([{ role: 'safety', source: 'db' }])
  })

  it('grants and removes roles, logged, but not env roles or your own admin', async () => {
    expect((await setRole(ADMIN, USER, 'kyc', true)).status).toBe(200)
    expect(await roles.rolesOf(USER)).toEqual(['kyc'])
    expect((await setRole(ADMIN, USER, 'kyc', false)).status).toBe(200)
    expect(await roles.rolesOf(USER)).toEqual([])

    const envRole = await setRole(ADMIN, SAFETY, 'safety', false)
    expect(envRole.status).toBe(400)
    expect(envRole.body.error).toBe('EnvRole')
    const unknown = await setRole(ADMIN, USER, 'superuser', true)
    expect(unknown.body.error).toBe('UnknownRole')
    // A granted admin cannot remove its own admin role either
    await setRole(ADMIN, OTHER, 'admin', true)
    const own = await setRole(OTHER, OTHER, 'admin', false)
    expect(own.body.error).toBe('OwnAdminRole')
    // ...but may remove an env admin's granted roles, not its env ones
    expect((await setRole(OTHER, ADMIN, 'admin', false)).body.error).toBe(
      'EnvRole',
    )

    const log = await call(ADMIN, 'net.krao.admin.getAuditLog', {
      query: '?service=rewards',
    })
    expect(log.body.entries.map((e: any) => [e.action, e.subject])).toEqual([
      ['role.grant', OTHER],
      ['role.revoke', USER],
      ['role.grant', USER],
    ])
    expect(log.body.entries[0]).toMatchObject({
      service: 'rewards',
      actor: ADMIN,
      details: { role: 'admin' },
    })
  })

  it('opens the old rewards screens to the new roles', async () => {
    const getRoles = 'net.krao.rewards.getRoles'
    const listRules = 'net.krao.rewards.admin.listRules'
    const listKyc = 'net.krao.rewards.admin.listKyc'
    const summary = 'net.krao.analytics.getSummary'
    expect((await call(USER, getRoles)).body).toEqual({ roles: [] })
    expect((await call(USER, listRules)).status).toBe(403)
    expect((await call(USER, listKyc)).status).toBe(403)
    expect((await call(USER, summary)).status).toBe(403)

    await setRole(ADMIN, USER, 'kyc', true)
    expect((await call(USER, getRoles)).body).toEqual({
      roles: ['kyc_reviewer'],
    })
    expect((await call(USER, listKyc)).status).toBe(200)
    expect((await call(USER, listRules)).status).toBe(403)

    await setRole(ADMIN, USER, 'rewards', true)
    expect((await call(USER, getRoles)).body).toEqual({
      roles: ['admin', 'kyc_reviewer'],
    })
    expect((await call(USER, listRules)).status).toBe(200)
    expect((await call(USER, summary)).status).toBe(403)
    await setRole(ADMIN, USER, 'analytics', true)
    expect((await call(USER, summary)).status).toBe(200)

    // A granted admin has every screen
    await setRole(ADMIN, OTHER, 'admin', true)
    expect((await call(OTHER, getRoles)).body).toEqual({
      roles: ['admin', 'kyc_reviewer'],
    })
    // Env admins as before
    expect((await call(ADMIN, getRoles)).body).toEqual({
      roles: ['admin', 'kyc_reviewer'],
    })
    expect((await call(REVIEWER, getRoles)).body).toEqual({
      roles: ['kyc_reviewer'],
    })
  })

  it('logs admin actions of the rewards service, not system ones', async () => {
    await call(ADMIN, 'net.krao.rewards.admin.adjustPoints', {
      body: { did: USER, amount: 5, note: 'manual bonus' },
    })
    await service.takeDown(USER)
    await service.liftTakedown(USER)
    const log = await call(ADMIN, 'net.krao.admin.getAuditLog')
    expect(log.body.entries.map((e: any) => e.action)).toEqual([
      'points.adjust',
    ])
  })

  it('answers roles to the indexer and takes its log entries once', async () => {
    await setRole(ADMIN, USER, 'moderator', true)
    const res = await internal(`/internal/roles?did=${USER}`)
    expect(await res.json()).toEqual({ roles: ['moderator'] })
    const admin = await internal(`/internal/roles?did=${ADMIN}`)
    expect(((await admin.json()) as any).roles).toContain('safety')
    expect((await internal('/internal/roles?did=x')).status).toBe(400)
    expect(
      (await internal(`/internal/roles?did=${USER}`, {}, 'no')).status,
    ).toBe(401)

    const entry = {
      service: 'indexer',
      actor: SAFETY,
      action: 'domain.add',
      subject: 'phish.test',
      details: { reason: 'drainer' },
      createdAt: new Date().toISOString(),
      key: '7',
    }
    const post = (body: unknown) =>
      internal('/internal/audit', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    expect(await (await post(entry)).json()).toEqual({ ok: true })
    expect(await (await post(entry)).json()).toEqual({
      ok: true,
      duplicate: true,
    })
    expect((await post({ ...entry, service: 'rewards' })).status).toBe(400)
    expect((await post({ ...entry, actor: 'nobody' })).status).toBe(400)
    const log = await call(ADMIN, 'net.krao.admin.getAuditLog', {
      query: `?service=indexer&actor=${SAFETY}`,
    })
    expect(log.body.entries).toMatchObject([
      {
        service: 'indexer',
        actor: SAFETY,
        action: 'domain.add',
        subject: 'phish.test',
        details: { reason: 'drainer' },
      },
    ])
  })

  it('pages the log', async () => {
    for (let i = 0; i < 5; i++) {
      await setRole(ADMIN, USER, 'kyc', i % 2 === 0)
    }
    const first = await call(ADMIN, 'net.krao.admin.getAuditLog', {
      query: '?limit=2',
    })
    expect(first.body.entries).toHaveLength(2)
    const next = await call(ADMIN, 'net.krao.admin.getAuditLog', {
      query: `?limit=2&cursor=${first.body.cursor}`,
    })
    expect(next.body.entries[0].id).toBeLessThan(first.body.entries[1].id)
  })
})
