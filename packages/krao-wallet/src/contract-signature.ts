import * as ui8 from 'uint8arrays'
import {
  abiEncode,
  addressWord,
  bytesToHex,
  functionSelector,
  hexToBytes,
  readAddress,
  readBytes,
  readUint,
  uintWord,
} from './abi.js'
import type { WalletAccount } from './account.js'
import {
  type EvmJsonRpc,
  type EvmRpcForChain,
  RpcResponseError,
} from './rpc.js'
import {
  hashEvmMessage,
  recoverEvmAddressFromHash,
  verifySignature,
} from './signature.js'

/** ERC-1271 `isValidSignature(bytes32,bytes)`, also its "valid" answer */
export const ERC1271_MAGIC_VALUE = '0x1626ba7e'
const IS_VALID_SIGNATURE = functionSelector('isValidSignature(bytes32,bytes)')

/** ERC-6492: a signature ending with this is wrapped for an undeployed wallet */
export const ERC6492_MAGIC_SUFFIX = '0x' + '6492'.repeat(16)
const ERC6492_SUFFIX_BYTES = hexToBytes(ERC6492_MAGIC_SUFFIX)

/**
 * Init code that deploys nothing: run with eth_call (no `to`), it calls a
 * wallet factory, then the wallet's isValidSignature, and returns
 * `(bool success, uint256 returnDataSize, bytes32 returnWord)`. This is the
 * "deployless" check of ERC-6492 for wallets that do not exist yet, with
 * the ABI work done off-chain: the ECDSA and deployed-wallet cases never get
 * here (see verifyEvmHashSignature), so the contract is tiny and written out
 * below instead of compiled.
 *
 * Arguments follow the code (offsets in the copy at memory 0):
 * 0x00 factory, 0x20 wallet, 0x40 factory calldata length (n),
 * 0x60 isValidSignature calldata length (m), 0x80 factory calldata,
 * 0x80+n isValidSignature calldata.
 */
const DEPLOYLESS_CHECK = [
  // codecopy(0, 58, codesize - 58): the arguments to memory 0
  '61003a', // PUSH2 58 (this code's length)
  '38', //     CODESIZE
  '03', //     SUB
  '61003a', // PUSH2 58
  '6000', //   PUSH1 0
  '39', //     CODECOPY
  // call(gas, factory, 0, 0x80, n, 0, 0): deploy the wallet
  '6000', //   PUSH1 0 (retSize)
  '6000', //   PUSH1 0 (retOffset)
  '604051', // MLOAD 0x40 (n)
  '6080', //   PUSH1 0x80
  '6000', //   PUSH1 0 (value)
  '600051', // MLOAD 0 (factory)
  '5a', //     GAS
  'f1', //     CALL
  '50', //     POP: a failed deploy fails the check below
  // staticcall(gas, wallet, 0x80+n, m, 0x40, 32)
  '6020', //   PUSH1 32 (retSize)
  '6040', //   PUSH1 0x40 (retOffset)
  '606051', // MLOAD 0x60 (m)
  '604051', // MLOAD 0x40 (n)
  '608001', // ADD 0x80
  '602051', // MLOAD 0x20 (wallet)
  '5a', //     GAS
  'fa', //     STATICCALL
  // return (success, returndatasize, word at 0x40); starts with a 0 byte,
  // so it is never refused as EOF code (EIP-3541)
  '600052', // MSTORE 0 (success)
  '3d', //     RETURNDATASIZE
  '602052', // MSTORE 0x20
  '6060', //   PUSH1 0x60
  '6000', //   PUSH1 0
  'f3', //     RETURN
].join('')
export const DEPLOYLESS_CHECK_LENGTH = DEPLOYLESS_CHECK.length / 2

/**
 * `verifySignature`, plus contract wallets: an EVM signature that is not
 * the address's own ECDSA signature is checked on the account's chain when
 * `rpc` has an endpoint for it (see verifyEvmHashSignature). Without one,
 * EVM accounts are checked offline, as plain accounts.
 */
export async function verifyAccountSignature(
  account: WalletAccount,
  message: string,
  signature: string,
  opts: { rpc?: EvmRpcForChain } = {},
): Promise<boolean> {
  if (account.namespace !== 'eip155') {
    return verifySignature(account, message, signature)
  }
  return verifyEvmHashSignature({
    address: account.address,
    hash: hashEvmMessage(message),
    signature,
    rpc: opts.rpc?.(account.chainId),
  })
}

/**
 * Whether `signature` is `address`'s signature over the 32 byte `hash`:
 *
 * 1. ECDSA (ecrecover), offline. Covers plain accounts and EIP-7702
 *    accounts signing with their own key.
 * 2. With an `rpc`: an ERC-1271 wallet contract (`isValidSignature`), also
 *    an EIP-7702 account whose delegate implements it.
 * 3. With an `rpc`: an ERC-6492 wrapped signature from a wallet that is not
 *    deployed yet (eg a new Coinbase Smart Wallet), checked by simulating
 *    the deployment in an eth_call.
 *
 * Returns false for invalid signatures; throws (RpcTransportError, or
 * RpcResponseError other than a revert) when the chain could not answer.
 */
