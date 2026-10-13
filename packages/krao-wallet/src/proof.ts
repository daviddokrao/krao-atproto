import { InvalidAccountError, parseAccountId, sameAddress } from './account.js'
import { InvalidMessageError, parseSignInMessage } from './message.js'
import { verifySignature } from './signature.js'

/** The `walletProof` object from `io.krao.chain.defs`. */
export type WalletProof = {
  type: string
  message: string
  signature: string
}

export type ProofResult = { ok: true } | { ok: false; reason: string }

const PROOF_TYPE = { eip155: 'siwe', solana: 'siws' } as const
const MESSAGE_CHAIN = { eip155: 'Ethereum', solana: 'Solana' } as const

/**
 * Check an `io.krao.actor.wallet` link: the proof must be a sign-in message
 * from the same wallet and chain as `account`, it must name `did` (as the URI
 * or one of the resources) so it cannot be replayed for another account, and
 * the signature must be valid. Link proofs are permanent attestations, so the
 * message's expiration time is not enforced here.
 */
export function verifyWalletProof(params: {
  did: string
  account: string
  proof: WalletProof
}): ProofResult {
  const { did, proof } = params
  try {
    const account = parseAccountId(params.account)
    if (proof.type !== PROOF_TYPE[account.namespace]) {
      return fail(
        `Proof type ${proof.type} does not match ${account.namespace}`,
      )
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
    if (msg.uri !== did && !msg.resources.includes(did)) {
      return fail('Message does not name the DID')
    }
    if (!verifySignature(account, proof.message, proof.signature)) {
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
