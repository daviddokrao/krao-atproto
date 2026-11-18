import type express from 'express'
import { InvalidRequestError, type Server } from '@atproto/xrpc-server'
import { net } from './lexicons/index.js'
import { keyedLimit } from './rate-limit.js'
import { inspectSignature } from './sign-inspect.js'
import {
  PreviewError,
  type PreviewOptions,
  simulateTransaction,
} from './simulate.js'

/*
 * Transaction and signature previews (net.krao.wallet.simulate and
 * inspectSignature), for signed-in accounts only (service auth to the
 * indexer), 30 a minute per account (and per IP, see server.ts): each one
 * runs calls on Krao's node.
 */

export const PREVIEWS_PER_MINUTE = 30

type AuthVerifier = (ctx: {
  req: express.Request
}) => Promise<{ credentials: { did: string } }>

export function addWalletRoutes(
  server: Server,
  opts: PreviewOptions & {
    /** Service auth for a method (audience: the indexer's gate DID) */
    serviceAuth: (lxm: string) => AuthVerifier
    webOrigins: string[]
  },
) {
  const limit = keyedLimit(PREVIEWS_PER_MINUTE, 60_000)
  const wallet = net.krao.wallet
  const run = async <T>(did: string, fn: () => Promise<T>) => {
    limit(did)
    try {
      return {
        encoding: 'application/json' as const,
        body: (await fn()) as never,
      }
    } catch (err) {
      if (err instanceof PreviewError) {
        throw new InvalidRequestError(
          err.message,
          err.code === 'InvalidRequest' ? undefined : err.code,
        )
      }
      throw err
    }
  }

  server.add(wallet.simulate, {
    auth: opts.serviceAuth(wallet.simulate.$lxm),
    handler: async ({ auth, input }) =>
      run(auth.credentials.did, () => simulateTransaction(opts, input.body)),
  })

  server.add(wallet.inspectSignature, {
    auth: opts.serviceAuth(wallet.inspectSignature.$lxm),
    handler: async ({ auth, input }) =>
      run(auth.credentials.did, () => inspectSignature(opts, input.body)),
  })
}
