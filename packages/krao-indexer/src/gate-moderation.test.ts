import { once } from 'node:events'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Secp256k1Keypair } from '@atproto/crypto'
import type { IdResolver } from '@atproto/identity'
import { createServer, createServiceJwt } from '@atproto/xrpc-server'
import { type Database, createDb, migrateDb } from './db.js'
import { addGateModerationRoutes } from './gate-moderation.js'
import { putGatedContent } from './gate.js'

const GATE_DID = 'did:web:gate.test'
const MOD = 'did:plc:moderator'
const USER = 'did:plc:user'
const POST = 'at://did:plc:author/app.bsky.feed.post/1'

describe('gate moderation', () => {
  let db: Database
  let server: http.Server
  let base: string
  let keys: Map<string, Secp256k1Keypair>
  let enabled: boolean

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    keys = new Map([
      [MOD, await Secp256k1Keypair.create()],
      [USER, await Secp256k1Keypair.create()],
    ])
    const idResolver = {
      did: {
        resolveAtprotoKey: async (did: string) => keys.get(did)!.did(),
      },
    } as unknown as IdResolver
    const xrpc = createServer([], {})
    enabled = true
    const opts = {
      idResolver,
      gateDid: GATE_DID,
      moderators: new Set([MOD]),
      get enabled() {
        return enabled
      },
      mediaUrl: (_req: unknown, id: string) => `https://gate.test/media/${id}`,
    }
    addGateModerationRoutes(xrpc, db, opts)
    const app = express()
    app.use(xrpc.router)
    server = app.listen(0)
    await once(server, 'listening')
    base = `http://localhost:${(server.address() as AddressInfo).port}`
    await putGatedContent(db, {
      subject: POST,
      did: 'did:plc:author',
      text: 'members only',
      facets: undefined,
      media: [],
    })
  })

  afterEach(async () => {
    server.close()
    await db.destroy()
  })

  const call = async (as: string, method: string, query: string) => {
    const token = await createServiceJwt({
      iss: as,
      aud: GATE_DID,
      lxm: method,
      keypair: keys.get(as)!,
    })
    const res = await fetch(`${base}/xrpc/${method}?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return { status: res.status, body: await res.json() }
  }

  const getContent = 'net.krao.gate.moderation.getContent'
  const listLog = 'net.krao.gate.moderation.listAccessLog'
  const uri = `uri=${encodeURIComponent(POST)}`

  it('lets moderators read gated content, and logs each read', async () => {
    const res = await call(MOD, getContent, `${uri}&reason=report-42`)
    expect(res.status).toBe(200)
    expect(res.body.text).toBe('members only')
    const log = await call(MOD, listLog, uri)
    expect(log.body.entries).toMatchObject([
      { moderator: MOD, uri: POST, reason: 'report-42' },
    ])
  })

  it('refuses everyone else, and logs nothing for them', async () => {
    expect((await call(USER, getContent, uri)).status).toBe(403)
    expect((await call(USER, listLog, uri)).status).toBe(403)
    const rows = await db.selectFrom('gate_access_log').selectAll().execute()
    expect(rows).toHaveLength(0)
  })

  it('refuses a token made for another method', async () => {
    const token = await createServiceJwt({
      iss: MOD,
      aud: GATE_DID,
      lxm: 'net.krao.gate.getContent',
      keypair: keys.get(MOD)!,
    })
    const res = await fetch(`${base}/xrpc/${getContent}?${uri}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('can be turned off', async () => {
    enabled = false
    expect((await call(MOD, getContent, uri)).status).toBe(403)
  })
})
