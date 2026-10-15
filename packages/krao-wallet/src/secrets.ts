import { BIP39_ENGLISH } from './bip39-english.js'

/*
 * Spotting wallet secrets in text people are about to send: a seed phrase
 * (12 or more BIP39 words in a row) or a raw private key (64 hex characters).
 * Nobody legitimate ever asks for these, so the chat service refuses them and
 * the app warns before they are posted. The Krao app keeps a copy of this
 * logic (and the wordlist): keep the two in step.
 */

/** Fewest BIP39 words in a row that count as a seed phrase */
export const SEED_PHRASE_MIN_WORDS = 12

export type SecretKind = 'seedPhrase' | 'privateKey'

let wordSet: Set<string> | undefined

/** The BIP39 English words, for lookups */
export function bip39Words(): Set<string> {
  wordSet ??= new Set(BIP39_ENGLISH.trim().split(/\s+/))
  return wordSet
}

/**
 * Whether `text` holds SEED_PHRASE_MIN_WORDS or more BIP39 words in a row.
 * Numbers between words (a numbered list: "1. abandon 2. ability") and any
 * punctuation are skipped; any other word breaks the run.
 */
export function containsSeedPhrase(text: string): boolean {
  const words = bip39Words()
  let run = 0
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!token || /^\d+$/.test(token)) continue
    run = words.has(token) ? run + 1 : 0
    if (run >= SEED_PHRASE_MIN_WORDS) return true
  }
  return false
}

/*
 * 64 hex characters standing alone, with at least one letter (so long
 * numbers do not count). With a 0x prefix they are left alone: that is how
 * transaction and block hashes are written, which people share all the time,
 * while wallets export private keys without it.
 */
const PRIVATE_KEY_RE = /(?<![0-9a-z])(?=[0-9]*[a-f])[0-9a-f]{64}(?![0-9a-z])/i

/** Whether `text` holds what looks like a raw private key */
export function containsPrivateKey(text: string): boolean {
  return PRIVATE_KEY_RE.test(text)
}

/** The kinds of wallet secrets found in `text` */
export function findSecrets(text: string): SecretKind[] {
  const found: SecretKind[] = []
  if (containsSeedPhrase(text)) found.push('seedPhrase')
  if (containsPrivateKey(text)) found.push('privateKey')
  return found
}