export async function verifyEvmHashSignature(params: {
  address: string
  hash: Uint8Array
  signature: string
  rpc?: EvmJsonRpc
}): Promise<boolean> {
  const { hash, rpc } = params
  const address = params.address.toLowerCase()
  let sig: Uint8Array
  try {
    sig = hexToBytes(params.signature)
  } catch {
    return false
  }
  const wrapped = isErc6492Signature(sig)
  if (!wrapped && sig.length === 65) {
    try {
      if (recoverEvmAddressFromHash(hash, sig) === address) return true
    } catch {
      // not a valid ECDSA signature: may still be a wallet's
    }
  }
  if (!rpc) return false

  const code = (await rpc('eth_getCode', [address, 'latest'])) as string
  const deployed = typeof code === 'string' && code.length > 2
  if (wrapped) {
    let unwrapped: ReturnType<typeof unwrapErc6492Signature>
    try {
      unwrapped = unwrapErc6492Signature(sig)
    } catch {
      return false
    }
    if (!deployed) {
      return deploylessCheck(rpc, {
        ...unwrapped,
        address,
        checkCalldata: isValidSignatureCalldata(hash, unwrapped.signature),
      })
    }
    // Deployed since it signed: the wrapped signature is the wallet's own
    sig = unwrapped.signature
  }
  if (!deployed) return false
  return erc1271Check(rpc, address, isValidSignatureCalldata(hash, sig))
}

export function isErc6492Signature(sig: Uint8Array): boolean {
  return (
    sig.length > 32 &&
    ui8.equals(sig.slice(sig.length - 32), ERC6492_SUFFIX_BYTES)
  )
}

/** abi.encode(factory, factoryCalldata, signature) ++ magic suffix */
export function wrapErc6492Signature(params: {
  factory: string
  factoryCalldata: string | Uint8Array
  signature: string | Uint8Array
}): string {
  const asBytes = (v: string | Uint8Array) =>
    typeof v === 'string' ? hexToBytes(v) : v
  return bytesToHex(
    ui8.concat([
      abiEncode([
        { word: addressWord(params.factory) },
        { bytes: asBytes(params.factoryCalldata) },
        { bytes: asBytes(params.signature) },
      ]),
      ERC6492_SUFFIX_BYTES,
    ]),
  )
}

export function unwrapErc6492Signature(sig: Uint8Array): {
  factory: string
  factoryCalldata: Uint8Array
  signature: Uint8Array
} {
  const data = sig.slice(0, sig.length - 32)
  return {
    factory: readAddress(data, 0),
    factoryCalldata: readBytes(data, 32),
    signature: readBytes(data, 64),
  }
}

function isValidSignatureCalldata(hash: Uint8Array, sig: Uint8Array) {
  return ui8.concat([
    IS_VALID_SIGNATURE,
    abiEncode([{ word: hash }, { bytes: sig }]),
  ])
}

/** The ERC-1271 answer is the magic value, left aligned in a 32 byte word */
function isMagicWord(word: Uint8Array): boolean {
  return (
    word.length >= 32 &&
    bytesToHex(word.slice(0, 4)) === ERC1271_MAGIC_VALUE &&
    word.slice(4, 32).every((b) => b === 0)
  )
}

async function ethCall(
  rpc: EvmJsonRpc,
  tx: { to?: string; data: string },
): Promise<Uint8Array | null> {
  try {
    const result = await rpc('eth_call', [tx, 'latest'])
    return typeof result === 'string' ? hexToBytes(result) : null
  } catch (err) {
    if (err instanceof RpcResponseError && err.isRevert) return null
    throw err
  }
}

async function erc1271Check(
  rpc: EvmJsonRpc,
  address: string,
  calldata: Uint8Array,
): Promise<boolean> {
  const result = await ethCall(rpc, { to: address, data: bytesToHex(calldata) })
  return !!result && isMagicWord(result)
}

async function deploylessCheck(
  rpc: EvmJsonRpc,
  params: {
    factory: string
    factoryCalldata: Uint8Array
    address: string
    checkCalldata: Uint8Array
  },
): Promise<boolean> {
  const args = ui8.concat([
    addressWord(params.factory),
    addressWord(params.address),
    uintWord(params.factoryCalldata.length),
    uintWord(params.checkCalldata.length),
    params.factoryCalldata,
    params.checkCalldata,
  ])
  const result = await ethCall(rpc, {
    data: '0x' + DEPLOYLESS_CHECK + ui8.toString(args, 'base16'),
  })
  if (!result || result.length !== 96) return false
  return (
    readUint(result, 0) === 1n &&
    readUint(result, 32) >= 32n &&
    isMagicWord(result.slice(64, 96))
  )
}
