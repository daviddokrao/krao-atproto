import {
  type EvmRpcForChain,
  InvalidMessageError,
  RpcResponseError,
  RpcTransportError,
  type SignInMessage,
  isPublicTestAddress,
  normalizeAccountId,
  parseSignInMessage,
  rpcForChains,
  sameAddress,
  verifyAccountSignature,
  verifyWalletProof,
} from '@krao/wallet'
import { MINUTE } from '@atproto/common'
import type { LexMap } from '@atproto/lex'
import {
  type DidString,
  type HandleString,
  INVALID_HANDLE,
  type NsidString,
} from '@atproto/syntax'
import {
  AuthRequiredError,
  InvalidRequestError,
  type Server,
  UpstreamFailureError,
} from '@atproto/xrpc-server'
import { formatAccountStatus } from '../../../../account-manager/account-manager.js'
import type { AppContext } from '../../../../context.js'
import { softDeleted } from '../../../../db/util.js'
import { events } from '../../../../events.js'
import { net } from '../../../../lexicons/index.js'
import { didDocForSession } from '../../../com/atproto/server/util.js'
import { parseAccountOrThrow } from './getWalletChallenge.js'

const WALLET_COLLECTION = 'net.krao.actor.wallet' as NsidString

export default function (server: Server, ctx: AppContext) {
  // Smart contract wallets sign in on this chain only; plain wallets anywhere
  const evmRpc = ctx.cfg.krao?.evmRpc
  const rpc = evmRpc
    ? rpcForChains({ [evmRpc.chainId]: evmRpc.url })
    : undefined
  server.add(net.krao.server.createWalletSession, {
    rateLimit: [
      {
        durationMs: 5 * MINUTE,
        points: 30,
        calcKey: ({ input, req }) => `${input.body.account}-${req.ip}`,
      },
    ],
    handler: async ({ input: { body } }) => {
      const account = parseAccountOrThrow(body.account)
      const normalized = normalizeAccountId(body.account)
      // Anyone can sign as a well-known test account, so outside dev mode it
      // must not open a session
      if (
        !ctx.cfg.service.devMode &&
        account.namespace === 'eip155' &&
        isPublicTestAddress(account.address)
      ) {
        throw new AuthRequiredError(
          'This wallet uses a public test key',
          'InvalidSignature',
        )
      }
      const publicUrl = new URL(ctx.cfg.service.publicUrl)

      let msg: SignInMessage
      try {
        msg = parseSignInMessage(body.message)
      } catch (err) {
        if (err instanceof InvalidMessageError) {
          throw new InvalidRequestError(err.message)
        }
        throw err
      }

      // The message must be the one this PDS issued for this wallet
      if (
        msg.domain !== publicUrl.host ||
        msg.uri !== publicUrl.origin ||
        msg.chainId !== account.reference ||
        !sameAddress(account.namespace, msg.address, account.address)
      ) {
        throw new AuthRequiredError(
          'Message was not issued for this wallet',
          'InvalidSignature',
        )
      }
      const valid = await chainCall(() =>
        verifyAccountSignature(account, body.message, body.signature, { rpc }),
      )
      if (!valid) {
        throw new AuthRequiredError('Invalid signature', 'InvalidSignature')
      }
      // Consumed only after the signature checks out, so a bad request
      // cannot burn someone else's pending challenge
      if (
        !(await ctx.accountManager.consumeWalletChallenge(
          msg.nonce,
          normalized,
        ))
      ) {
        throw new AuthRequiredError(
          'Challenge is unknown, already used or expired',
          'ExpiredChallenge',
        )
      }

      const did = await findLinkedAccount(ctx, normalized, rpc)
      if (!did) {
        throw new AuthRequiredError(
          'No account on this server has linked this wallet',
          'WalletNotLinked',
        )
      }

      const user = await ctx.accountManager.getAccount(did as DidString, {
        includeDeactivated: true,
        includeTakenDown: true,
      })
      if (!user) {
        throw new AuthRequiredError('Account not found', 'WalletNotLinked')
      }
      const isSoftDeleted = softDeleted(user)
      if (isSoftDeleted) {
        throw new AuthRequiredError(
          'Account has been taken down',
          'AccountTakedown',
        )
      }
      // A wallet must not become a way around the account's second factor
      if (user.emailAuthFactorAt) {
        throw new AuthRequiredError(
          'This account uses email two-factor authentication. Sign in with your password instead.',
        )
      }

      const [{ accessJwt, refreshJwt }, didDoc] = await Promise.all([
        ctx.accountManager.createSession(user.did, null, isSoftDeleted),
        didDocForSession(ctx, user.did),
      ])
      const { status, active } = formatAccountStatus(user)

      events.sessionCreated({
        source: 'net.krao.server.createWalletSession',
        did: user.did as DidString,
      })

      return {
        encoding: 'application/json' as const,
        body: {
          accessJwt,
          refreshJwt,
          did: user.did as DidString,
          // Same DidDocument vs LexMap mismatch that createSession works around
          didDoc: didDoc as unknown as LexMap | undefined,
          handle: (user.handle ?? INVALID_HANDLE) as HandleString,
          email: user.email ?? undefined,
          emailConfirmed: !!user.emailConfirmedAt,
          emailAuthFactor: !!user.emailAuthFactorAt,
          active,
          status,
        },
      }
    },
  })
}

