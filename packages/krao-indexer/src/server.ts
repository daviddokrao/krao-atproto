import cors from 'cors'
import express, { type Express } from 'express'
import type { IdResolver } from '@atproto/identity'
import {
  AtUri,
  type AtUriString,
  type DatetimeString,
  type UriString,
} from '@atproto/syntax'
import {
  AuthRequiredError,
  ForbiddenError,
  InvalidRequestError,
  createServer,
  verifyJwt,
} from '@atproto/xrpc-server'
import { catchAsyncErrors, errorHandler } from './async-routes.js'
import type { EvmRpc } from './chain.js'
import type { Database } from './db.js'
import {
  POPULAR_FEED_RKEY,
  getLatestPosts,
  getPopularPosts,
  rankPopularPosts,
  listFeedGenerators,
} from './feed.js'
import {
  type StoredGatedMedia,
  getGatedContent,
  getRulesForSubjects,
  isEligible,
  putGatedContent,
  subjectsWithContent,
} from './gate.js'
import {
  accountScores,
  suggestedAccounts,
  suggestedStarterPacks,
  trendingTags,
} from './discovery.js'
import {
  GATED_MEDIA_MAX_BYTES,
  MediaSigner,
  maxBytesFor,
  addGatedMediaRoute,
  insertGatedMedia,
  mediaIdFromUrl,
  withUploadLock,
  withinUploadQuota,
  ownedGatedMedia,
  readBounded,
  sniffMediaType,
} from './gate-media.js'
import { addGifRoutes } from './gifs.js'
import { app as bskyApp, net } from './lexicons/index.js'
import { extractLinkMeta, fetchPreviewImage } from './link-meta.js'
import { fetchNftImageAsPng } from './nft-image.js'
import {
  erc1155BalanceOf,
  erc721OwnerOf,
  getNftAvatarsForDids,
  getNftMetadata,
  parseTokenId,
} from './nft.js'
import { cachedValue } from './cache.js'
import { keyedLimit, rateLimit } from './rate-limit.js'
import { SafeFetchError } from './safe-fetch.js'
import { addStarterPackRoutes } from './starter-packs.js'
import {
  listTips,
  tipTotals,
  tipTotalsForSubjects,
  verifiedTipCounts,
  verifiedTipsSentCounts,
} from './tips.js'
import { getWalletOwners, getWalletsForDids, uniqueWallets } from './wallets.js'

