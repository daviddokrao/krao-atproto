import type { IdResolver } from '@atproto/identity'
import type { AtUriString, DatetimeString, UriString } from '@atproto/syntax'
import { InvalidRequestError, type Server } from '@atproto/xrpc-server'
import { moderatorAuth } from './gate-moderation.js'
import { net } from './lexicons/index.js'
import {
  PRICE_RANGES,
  type PriceRange,
  type TokenCatalog,
  TokenError,
  type TokenViewData,
} from './token.js'

/*
 * net.krao.token.*: the token catalog, prices and cashtag feeds are public;
 * the admin methods are for the safety admins (service auth to the
 * indexer's gate DID), like the unsafe domain list.
 */

type TokenView = net.krao.token.defs.TokenView

const toView = (data: TokenViewData, holderFeed?: string): TokenView => ({
  ...data,
  logo: data.logo as UriString | undefined,
  updatedAt: data.updatedAt as DatetimeString | undefined,
  ...(holderFeed ? { holderFeed: holderFeed as AtUriString } : {}),
})

export function addTokenRoutes(
  server: Server,
  opts: {
    tokens: TokenCatalog
    idResolver: IdResolver
    gateDid: string
    admins: Set<string>
    /** The token's holders-<symbol> feed, when one is published */
    holderFeed?: (key: string) => Promise<string | undefined>
  },
) {
  const { tokens } = opts
  const holderFeed = async (key: string) => opts.holderFeed?.(key)
  const token = net.krao.token
  const find = async (symbol: string) => {
    const row = await tokens.getToken(symbol)
    if (!row) throw new InvalidRequestError('Token not found', 'NotFound')
    return row
  }
  const adminAuth = (lxm: string) =>
    moderatorAuth(
      {
        idResolver: opts.idResolver,
        gateDid: opts.gateDid,
        moderators: opts.admins,
      },
      lxm,
    )

  server.add(token.listTokens, async () => {
    const rows = await tokens.listTokens()
    const views = await Promise.all(
      rows.map(async (row) =>
        toView(await tokens.view(row), await holderFeed(row.key)),
      ),
    )
    return {
      encoding: 'application/json' as const,
      body: { tokens: views },
    }
  })

  server.add(token.getToken, async ({ params }) => {
    const row = await find(params.symbol)
    return {
      encoding: 'application/json' as const,
      body: {
        token: toView(await tokens.view(row), await holderFeed(row.key)),
      },
    }
  })

  server.add(token.getPriceHistory, async ({ params }) => {
    const range = (params.range ?? '1d') as PriceRange
    if (!Object.hasOwn(PRICE_RANGES, range)) {
      throw new InvalidRequestError('Range must be 1d, 7d or 30d')
    }
    const row = await find(params.symbol)
    const points = await tokens.priceHistory(row.key, range)
    return {
      encoding: 'application/json' as const,
      body: {
        points: points.map((p) => ({
          t: p.t as DatetimeString,
          priceUsd: p.priceUsd,
        })),
      },
    }
  })

  server.add(token.getFeed, async ({ params }) => {
    const row = await find(params.symbol)
    const page = await tokens
      .feed(row.key, params.limit ?? 30, params.cursor)
      .catch(() => {
        throw new InvalidRequestError('Malformed cursor')
      })
    return {
      encoding: 'application/json' as const,
      body: {
        feed: page.uris.map((uri) => ({ post: uri as AtUriString })),
        cursor: page.cursor,
      },
    }
  })

  server.add(token.admin.putToken, {
    auth: adminAuth(token.admin.putToken.$lxm),
    handler: async ({ auth, input }) => {
      try {
        const row = await tokens.putToken(input.body)
        console.info(
          `Krao indexer: ${(auth.credentials as { did: string }).did} put token ${row.symbol} (${row.address})`,
        )
        return {
          encoding: 'application/json' as const,
          body: { token: toView(await tokens.view(row)) },
        }
      } catch (err) {
        if (err instanceof TokenError) {
          throw new InvalidRequestError(err.message, err.code)
        }
        throw err
      }
    },
  })

  server.add(token.admin.removeToken, {
    auth: adminAuth(token.admin.removeToken.$lxm),
    handler: async ({ auth, input }) => {
      const removed = await tokens.removeToken(input.body.symbol)
      if (removed) {
        console.info(
          `Krao indexer: ${(auth.credentials as { did: string }).did} removed token ${input.body.symbol}`,
        )
      }
      return { encoding: 'application/json' as const, body: { removed } }
    },
  })

  server.add(token.admin.samplePrices, {
    auth: adminAuth(token.admin.samplePrices.$lxm),
    handler: async () => ({
      encoding: 'application/json' as const,
      body: await tokens.sample(),
    }),
  })
}