/**
 * Asks the Krao indexer which accounts linked the wallet, then trusts only an
 * account hosted here whose own repo holds a valid net.krao.actor.wallet record
 * for it.
 */
async function findLinkedAccount(
  ctx: AppContext,
  account: string,
  rpc: EvmRpcForChain | undefined,
): Promise<string | null> {
  if (!ctx.cfg.krao) return null
  const url = new URL('/internal/wallet-owners', ctx.cfg.krao.indexerUrl)
  url.searchParams.set('account', account)
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) {
    throw new InvalidRequestError('Could not look up wallet owner')
  }
  const { dids } = (await res.json()) as { dids?: string[] }

  for (const did of dids ?? []) {
    const local = await ctx.accountManager.getAccount(did as DidString, {
      includeDeactivated: true,
      includeTakenDown: true,
    })
    if (!local) continue
    if (await hasValidWalletRecord(ctx, did, account, rpc)) return did
  }
  return null
}

async function hasValidWalletRecord(
  ctx: AppContext,
  did: string,
  account: string,
  rpc: EvmRpcForChain | undefined,
): Promise<boolean> {
  let cursor: string | undefined
  do {
    const records = await ctx.actorStore.read(did as DidString, (store) =>
      store.record.listRecordsForCollection({
        collection: WALLET_COLLECTION,
        limit: 100,
        reverse: false,
        cursor,
      }),
    )
    for (const { value } of records) {
      const record = value as {
        account?: unknown
        proof?: { type?: unknown; message?: unknown; signature?: unknown }
      }
      if (
        typeof record.account !== 'string' ||
        typeof record.proof?.type !== 'string' ||
        typeof record.proof.message !== 'string' ||
        typeof record.proof.signature !== 'string'
      ) {
        continue
      }
      try {
        if (!sameWallet(normalizeAccountId(record.account), account)) continue
      } catch {
        continue
      }
      const params = {
        did,
        account: record.account,
        proof: {
          type: record.proof.type,
          message: record.proof.message,
          signature: record.proof.signature,
        },
        rpc,
      }
      const result = await chainCall(() => verifyWalletProof(params))
      if (result.ok) return true
    }
    cursor =
      records.length === 100 ? records.at(-1)?.uri.split('/').pop() : undefined
  } while (cursor)
  return false
}

/**
 * Whether two normalized CAIP-10 ids are the same wallet. An EVM address is
 * the same wallet on every eip155 chain (the indexer counts it that way), so
 * a link made on one chain signs in on another.
 */
function sameWallet(a: string, b: string): boolean {
  if (a === b) return true
  const [nsA, , addressA] = a.split(':')
  const [nsB, , addressB] = b.split(':')
  return (
    nsA === 'eip155' && nsB === 'eip155' && !!addressA && addressA === addressB
  )
}

/** A contract wallet check that could not reach the chain fails as upstream */
async function chainCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RpcTransportError || err instanceof RpcResponseError) {
      throw new UpstreamFailureError(
        'Could not reach the chain to check the wallet signature',
      )
    }
    throw err
  }
}
