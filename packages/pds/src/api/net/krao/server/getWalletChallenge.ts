import { randomBytes } from 'node:crypto'
import {
  InvalidAccountError,
  type WalletAccount,
  formatSignInMessage,
  normalizeAccountId,
  parseAccountId,
} from '@krao/wallet'
import { MINUTE } from '@atproto/common'
import type { DatetimeString } from '@atproto/lex'
import { InvalidRequestError, type Server } from '@atproto/xrpc-server'
import type { AppContext } from '../../../../context.js'
import { net } from '../../../../lexicons/index.js'

/** How long a sign-in challenge stays valid */
export const WALLET_CHALLENGE_TTL = 10 * MINUTE

export default function (server: Server, ctx: AppContext) {
  server.add(net.krao.server.getWalletChallenge, {
    rateLimit: {
      durationMs: 5 * MINUTE,
      points: 30,
      calcKey: ({ req }) => req.ip,
    },
    handler: async ({ params }) => {
      const account = parseAccountOrThrow(params.account)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + WALLET_CHALLENGE_TTL)
      const nonce = randomBytes(16).toString('hex')
      const publicUrl = new URL(ctx.cfg.service.publicUrl)

      const message = formatSignInMessage({
        domain: publicUrl.host,
        chain: account.namespace === 'eip155' ? 'Ethereum' : 'Solana',
        address: account.address,
        statement: 'Sign in to Krao.',
        uri: publicUrl.origin,
        version: '1',
        chainId: account.reference,
        nonce,
        issuedAt: now.toISOString(),
        expirationTime: expiresAt.toISOString(),
        resources: [],
      })

      await ctx.accountManager.createWalletChallenge({
        nonce,
        account: normalizeAccountId(params.account),
        expiresAt: expiresAt.toISOString(),
      })

      return {
        encoding: 'application/json' as const,
        body: {
          message,
          expiresAt: expiresAt.toISOString() as DatetimeString,
        },
      }
    },
  })
}

export function parseAccountOrThrow(accountId: string): WalletAccount {
  try {
    return parseAccountId(accountId)
  } catch (err) {
    if (err instanceof InvalidAccountError) {
      throw new InvalidRequestError(err.message, 'UnsupportedChain')
    }
    throw err
  }
}
