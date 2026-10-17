import { InvalidAccountError, parseAccountId, sameAddress } from './account.js'
import { verifyAccountSignature } from './contract-signature.js'
import { InvalidMessageError, parseSignInMessage } from './message.js'
import type { EvmRpcForChain } from './rpc.js'

/** The `walletProof` object from `net.krao.chain.defs`. */
export type WalletProof = {
  type: string
  message: string
  signature: string
}

export type ProofResult = { ok: true } | { ok: false; reason: string }

/**
 * Every link proof is a message Krao's app wrote: this domain and statement.
 * Wallets warn when a site asks to sign a message for another domain, so a
 * phishing site cannot quietly get a link proof naming its own account.
 */
export const LINK_DOMAIN = 'krao.net'
export const LINK_STATEMENT = 'Link this wallet to my Krao account.'

const PROOF_TYPE = { eip155: 'siwe', solana: 'siws' } as const
const MESSAGE_CHAIN = { eip155: 'Ethereum', solana: 'Solana' } as const

/**
 * Check a `net.krao.actor.wallet` link: the proof must be Krao's link
 * message (LINK_DOMAIN, LINK_STATEMENT) from the same wallet and chain as
 * `account`, it must name `did` (as the URI
 * or one of the resources) so it cannot be replayed for another account, and
 * the signature must be valid. Link proofs are permanent attestations, so the
 * message's expiration time is not enforced here.
 *
 * With `rpc`, EVM proofs from contract wallets (ERC-1271, ERC-6492,
 * EIP-7702) are checked on the account's chain; that may throw when the
 * chain cannot be reached. Plain accounts are always checked offline.
 */
export async function verifyWalletProof(params: {
  did: string
  account: string
  proof: WalletProof
  rpc?: EvmRpcForChain
}): Promise<ProofResult> {
  const { did, proof } = params
  try {
    const account = parseAccountId(params.account)
    if (proof.type !== PROOF_TYPE[account.namespace]) {
      // Not echoing proof.type: reasons are shown, and it is record data
      return fail(`Proof type does not match ${account.namespace}`)
    }
    const msg = parseSignInMessage(proof.message)
    if (msg.chain !== MESSAGE_CHAIN[account.namespace]) {
      return fail('Message is for a different chain family')
    }
    if (!sameAddress(account.namespace, msg.address, account.address)) {
      return fail('Message address does not match the account')
    }
    if (msg.chainId && msg.chainId !== account.reference) {
      return fail('Message chain ID does not match the account')
    }
    if (msg.domain !== LINK_DOMAIN || msg.statement !== LINK_STATEMENT) {
      return fail('Message was not written by Krao for linking a wallet')
    }
    if (msg.uri !== did && !msg.resources.includes(did)) {
      return fail('Message does not name the DID')
    }
    if (
      !(await verifyAccountSignature(account, proof.message, proof.signature, {
        rpc: params.rpc,
      }))
    ) {
      return fail('Invalid signature')
    }
    return { ok: true }
  } catch (err) {
    if (
      err instanceof InvalidAccountError ||
      err instanceof InvalidMessageError
    ) {
      return fail(err.message)
    }
    throw err
  }
}

function fail(reason: string): ProofResult {
  return { ok: false, reason }
}
