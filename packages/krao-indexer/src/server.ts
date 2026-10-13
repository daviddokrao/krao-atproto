import cors from 'cors'
import express, { type Express } from 'express'
import type { IdResolver } from '@atproto/identity'
import { AtUri, type AtUriString } from '@atproto/syntax'
import {
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  createServer,
  verifyJwt,
} from '@atproto/xrpc-server'
import type { EvmRpc } from './chain.js'
import type { Database } from './db.js'
import { getLatestPosts, listFeedGenerators } from './feed.js'
import {
  getGatedContent,
  getRulesForSubjects,
  isEligible,
  putGatedContent,
  subjectsWithContent,
} from './gate.js'
import { addGifRoutes } from './gifs.js'
import { app as bskyApp, io } from './lexicons/index.js'
import { extractLinkMeta, fetchPreviewImage } from './link-meta.js'
import { fetchNftImageAsPng } from './nft-image.js'
import {
  erc1155BalanceOf,
  erc721OwnerOf,
  getNftAvatarsForDids,
  getNftMetadata,
  parseTokenId,
} from './nft.js'
import { addStarterPackRoutes } from './starter-packs.js'
import {
  listTips,
  tipTotals,
  tipTotalsForSubjects,
  verifiedTipCounts,
  verifiedTipsSentCounts,
} from './tips.js'
import { getWalletOwners, getWalletsForDids, uniqueWallets } from './wallets.js'

type ChainProfileView = io.krao.actor.defs.ChainProfileView
type WalletView = io.krao.actor.defs.WalletView
type NftAvatarView = io.krao.actor.defs.NftAvatarView
type Badge = io.krao.actor.defs.Badge
type TipView = io.krao.feed.defs.TipView
type RuleView = io.krao.gate.defs.RuleView

