import cors from 'cors'
import express, { type Express } from 'express'
import type { IdResolver } from '@atproto/identity'
import { InvalidRequestError, createServer } from '@atproto/xrpc-server'
import type { Database } from './db.js'
import { io } from './lexicons/index.js'
import { getWalletOwners, getWalletsForDids } from './wallets.js'

type ChainProfileView = io.krao.actor.defs.ChainProfileView
type WalletView = io.krao.actor.defs.WalletView

export function createApp(
  db: Database,
  idResolver: IdResolver,
  handleResolverUrl?: string,
): Express {
  const server = createServer([], {})

  server.add(io.krao.actor.getChainProfiles, async ({ params }) => {
    const dids = await resolveActors(
      idResolver,
      params.actors,
      handleResolverUrl,
    )
    const rows = await getWalletsForDids(db, dids)
    const profiles = dids
      .map((did) => {
        const wallets = rows
          .filter((row) => row.did === did)
          .map((row): WalletView => ({
            uri: row.uri as WalletView['uri'],
            account: row.accountRaw,
            label: row.label ?? undefined,
            status: row.status,
            createdAt: row.createdAt as WalletView['createdAt'],
          }))
        return { did: did as ChainProfileView['did'], wallets }
      })
      .filter((profile) => profile.wallets.length > 0)
    return {
      encoding: 'application/json' as const,
      body: { profiles },
    }
  })

  const app = express()
  app.use(cors())
  app.get('/_health', (_req, res) => {
    res.json({ ok: true })
  })
  /*
   * Internal lookup used by Krao PDSes to sign users in with a wallet. The
   * data is public (wallet records live in public repos), and the PDS checks
   * the record in its own repo before trusting the answer.
   */
  app.get('/internal/wallet-owners', async (req, res) => {
    const account = req.query.account
    if (typeof account !== 'string') {
      res
        .status(400)
        .json({ error: 'InvalidRequest', message: 'account is required' })
      return
    }
    try {
      res.json({ dids: await getWalletOwners(db, account) })
    } catch {
      res
        .status(400)
        .json({ error: 'InvalidRequest', message: 'Invalid account' })
    }
  })
  app.use(server.router)
  return app
}

async function resolveActors(
  idResolver: IdResolver,
  actors: string[],
  handleResolverUrl?: string,
): Promise<string[]> {
  const dids = await Promise.all(
    actors.map(async (actor) => {
      if (actor.startsWith('did:')) return actor
      try {
        const did = await idResolver.handle.resolve(actor)
        if (did) return did
      } catch {
        // fall through to the resolver service
      }
      return handleResolverUrl
        ? resolveHandleViaService(handleResolverUrl, actor)
        : null
    }),
  )
  const unique: string[] = [...new Set(dids.filter((d): d is string => !!d))]
  if (!unique.length && actors.length) {
    throw new InvalidRequestError('Could not resolve any of the given actors')
  }
  return unique
}

async function resolveHandleViaService(
  serviceUrl: string,
  handle: string,
): Promise<string | null> {
  try {
    const url = new URL('/xrpc/com.atproto.identity.resolveHandle', serviceUrl)
    url.searchParams.set('handle', handle)
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const { did } = (await res.json()) as { did?: string }
    return did ?? null
  } catch {
    return null
  }
}
