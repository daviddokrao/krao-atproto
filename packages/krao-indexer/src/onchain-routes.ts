import type express from 'express'
import type { IdResolver } from '@atproto/identity'
import type { DatetimeString } from '@atproto/syntax'
import { InvalidRequestError, type Server } from '@atproto/xrpc-server'
import type { EvmRpc } from './chain.js'
import type { Database } from './db.js'
import { moderatorAuth } from './gate-moderation.js'
import { net } from './lexicons/index.js'
import type { ChainClock } from './membership.js'
import {
  type NftItem,
  OnchainError,
  getOnchainProfile,
  getSupportHistory,
  isHidden,
  listCollections,
  putCollection,
  removeCollection,
} from './onchain.js'

/*
 * The on-chain profile tab (net.krao.actor.getOnchainProfile and
 * getSupportHistory, public) and the approved NFT collections it shows
 * (net.krao.nft.*; changed by the safety admins, like the token catalog).
 */

type CollectionRow = Awaited<ReturnType<typeof listCollections>>[number]

export type OnchainRouteOptions = {
  rpcs: Map<string, EvmRpc>
  idResolver: IdResolver
  gateDid: string
  /** Who may change the approved collections (a live set) */
  admins: Set<string>
  /** The time memberships are judged by */
  clock: ChainClock
  /** A handle or DID as a DID; throws when it does not resolve */
  resolveDid: (actor: string) => Promise<string>
  /** This service's URL, for NFT images through /nft-image */
  baseUrl: (req: express.Request) => string
  /** How long NFT holdings are reused (default 10 minutes; 0: off) */
  cacheMs?: number
}

const collectionView = (row: CollectionRow) => ({
  chain: row.chain,
  contract: row.contract,
  ...(row.name ? { name: row.name } : {}),
  standard: row.standard,
  addedAt: row.addedAt as DatetimeString,
})

export function addOnchainRoutes(
  server: Server,
  db: Database,
  opts: OnchainRouteOptions,
) {
  const cache = new Map<string, { at: number; items: NftItem[] }>()
  const json = <T>(body: T) => ({
    encoding: 'application/json' as const,
    body,
  })
  const notFound = () =>
    new InvalidRequestError('Account not found', 'NotFound')
  const adminAuth = (lxm: string) =>
    moderatorAuth(
      {
        idResolver: opts.idResolver,
        gateDid: opts.gateDid,
        moderators: opts.admins,
      },
      lxm,
    )

  const actor = net.krao.actor
  server.add(actor.getOnchainProfile, async ({ params, req }) => {
    const did = await opts.resolveDid(params.actor)
    const profile = await getOnchainProfile(db, did, {
      rpcs: opts.rpcs,
      baseUrl: opts.baseUrl(req),
      cacheMs: opts.cacheMs,
      cache,
      now: await opts.clock.now(),
    })
    if (!profile) throw notFound()
    return json(profile as never)
  })

  server.add(actor.getSupportHistory, async ({ params }) => {
    const did = await opts.resolveDid(params.actor)
    const direction =
      params.direction === 'sent' || params.direction === 'received'
        ? (params.direction as 'sent' | 'received')
        : undefined
    if (!direction) {
      throw new InvalidRequestError('direction must be sent or received')
    }
    if (await isHidden(db, did)) throw notFound()
    const page = await getSupportHistory(db, did, {
      direction,
      limit: params.limit ?? 25,
      cursor: params.cursor,
    }).catch(() => {
      throw new InvalidRequestError('Malformed cursor')
    })
    return json({
      items: page.items,
      ...(page.cursor ? { cursor: page.cursor } : {}),
    } as never)
  })

  const nft = net.krao.nft
  server.add(nft.listCollections, async () =>
    json({ collections: (await listCollections(db)).map(collectionView) }),
  )

  server.add(nft.admin.putCollection, {
    auth: adminAuth(nft.admin.putCollection.$lxm),
    handler: async ({ auth, input }) => {
      const admin = (auth.credentials as { did: string }).did
      try {
        const row = await putCollection(db, opts.rpcs, admin, input.body)
        console.info(
          `Krao indexer: ${admin} put NFT collection ${row.chain}/${row.contract}`,
        )
        return json({ collection: collectionView(row) })
      } catch (err) {
        if (err instanceof OnchainError) {
          throw new InvalidRequestError(err.message, err.code)
        }
        throw err
      }
    },
  })

  server.add(nft.admin.removeCollection, {
    auth: adminAuth(nft.admin.removeCollection.$lxm),
    handler: async ({ auth, input }) => {
      const removed = await removeCollection(
        db,
        input.body.chain,
        input.body.contract,
      )
      if (removed) {
        console.info(
          `Krao indexer: ${(auth.credentials as { did: string }).did} removed NFT collection ${input.body.chain}/${input.body.contract}`,
        )
      }
      return json({ removed })
    },
  })
}
