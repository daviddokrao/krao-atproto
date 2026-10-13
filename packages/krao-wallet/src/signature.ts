import { ed25519 } from '@noble/curves/ed25519'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import * as ui8 from 'uint8arrays'
import type { WalletAccount } from './account.js'

/**
 * Verify that `signature` is the account's signature over `message`.
 *
 * - EVM: an EIP-191 `personal_sign` signature (65 bytes, 0x hex) from an
 *   externally owned account. Contract wallets (ERC-1271) are not supported.
 * - Solana: an ed25519 signature (64 bytes, base58) over the UTF-8 message.
 */
export function verifySignature(
  account: WalletAccount,
  message: string,
  signature: string,
): boolean {
  try {
    return account.namespace === 'eip155'
      ? recoverEvmAddress(message, signature).toLowerCase() ===
          account.address.toLowerCase()
      : ed25519.verify(
          ui8.fromString(signature, 'base58btc'),
          ui8.fromString(message, 'utf8'),
          ui8.fromString(account.address, 'base58btc'),
        )
  } catch {
    return false
  }
}

/** Hash a message the way `personal_sign` does (EIP-191 version 0x45). */
export function hashEvmMessage(message: string): Uint8Array {
  const bytes = ui8.fromString(message, 'utf8')
  const prefix = ui8.fromString(
    `\x19Ethereum Signed Message:\n${bytes.length}`,
    'utf8',
  )
  return keccak_256(ui8.concat([prefix, bytes]))
}

/** Recover the 0x-prefixed lowercase address that signed `message`. */
export function recoverEvmAddress(message: string, signature: string): string {
  const sig = ui8.fromString(signature.replace(/^0x/, ''), 'base16')
  if (sig.length !== 65) {
    throw new Error('EVM signature must be 65 bytes')
  }
  let v = sig[64]
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) {
    throw new Error('Invalid signature recovery id')
  }
  const publicKey = secp256k1.Signature.fromCompact(sig.slice(0, 64))
    .addRecoveryBit(v)
    .recoverPublicKey(hashEvmMessage(message))
    .toRawBytes(false)
  return evmAddressFromPublicKey(publicKey)
}

/** Address of an uncompressed (65 byte) secp256k1 public key. */
export function evmAddressFromPublicKey(publicKey: Uint8Array): string {
  const hash = keccak_256(publicKey.slice(1))
  return '0x' + ui8.toString(hash.slice(-20), 'base16')
}
