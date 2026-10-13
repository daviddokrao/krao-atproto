import cors from 'cors'
import express, { type Express } from 'express'
import type { IdResolver } from '@atproto/identity'
import { InvalidRequestError, createServer } from '@atproto/xrpc-server'
import type { Database } from './db.js'
import { io } from './lexicons/index.js'
import { listTips, tipTotals, verifiedTipCounts } from './tips.js'
import { getWalletOwners, getWalletsForDids } from './wallets.js'

type ChainProfileView = io.krao.actor.defs.ChainProfileView
type WalletView = io.krao.actor.defs.WalletView
type TipView = io.krao.feed.defs.TipView

export function createApp(
  db: Database,
  idResolver: IdResolver,
  handleResolverUrl?: string,
  appviewUrl?: string,
): Express {
  const server = createServer([], {})

  server.add(io.krao.actor.getChainProfiles, async ({ params }) => {
    const dids = await resolveActors(
      idResolver,
      params.actors,
      handleResolverUrl,
    )
    const [rows, tipCounts] = await Promise.all([
      getWalletsForDids(db, dids),
      verifiedTipCounts(db, dids),
    ])
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
        return {
          did: did as ChainProfileView['did'],
          wallets,
          tipsReceivedCount: tipCounts.get(did) ?? 0,
        }
      })
      .filter(
        (profile) =>
          profile.wallets.length > 0 || profile.tipsReceivedCount > 0,
      )
    return {
      encoding: 'application/json' as const,
      body: { profiles },
    }
  })

  server.add(io.krao.feed.getTips, async ({ params }) => {
    let where: { subject: string } | { recipient: string }
    if (params.subject) {
      where = { subject: params.subject }
    } else if (params.recipient) {
      const [did] = await resolveActors(
        idResolver,
        [params.recipient],
        handleResolverUrl,
      )
      where = { recipient: did }
    } else {
      throw new InvalidRequestError('Either subject or recipient is required')
    }
    const limit = params.limit ?? 50
    const [rows, totals] = await Promise.all([
      listTips(db, where, limit, params.cursor),
      tipTotals(db, where),
    ])
    const senders = await getProfilesBasic(appviewUrl, [
      ...new Set(rows.map((r) => r.did)),
    ])
    const tips = rows.map((row): TipView => ({
      uri: row.uri as TipView['uri'],
      sender: (senders.get(row.did) ?? {
        did: row.did,
        handle: 'handle.invalid',
      }) as TipView['sender'],
      recipient: row.recipient as TipView['recipient'],
      subject: (row.subject ?? undefined) as TipView['subject'],
      asset: row.asset,
      amount: row.amount,
      txHash: row.txHash,
      message: row.message ?? undefined,
      status: row.status,
      createdAt: row.createdAt as TipView['createdAt'],
    }))
    return {
      encoding: 'application/json' as const,
      body: {
        tips,
        totals,
        cursor: rows.length === limit ? rows.at(-1)?.createdAt : undefined,
      },
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

type ProfileBasic = {
  did: string
  handle: string
  displayName?: string
  avatar?: string
}

/** Basic profiles from the AppView, for showing who sent a tip */
async function getProfilesBasic(
  appviewUrl: string | undefined,
  dids: string[],
): Promise<Map<string, ProfileBasic>> {
  const profiles = new Map<string, ProfileBasic>()
  if (!appviewUrl || !dids.length) return profiles
  for (let i = 0; i < dids.length; i += 25) {
    const url = new URL('/xrpc/app.bsky.actor.getProfiles', appviewUrl)
    for (const did of dids.slice(i, i + 25))
      url.searchParams.append('actors', did)
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const body = (await res.json()) as { profiles?: ProfileBasic[] }
      for (const p of body.profiles ?? []) {
        profiles.set(p.did, {
          did: p.did,
          handle: p.handle,
          displayName: p.displayName,
          avatar: p.avatar,
        })
      }
    } catch {
      // Tips still render with a bare DID if the AppView is unreachable
    }
  }
  return profiles
}