export function createApp(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  idResolver: IdResolver,
  opts: {
    handleResolverUrl?: string
    appviewUrl?: string
    /** Audience that service auth tokens for gate methods must name */
    gateDid: string
    /** Feed generator DID; the "latest" feed is served when set */
    feedGenDid?: string
    /** Krao's web app, where short links lead */
    webUrl?: string
    /** Klipy API key for GIF search; without it GIF search is unavailable */
    klipyApiKey?: string
    /** Public URL of this service, for links it hands out (default: from the request) */
    publicUrl?: string
  },
): Express {
  const {
    handleResolverUrl,
    appviewUrl,
    gateDid,
    feedGenDid,
    publicUrl,
    klipyApiKey,
    webUrl = 'https://krao.io',
  } = opts
  const server = createServer([], {})

  /*
   * Gate methods use atproto service auth: the client asks its PDS for a
   * short-lived JWT (com.atproto.server.getServiceAuth) signed with the
   * account's key, addressed to this service and method.
   */
  const serviceAuth =
    (lxm: string) =>
    async ({ req }: { req: express.Request }) => {
      const header = req.headers.authorization ?? ''
      if (!header.startsWith('Bearer ')) {
        throw new AuthRequiredError('Service auth token required')
      }
      const payload = await verifyJwt(
        header.slice('Bearer '.length),
        gateDid,
        lxm,
        (iss, forceRefresh) =>
          idResolver.did.resolveAtprotoKey(iss.split('#')[0], forceRefresh),
      )
      return { credentials: { did: payload.iss.split('#')[0] } }
    }

  server.add(io.krao.gate.getRules, async ({ params }) => {
    const rules = await getRulesForSubjects(db, params.uris)
    const withContent = await subjectsWithContent(
      db,
      rules.map((r) => r.subject),
    )
    return {
      encoding: 'application/json' as const,
      body: {
        rules: rules.map((rule): RuleView => ({
          uri: rule.uri as RuleView['uri'],
          subject: rule.subject as RuleView['subject'],
          conditions: JSON.parse(rule.conditions),
          match: rule.match,
          service: rule.service as RuleView['service'],
          hasContent: withContent.has(rule.subject),
        })),
      },
    }
  })

  server.add(io.krao.gate.getContent, {
    auth: serviceAuth(io.krao.gate.getContent.$lxm),
    handler: async ({ params, auth }) => {
      const viewer = (auth.credentials as { did: string }).did
      const [rule] = await getRulesForSubjects(db, [params.uri])
      const content = await getGatedContent(db, params.uri)
      if (!rule || !content) {
        throw new InvalidRequestError(
          'No gated content for this post',
          'NotFound',
        )
      }
      if (!(await isEligible(db, rpcs, rule, viewer))) {
        throw new ForbiddenError(
          'Your linked wallets do not meet the conditions of this post',
          'NotEligible',
        )
      }
      return {
        encoding: 'application/json' as const,
        body: {
          uri: params.uri,
          text: content.text,
          facets: content.facets ? JSON.parse(content.facets) : undefined,
        },
      }
    },
  })

  server.add(io.krao.gate.putContent, {
    auth: serviceAuth(io.krao.gate.putContent.$lxm),
    handler: async ({ input, auth }) => {
      const caller = (auth.credentials as { did: string }).did
      const body = input.body
      let author: string
      try {
        author = new AtUri(body.uri).host
      } catch {
        throw new InvalidRequestError('Invalid post uri')
      }
      if (author !== caller) {
        throw new ForbiddenError(
          'Only the author can set gated content',
          'NotAuthor',
        )
      }
      if (body.media?.length) {
        throw new InvalidRequestError('Gated media is not supported yet')
      }
      if (!body.text?.trim()) {
        throw new InvalidRequestError('Gated text is required')
      }
      await putGatedContent(db, {
        subject: body.uri,
        did: caller,
        text: body.text,
        facets: body.facets,
      })
    },
  })

  server.add(io.krao.actor.getChainProfiles, async ({ params }) => {
    const dids = await resolveActors(
      idResolver,
      params.actors,
      handleResolverUrl,
    )
    const [rows, tipCounts, sentCounts, nftAvatars] = await Promise.all([
      getWalletsForDids(db, dids).then(uniqueWallets),
      verifiedTipCounts(db, dids),
      verifiedTipsSentCounts(db, dids),
      getNftAvatarsForDids(db, dids),
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
        const nft = nftAvatars.find((n) => n.did === did)
        const nftAvatar: NftAvatarView | undefined = nft && {
          nft: {
            chain: nft.chain,
            contract: nft.contract,
            tokenId: nft.tokenId,
            standard: nft.standard ?? undefined,
          },
          wallet: nft.wallet,
          status: nft.status,
          collectionName: nft.collectionName ?? undefined,
          image: (nft.image ?? undefined) as NftAvatarView['image'],
          checkedAt: (nft.checkedAt ?? undefined) as NftAvatarView['checkedAt'],
        }
        const received = tipCounts.get(did) ?? 0
        const sent = sentCounts.get(did) ?? 0
        const badges: Badge[] = []
        if (wallets.some((w) => w.status === 'verified')) {
          badges.push({ id: 'wallet-verified' })
        }
        if (nft?.status === 'verified') badges.push({ id: 'nft-avatar' })
        if (sent > 0) badges.push({ id: 'tipper', count: sent })
        if (received > 0) badges.push({ id: 'supported', count: received })
        return {
          did: did as ChainProfileView['did'],
          wallets,
          nftAvatar,
          tipsReceivedCount: received,
          badges,
        }
      })
      .filter(
        (profile) =>
          profile.wallets.length > 0 ||
          profile.tipsReceivedCount > 0 ||
          !!profile.nftAvatar,
      )
    return {
      encoding: 'application/json' as const,
      body: { profiles },
    }
  })

  server.add(io.krao.actor.resolveNft, async ({ params }) => {
    const rpc = rpcs.get(params.chain)
    if (!rpc) {
      throw new InvalidRequestError(
        `Unsupported chain: ${params.chain}`,
        'UnsupportedChain',
      )
    }
    const tokenId = parseTokenId(params.tokenId)
    const contract = params.contract.toLowerCase()
    if (tokenId === null || !/^0x[0-9a-f]{40}$/.test(contract)) {
      throw new InvalidRequestError('Invalid contract or token id')
    }
    const owner = await erc721OwnerOf(rpc, contract, tokenId)
    let ownedByQueried: boolean | undefined
    if (!owner && params.owner) {
      ownedByQueried =
        (await erc1155BalanceOf(rpc, contract, params.owner, tokenId)) > 0n
    }
    if (!owner && !ownedByQueried) {
      throw new InvalidRequestError('NFT not found', 'NotFound')
    }
    const standard = owner ? 'erc721' : 'erc1155'
    const metadata = await getNftMetadata(rpc, contract, tokenId, standard)
    return {
      encoding: 'application/json' as const,
      body: {
        nft: {
          chain: params.chain,
          contract,
          tokenId: params.tokenId,
          standard,
        },
        owner: owner ?? undefined,
        ownedByQueried,
        collectionName: metadata.collectionName,
        name: metadata.name,
        image: metadata.image as `${string}:${string}` | undefined,
      },
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

  /*
   * Feed generator for Krao's "latest" feed. AppViews call it with service
   * auth, but the feed is the same for everyone so the token is not checked.
   */
  if (feedGenDid) {
    server.add(bskyApp.bsky.feed.describeFeedGenerator, async () => ({
      encoding: 'application/json' as const,
      body: {
        did: feedGenDid as `did:${string}:${string}`,
        feeds: (await listFeedGenerators(db)).map((uri) => ({
          uri: uri as AtUriString,
        })),
      },
    }))

    server.add(bskyApp.bsky.feed.getFeedSkeleton, async ({ params }) => {
      const feeds = await listFeedGenerators(db)
      if (!feeds.includes(params.feed)) {
        throw new InvalidRequestError('Unknown feed', 'UnknownFeed')
      }
      const { posts, cursor } = await getLatestPosts(
        db,
        params.limit ?? 50,
        params.cursor,
      ).catch(() => {
        throw new InvalidRequestError('Malformed cursor')
      })
      return {
        encoding: 'application/json' as const,
        body: {
          feed: posts.map((post) => ({ post: post as AtUriString })),
          cursor,
        },
      }
    })
  }

  server.add(io.krao.feed.getTipTotals, async ({ params }) => {
    const subjects = await tipTotalsForSubjects(db, params.subjects)
    return {
      encoding: 'application/json' as const,
      body: {
        subjects: subjects as io.krao.feed.getTipTotals.SubjectTotals[],
      },
    }
  })

  const app = express()
  // Behind a reverse proxy, req.protocol should follow X-Forwarded-Proto
  app.set('trust proxy', true)
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
  /*
   * The NFT's image as a 512px PNG, for use as a profile avatar. Only the
   * image named by the token's own on-chain metadata is fetched.
   */
  addGifRoutes(app, klipyApiKey)
  addStarterPackRoutes(app, db, { webUrl, publicUrl, appviewUrl })

  // Link previews, compatible with Bluesky's cardyb (see link-meta.ts)
  const imageProxyUrl = (req: express.Request) => (imageUrl: string) => {
    const base = publicUrl ?? `${req.protocol}://${req.get('host')}`
    return `${base}/v1/image?url=${encodeURIComponent(imageUrl)}`
  }
  app.get('/v1/extract', async (req, res) => {
    const { url } = req.query
    if (typeof url !== 'string' || !url) {
      res.status(400).json({ error: 'url is required' })
      return
    }
    res.setHeader('cache-control', 'public, max-age=600')
    res.json(await extractLinkMeta(url, imageProxyUrl(req)))
  })
  app.get('/v1/image', async (req, res) => {
    const { url } = req.query
    if (typeof url !== 'string' || !url) {
      res.status(400).json({ error: 'url is required' })
      return
    }
    try {
      const jpeg = await fetchPreviewImage(url)
      res.setHeader('content-type', 'image/jpeg')
      res.setHeader('cache-control', 'public, max-age=86400')
      res.send(jpeg)
    } catch (err) {
      res.status(502).json({ error: (err as Error).message })
    }
  })

  app.get('/nft-image', async (req, res) => {
    const { chain, contract, tokenId } = req.query
    const rpc = typeof chain === 'string' ? rpcs.get(chain) : undefined
    const id = typeof tokenId === 'string' ? parseTokenId(tokenId) : null
    if (
      !rpc ||
      id === null ||
      typeof contract !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(contract)
    ) {
      res.status(400).json({ error: 'InvalidRequest' })
      return
    }
    try {
      const addr = contract.toLowerCase()
      const standard = (await erc721OwnerOf(rpc, addr, id))
        ? 'erc721'
        : 'erc1155'
      const { image } = await getNftMetadata(rpc, addr, id, standard)
      if (!image) {
        res.status(404).json({ error: 'NotFound', message: 'NFT has no image' })
        return
      }
      const png = await fetchNftImageAsPng(image)
      res.setHeader('content-type', 'image/png')
      res.setHeader('cache-control', 'public, max-age=3600')
      res.send(png)
    } catch (err) {
      res
        .status(502)
        .json({ error: 'UpstreamFailure', message: (err as Error).message })
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
