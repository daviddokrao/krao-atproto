import * as ui8 from 'uint8arrays'

export type WalletNamespace = 'eip155' | 'solana'

/** A parsed CAIP-10 account ID. */
export type WalletAccount = {
  namespace: WalletNamespace
  /** CAIP-2 chain reference, eg '1' for Ethereum mainnet. */
  reference: string
  address: string
  /** CAIP-2 chain ID, eg 'eip155:1'. */
  chainId: string
}

export class InvalidAccountError extends Error {}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const EVM_REFERENCE = /^[1-9][0-9]{0,31}$/
const SOLANA_REFERENCE = /^[1-9A-HJ-NP-Za-km-z]{32}$/

/**
 * Parse a CAIP-10 account ID such as `eip155:1:0xab16...` or
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<base58 pubkey>`. Only the
 * namespaces Krao can verify signatures for are accepted.
 */
export function parseAccountId(id: string): WalletAccount {
  const parts = id.split(':')
  if (parts.length !== 3) {
    throw new InvalidAccountError(`Invalid CAIP-10 account ID: ${id}`)
  }
  const [namespace, reference, address] = parts
  if (namespace === 'eip155') {
    if (!EVM_REFERENCE.test(reference) || !EVM_ADDRESS.test(address)) {
      throw new InvalidAccountError(`Invalid EVM account ID: ${id}`)
    }
  } else if (namespace === 'solana') {
    if (!SOLANA_REFERENCE.test(reference) || !isSolanaPublicKey(address)) {
      throw new InvalidAccountError(`Invalid Solana account ID: ${id}`)
    }
  } else {
    throw new InvalidAccountError(`Unsupported chain namespace: ${namespace}`)
  }
  return {
    namespace,
    reference,
    address,
    chainId: `${namespace}:${reference}`,
  }
}

export function formatAccountId(account: {
  namespace: WalletNamespace
  reference: string
  address: string
}): string {
  return `${account.namespace}:${account.reference}:${account.address}`
}

/**
 * Whether two addresses refer to the same wallet. EVM addresses are
 * case-insensitive (mixed case is only an EIP-55 checksum); Solana base58
 * addresses are case-sensitive.
 */
export function sameAddress(
  namespace: WalletNamespace,
  a: string,
  b: string,
): boolean {
  return namespace === 'eip155' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Canonical form of an account ID for lookups: lowercase EVM addresses so the
 * same wallet always maps to the same key regardless of checksum casing.
 */
export function normalizeAccountId(id: string): string {
  const account = parseAccountId(id)
  return account.namespace === 'eip155'
    ? formatAccountId({ ...account, address: account.address.toLowerCase() })
    : id
}

function isSolanaPublicKey(address: string): boolean {
  try {
    return ui8.fromString(address, 'base58btc').length === 32
  } catch {
    return false
  }
}