type ChainProfileView = net.krao.actor.defs.ChainProfileView
type WalletView = net.krao.actor.defs.WalletView
type NftAvatarView = net.krao.actor.defs.NftAvatarView
type Badge = net.krao.actor.defs.Badge
type TipView = net.krao.feed.defs.TipView
type RuleView = net.krao.gate.defs.RuleView

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
    /** Secret for signed gated media URLs (default: random per process) */
    gateMediaSecret?: string
    /** How long feed rankings and suggestions are reused (default 30s, 0: off) */
    discoveryCacheMs?: number
  },
): Express {
  const {
    handleResolverUrl,
    appviewUrl,
    gateDid,
    feedGenDid,
    publicUrl,
    klipyApiKey,
    webUrl = 'https://krao.net',
  } = opts
  const server = createServer([], {})
  const mediaSigner = new MediaSigner(opts.gateMediaSecret)
  const cacheMs = opts.discoveryCacheMs ?? 30_000
  const popularRanking = cachedValue(cacheMs, () => rankPopularPosts(db))
  const globalAccountScores = cachedValue(cacheMs, () => accountScores(db))
  const baseUrl = (req: {
    protocol: string
    get(name: string): string | undefined
  }) => publicUrl ?? `${req.protocol}://${req.get('host')}`

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

  server.add(net.krao.gate.getRules, async ({ params }) => {
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

  // Each check that fails costs on-chain calls and is never cached
  const gateContentLimit = keyedLimit(60, 60_000)
  server.add(net.krao.gate.getContent, {
    auth: serviceAuth(net.krao.gate.getContent.$lxm),
    handler: async ({ params, auth, req }) => {
      const viewer = (auth.credentials as { did: string }).did
      gateContentLimit(viewer)
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
          media: content.media
            ? (JSON.parse(content.media) as StoredGatedMedia[]).map((m) => ({
                url: mediaSigner.url(baseUrl(req), m.id) as UriString,
                mimeType: m.mimeType,
                alt: m.alt,
                aspectRatio: m.aspectRatio,
              }))
            : undefined,
        },
      }
    },
  })

  server.add(net.krao.gate.putContent, {
    auth: serviceAuth(net.krao.gate.putContent.$lxm),
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
      // Media must have been uploaded by the author to this service
      const ids = (body.media ?? []).map((m) => mediaIdFromUrl(m.url))
      if (ids.some((id) => !id)) {
        throw new InvalidRequestError('Gated media must come from uploadMedia')
      }
      const owned = await ownedGatedMedia(db, caller, ids as string[])
      if (owned.size !== new Set(ids).size) {
        throw new InvalidRequestError('Unknown gated media')
      }
      const media: StoredGatedMedia[] = (body.media ?? []).map((m, i) => ({
        id: ids[i] as string,
        mimeType: owned.get(ids[i] as string) as string,
        ...(m.alt ? { alt: m.alt } : {}),
        ...(m.aspectRatio
          ? {
              aspectRatio: {
                width: m.aspectRatio.width,
                height: m.aspectRatio.height,
              },
            }
          : {}),
      }))
      if (!body.text?.trim() && !media.length) {
        throw new InvalidRequestError('Gated text or media is required')
      }
      await putGatedContent(db, {
        subject: body.uri,
        did: caller,
        text: body.text ?? '',
        facets: body.facets,
        media,
      })
    },
  })

  server.add(net.krao.gate.uploadMedia, {
    auth: serviceAuth(net.krao.gate.uploadMedia.$lxm),
    opts: { blobLimit: GATED_MEDIA_MAX_BYTES },
    handler: async ({ auth, input, req }) => {
      const caller = (auth.credentials as { did: string }).did
      let data: Buffer
      try {
        data = await readBounded(
          input.body as AsyncIterable<Uint8Array>,
          GATED_MEDIA_MAX_BYTES,
        )
      } catch {
        throw new InvalidRequestError(
          `Gated media can be at most ${GATED_MEDIA_MAX_BYTES / 1024 / 1024} MB`,
        )
      }
      // Trust the bytes, not the declared content type
      const mimeType = sniffMediaType(data)
      if (!mimeType) {
        throw new InvalidRequestError(
          'Gated media must be a JPEG, PNG, GIF or WebP image, or an MP4 or WebM video',
        )
      }
      if (data.length > maxBytesFor(mimeType)) {
        throw new InvalidRequestError(
          `Gated ${mimeType.split('/')[0]}s can be at most ${maxBytesFor(mimeType) / 1024 / 1024} MB`,
        )
      }
      const id = await withUploadLock(caller, async () => {
        if (!(await withinUploadQuota(db, caller, data.length))) {
          throw new InvalidRequestError(
            'Daily limit for gated uploads reached, try again tomorrow',
            'UploadLimitExceeded',
          )
        }
        return insertGatedMedia(db, caller, mimeType, data)
      })
      return {
        encoding: 'application/json' as const,
        body: {
          media: {
            url: mediaSigner.url(baseUrl(req), id) as UriString,
            mimeType,
          },
        },
      }
    },
  })

  server.add(net.krao.actor.getChainProfiles, async ({ params }) => {
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

  server.add(net.krao.actor.resolveNft, async ({ params }) => {
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

  server.add(net.krao.feed.getTips, async ({ params }) => {
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
   * Feed generator for Krao's "latest" and "popular" feeds. AppViews call it with service
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
      // The record's rkey picks the ranking: "popular", else newest first
      const limit = params.limit ?? 50
      const page =
        params.feed.split('/').pop() === POPULAR_FEED_RKEY
          ? getPopularPosts(
              db,
              limit,
              params.cursor,
              undefined,
              await popularRanking(),
            )
          : getLatestPosts(db, limit, params.cursor)
      const { posts, cursor } = await page.catch(() => {
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

  /*
   * Discovery skeletons for the AppView (its suggestions, topics and iris
   * services all point here). They list public data only; `viewer` just
   * leaves out what that account already follows.
   */
  const usersSkeleton = async (params: {
    viewer?: string
    limit?: number
  }) => ({
    encoding: 'application/json' as const,
    body: {
      dids: (await suggestedAccounts(
        db,
        { viewer: params.viewer, limit: params.limit ?? 25 },
        await globalAccountScores(),
      )) as `did:${string}:${string}`[],
    },
  })
  const unspecced = bskyApp.bsky.unspecced
  server.add(unspecced.getSuggestedUsersSkeleton, ({ params }) =>
    usersSkeleton(params),
  )
  server.add(unspecced.getSuggestedUsersForExploreSkeleton, ({ params }) =>
    usersSkeleton(params),
  )
  server.add(unspecced.getSuggestedUsersForDiscoverSkeleton, ({ params }) =>
    usersSkeleton(params),
  )
  server.add(unspecced.getSuggestedUsersForSeeMoreSkeleton, ({ params }) =>
    usersSkeleton(params),
  )
  server.add(unspecced.getOnboardingSuggestedUsersSkeleton, ({ params }) =>
    usersSkeleton(params),
  )
  server.add(unspecced.getSuggestionsSkeleton, async ({ params }) => {
    const dids = await suggestedAccounts(
      db,
      {
        viewer: params.viewer,
        relativeTo: params.relativeToDid,
        limit: params.limit ?? 50,
      },
      await globalAccountScores(),
    )
    return {
      encoding: 'application/json' as const,
      body: {
        actors: dids.map((did) => ({ did: did as `did:${string}:${string}` })),
        ...(params.relativeToDid
          ? { relativeToDid: params.relativeToDid }
          : {}),
      },
    }
  })
  server.add(unspecced.getSuggestedFeedsSkeleton, async ({ params }) => ({
    encoding: 'application/json' as const,
    body: {
      feeds: (await listFeedGenerators(db)).slice(
        0,
        params.limit ?? 10,
      ) as AtUriString[],
    },
  }))
  const starterPacksSkeleton = async (params: {
    viewer?: string
    limit?: number
  }) => ({
    encoding: 'application/json' as const,
    body: {
      starterPacks: (await suggestedStarterPacks(db, {
        viewer: params.viewer,
        limit: params.limit ?? 10,
      })) as AtUriString[],
    },
  })
  server.add(unspecced.getSuggestedStarterPacksSkeleton, ({ params }) =>
    starterPacksSkeleton(params),
  )
  server.add(
    unspecced.getOnboardingSuggestedStarterPacksSkeleton,
    ({ params }) => starterPacksSkeleton(params),
  )
  server.add(unspecced.getTrendingTopics, async ({ params }) => {
    const tags = await trendingTags(db, params.limit ?? 10)
    return {
      encoding: 'application/json' as const,
      body: {
        topics: tags.map((t) => ({
          topic: `#${t.tag}`,
          link: `/hashtag/${encodeURIComponent(t.tag)}`,
        })),
        suggested: [],
      },
    }
  })
  server.add(unspecced.getTrendsSkeleton, async ({ params }) => {
    const tags = await trendingTags(db, params.limit ?? 10)
    return {
      encoding: 'application/json' as const,
      body: {
        trends: tags.map((t) => ({
          topic: t.tag,
          displayName: `#${t.tag}`,
          link: `/hashtag/${encodeURIComponent(t.tag)}`,
          startedAt: t.startedAt as DatetimeString,
          postCount: t.postCount,
          dids: t.dids as `did:${string}:${string}`[],
        })),
      },
    }
  })

  server.add(net.krao.feed.getTipTotals, async ({ params }) => {
    const subjects = await tipTotalsForSubjects(db, params.subjects)
    return {
      encoding: 'application/json' as const,
      body: {
        subjects: subjects as net.krao.feed.getTipTotals.SubjectTotals[],
      },
    }
  })

  const app = express()
  catchAsyncErrors(app)
  /*
   * Behind a reverse proxy, req.protocol and req.ip should follow the
   * X-Forwarded-* headers, but only when a proxy on a private network set them
   */
  app.set('trust proxy', 'loopback, linklocal, uniquelocal')
  app.use(cors())
  // Public routes that fetch from the internet or the chain on each call
  app.use('/v1/extract', rateLimit(60))
  app.use('/v1/image', rateLimit(120))
  app.use('/nft-image', rateLimit(30))
  app.use('/xrpc/net.krao.actor.resolveNft', rateLimit(30))
  app.use('/gifs', rateLimit(240))
  app.use('/klipy', rateLimit(120))
  app.post('/s/link', rateLimit(20))
  // Plain landing text so uptime checks on the bare host get a 200
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Krao indexer. Health: /_health')
  })
  app.get('/_health', async (_req, res) => {
    try {
      const cursor = await db
        .selectFrom('cursor')
        .select('seq')
        .where('id', '=', 'firehose')
        .executeTakeFirst()
      const failed = await db
        .selectFrom('failed_event')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirst()
      res.json({
        ok: true,
        firehoseSeq: cursor?.seq ?? null,
        failedEvents: Number(failed?.count ?? 0),
      })
    } catch {
      res.status(503).json({ ok: false, error: 'Database' })
    }
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
  addGatedMediaRoute(app, db, mediaSigner)
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
      res.status(502).json({ error: publicFetchError(err) })
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
        .json({ error: 'UpstreamFailure', message: publicFetchError(err) })
    }
  })
  app.use(server.router)
  app.use(errorHandler)
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

/** Our own fetch errors are safe to show; others may leak upstream detail */
function publicFetchError(err: unknown): string {
  return err instanceof SafeFetchError
    ? err.message
    : 'Could not fetch the image'
}
