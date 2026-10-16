import { keccak_256 } from '@noble/hashes/sha3'
import * as ui8 from 'uint8arrays'

/**
 * Just enough Solidity ABI encoding for the contract calls Krao makes to
 * check signatures (ERC-1271, ERC-6492, Coinbase Smart Wallet). Not a
 * general ABI library.
 */
export type AbiValue =
  /** A static 32 byte word (uint, address, bytes32...), see `word` */
  | { word: Uint8Array }
  | { bytes: Uint8Array }
  /** A dynamic array, eg bytes[] */
  | { array: AbiValue[] }
  /** A tuple with a dynamic member, eg a struct holding bytes */
  | { tuple: AbiValue[] }

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  if (clean.length % 2 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Invalid hex string')
  }
  return ui8.fromString(clean.toLowerCase(), 'base16')
}

export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + ui8.toString(bytes, 'base16')
}

/** The 4 byte selector of a function signature, eg `transfer(address,uint256)` */
export function functionSelector(signature: string): Uint8Array {
  return keccak_256(ui8.fromString(signature, 'utf8')).slice(0, 4)
}

/** A 32 byte word holding an unsigned integer */
export function uintWord(value: bigint | number): Uint8Array {
  const out = new Uint8Array(32)
  let v = BigInt(value)
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** A 32 byte word holding an address (or any value), left padded */
export function addressWord(address: string): Uint8Array {
  const bytes = hexToBytes(address)
  if (bytes.length > 32) throw new Error('Value longer than a word')
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

export function readUint(data: Uint8Array, offset: number): bigint {
  if (offset + 32 > data.length) throw new Error('ABI data too short')
  let v = 0n
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(data[offset + i])
  return v
}

/** ABI-encode a parameter list (abi.encode) */
export function abiEncode(values: AbiValue[]): Uint8Array {
  const heads: Uint8Array[] = []
  const tails: Uint8Array[] = []
  let tailOffset = values.length * 32
  for (const value of values) {
    if ('word' in value) {
      heads.push(value.word)
    } else {
      const tail = encodeDynamic(value)
      heads.push(uintWord(tailOffset))
      tails.push(tail)
      tailOffset += tail.length
    }
  }
  return ui8.concat([...heads, ...tails])
}

function encodeDynamic(value: Exclude<AbiValue, { word: Uint8Array }>) {
  if ('bytes' in value) {
    const padded = new Uint8Array(Math.ceil(value.bytes.length / 32) * 32)
    padded.set(value.bytes)
    return ui8.concat([uintWord(value.bytes.length), padded])
  }
  if ('array' in value) {
    return ui8.concat([uintWord(value.array.length), abiEncode(value.array)])
  }
  return abiEncode(value.tuple)
}

/** Read a `bytes` value whose offset word is at `headOffset` (abi.decode) */
export function readBytes(data: Uint8Array, headOffset: number): Uint8Array {
  const start = Number(readUint(data, headOffset))
  if (start + 32 > data.length) throw new Error('ABI data too short')
  const length = Number(readUint(data, start))
  if (start + 32 + length > data.length) throw new Error('ABI data too short')
  return data.slice(start + 32, start + 32 + length)
}

/** Read an address word at `offset` as a lowercase 0x string */
export function readAddress(data: Uint8Array, offset: number): string {
  if (offset + 32 > data.length) throw new Error('ABI data too short')
  return bytesToHex(data.slice(offset + 12, offset + 32))
}
