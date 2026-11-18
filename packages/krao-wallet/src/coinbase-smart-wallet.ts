import { keccak_256 } from '@noble/hashes/sha3'
import * as ui8 from 'uint8arrays'
import {
  abiEncode,
  addressWord,
  bytesToHex,
  functionSelector,
  hexToBytes,
  uintWord,
} from './abi.js'
import { wrapErc6492Signature } from './contract-signature.js'

/**
 * Coinbase Smart Wallet (v1.1) helpers, for tests and tools that act as one:
 * the factory's calls, and the signature format its isValidSignature takes.
 * Krao checks these signatures through ERC-1271/6492 like any other wallet.
 */

/** CoinbaseSmartWalletFactory, at the same address on Base and other chains */
export const COINBASE_SMART_WALLET_FACTORY =
  '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a'

const utf8 = (s: string) => ui8.fromString(s, 'utf8')

const DOMAIN_TYPEHASH = keccak_256(
  utf8(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ),
)
const MESSAGE_TYPEHASH = keccak_256(
  utf8('CoinbaseSmartWalletMessage(bytes32 hash)'),
)

/** Owners are bytes: abi.encode(address) for a plain account */
function ownersArray(owners: string[]) {
  return { array: owners.map((o) => ({ bytes: addressWord(o) })) }
}

/** Calldata of `createAccount(bytes[] owners, uint256 nonce)` */
export function coinbaseCreateAccountCalldata(
  owners: string[],
  nonce: bigint | number = 0,
): string {
  return bytesToHex(
    ui8.concat([
      functionSelector('createAccount(bytes[],uint256)'),
      abiEncode([ownersArray(owners), { word: uintWord(nonce) }]),
    ]),
  )
}

/** Calldata of the factory's `getAddress(bytes[] owners, uint256 nonce)` */
export function coinbaseGetAddressCalldata(
  owners: string[],
  nonce: bigint | number = 0,
): string {
  return bytesToHex(
    ui8.concat([
      functionSelector('getAddress(bytes[],uint256)'),
      abiEncode([ownersArray(owners), { word: uintWord(nonce) }]),
    ]),
  )
}

/**
 * The hash a wallet owner signs for the wallet to accept `hash`
 * (`replaySafeHash`): EIP-712 over CoinbaseSmartWalletMessage, bound to the
 * wallet and the chain.
 */
export function coinbaseReplaySafeHash(params: {
  hash: Uint8Array
  wallet: string
  chainId: bigint | number
}): Uint8Array {
  const domainSeparator = keccak_256(
    abiEncode([
      { word: DOMAIN_TYPEHASH },
      { word: keccak_256(utf8('Coinbase Smart Wallet')) },
      { word: keccak_256(utf8('1')) },
      { word: uintWord(params.chainId) },
      { word: addressWord(params.wallet) },
    ]),
  )
  const structHash = keccak_256(
    abiEncode([{ word: MESSAGE_TYPEHASH }, { word: params.hash }]),
  )
  return keccak_256(
    ui8.concat([new Uint8Array([0x19, 0x01]), domainSeparator, structHash]),
  )
}

/**
 * The wallet's signature: abi.encode(SignatureWrapper(ownerIndex,
 * signatureData)), where signatureData is the owner's 65 byte ECDSA
 * signature over the replay-safe hash.
 */
export function coinbaseSignature(params: {
  ownerIndex?: number
  ownerSignature: string | Uint8Array
}): string {
  const sig =
    typeof params.ownerSignature === 'string'
      ? hexToBytes(params.ownerSignature)
      : params.ownerSignature
  return bytesToHex(
    abiEncode([
      {
        tuple: [{ word: uintWord(params.ownerIndex ?? 0) }, { bytes: sig }],
      },
    ]),
  )
}

/**
 * coinbaseSignature wrapped for a wallet that is not deployed yet (ERC-6492):
 * the verifier deploys it through the factory in a simulation first.
 */
export function coinbaseUndeployedSignature(params: {
  owners: string[]
  nonce?: bigint | number
  ownerIndex?: number
  ownerSignature: string | Uint8Array
}): string {
  return wrapErc6492Signature({
    factory: COINBASE_SMART_WALLET_FACTORY,
    factoryCalldata: coinbaseCreateAccountCalldata(
      params.owners,
      params.nonce ?? 0,
    ),
    signature: coinbaseSignature(params),
  })
}
