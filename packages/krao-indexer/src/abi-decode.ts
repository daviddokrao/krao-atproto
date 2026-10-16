import { bytesToHex, functionSelector, keccak256 } from '@krao/wallet'

/*
 * Reading ABI-encoded calldata, logs and return data (hex strings), just
 * enough for transaction previews (simulate.ts). Not a general ABI library.
 */

/** The 0x-prefixed 4 byte selector of a function signature */
export const selector = (signature: string) =>
  bytesToHex(functionSelector(signature))

/** The 0x-prefixed topic of an event signature */
export const eventTopic = (signature: string) =>
  bytesToHex(keccak256(new TextEncoder().encode(signature)))

/** 0x hex without the prefix, lower case */
export const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()

/** The `index`th 32 byte word of `hex` (no 0x), or undefined past the end */
export function wordAt(hex: string, index: number): string | undefined {
  const word = hex.slice(index * 64, index * 64 + 64)
  return word.length === 64 ? word : undefined
}

export function uintAt(hex: string, index: number): bigint | undefined {
  const word = wordAt(hex, index)
  return word === undefined ? undefined : BigInt('0x' + word)
}

/** An address word; undefined when the upper 12 bytes are not zero */
export function addressAt(hex: string, index: number): string | undefined {
  const word = wordAt(hex, index)
  if (word === undefined || !/^0{24}/.test(word)) return undefined
  return '0x' + word.slice(24)
}

/** A topic (0x + 64 hex) as an address */
export function topicAddress(topic: string | undefined): string | undefined {
  if (!topic) return undefined
  const word = strip(topic)
  return word.length === 64 ? '0x' + word.slice(24) : undefined
}

/** A dynamic uint256[] whose offset is in word `headIndex` of `hex` */
export function uintArrayAt(
  hex: string,
  headIndex: number,
  max = 256,
): bigint[] | undefined {
  const offset = uintAt(hex, headIndex)
  if (offset === undefined || offset % 32n) return undefined
  const start = Number(offset / 32n)
  const length = uintAt(hex, start)
  if (length === undefined || length > BigInt(max)) return undefined
  const items: bigint[] = []
  for (let i = 0; i < Number(length); i++) {
    const item = uintAt(hex, start + 1 + i)
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

/**
 * A string return value: ABI `string`, or a `bytes32` padded with zeros
 * (older tokens' symbol() and name()); undefined when neither
 */
export function decodeAbiString(result: string | null): string | undefined {
  if (!result) return undefined
  const hex = strip(result)
  const text = (bytes: Buffer) => {
    const value = bytes.toString('utf8').replace(/\0+$/, '').trim()
    // Control characters would mean it is not text
    return value && !hasControlChars(value) ? value : undefined
  }
  if (hex.length >= 128) {
    const offset = uintAt(hex, 0)
    const length =
      offset !== undefined && !(offset % 32n)
        ? uintAt(hex, Number(offset / 32n))
        : undefined
    if (length !== undefined && length <= 1024n) {
      const start = (Number(offset) + 32) * 2
      const body = hex.slice(start, start + Number(length) * 2)
      if (body.length === Number(length) * 2) {
        return text(Buffer.from(body, 'hex'))
      }
    }
  }
  if (hex.length === 64) return text(Buffer.from(hex, 'hex'))
  return undefined
}

/** Whether `text` holds control characters or undecodable bytes */
export function hasControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || char === '�') return true
  }
  return false
}

const ERROR_SELECTOR = selector('Error(string)')
const PANIC_SELECTOR = selector('Panic(uint256)')

/** The reason in revert data: Error(string) or Panic(code) */
export function decodeRevertData(data: unknown): string | undefined {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
    return undefined
  }
  const hex = strip(data)
  if (hex.startsWith(strip(ERROR_SELECTOR))) {
    return decodeAbiString('0x' + hex.slice(8))
  }
  if (hex.startsWith(strip(PANIC_SELECTOR))) {
    const code = uintAt(hex.slice(8), 0)
    return code === undefined ? undefined : `Panic(0x${code.toString(16)})`
  }
  return undefined
}
