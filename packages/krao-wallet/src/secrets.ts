import { BIP39_ENGLISH } from './bip39-english.js'

/*
 * Spotting wallet secrets in text people are about to send: a seed phrase
 * (12 or more BIP39 words in a row) or a raw private key (64 hex characters
 * that are labelled as a key, or sent on their own). Nobody legitimate ever
 * asks for these, so the chat service refuses them and the app warns before
 * they are posted. The Krao app keeps a copy of this logic (and the
 * wordlist): keep the two in step.
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

/*
 * What may stand between two words of a phrase: spaces, or a number as in a
 * numbered list ("1. abandon 2. ability", one per line too). Commas and bare
 * line breaks make a list of things (a shopping list), not a phrase.
 */
const PHRASE_GAP_RE = /^(?:[ \t ]+|\s*\d{1,2}\s*[.):-]?\s*)$/

/**
 * Whether `text` holds SEED_PHRASE_MIN_WORDS or more BIP39 words in a row,
 * separated by spaces or list numbers.
 */
export function containsSeedPhrase(text: string): boolean {
  const words = bip39Words()
  const lower = text.toLowerCase()
  let run = 0
  let lastEnd = -1
  for (const match of lower.matchAll(/\p{L}+/gu)) {
    const start = match.index ?? 0
    const joined =
      lastEnd >= 0 && PHRASE_GAP_RE.test(lower.slice(lastEnd, start))
    run = words.has(match[0]) ? (joined ? run + 1 : 1) : 0
    lastEnd = start + match[0].length
    if (run >= SEED_PHRASE_MIN_WORDS) return true
  }
  return false
}

/* 64 hex characters standing alone, maybe after 0x */
const HEX64_RE = /(?<![0-9a-z])(0x)?([0-9a-f]{64})(?![0-9a-z])/gi
/* Words before a hash that is not a key: transaction ids, file hashes */
const HASH_LABEL_RE = /tx|hash|transaction|giao d[iị]ch|m[aã] gd/iu
/* Words before a key */
const KEY_LABEL_RE = /key|priv|secret|kh(?:óa|oá|oa) ri[eê]ng/iu

/** Whether the 64 hex characters at [start, end) are part of a URL */
function inUrl(text: string, start: number, end: number): boolean {
  const from = text.slice(0, start).search(/\S*$/)
  const to = end + (text.slice(end).match(/^\S*/)?.[0].length ?? 0)
  const token = text.slice(from, to)
  return token.includes('/') || /^www\./i.test(token)
}

/**
 * Whether `text` holds what looks like a raw private key: 64 hex characters
 * (with at least one letter) labelled as a key ("private key:", "khóa
 * riêng"), or a bare one that is the whole message. Transaction ids and
 * file hashes look the same, so hex inside a URL, after a "tx"/"hash"
 * label, or unlabelled within other text is left alone.
 */
export function containsPrivateKey(text: string): boolean {
  for (const match of text.matchAll(HEX64_RE)) {
    const [whole, prefix, hex] = match
    if (!/[a-f]/i.test(hex)) continue
    const start = match.index ?? 0
    if (inUrl(text, start, start + whole.length)) continue
    const before = text.slice(Math.max(0, start - 24), start)
    if (HASH_LABEL_RE.test(before.slice(-16))) continue
    if (KEY_LABEL_RE.test(before)) return true
    if (!prefix && text.trim() === whole) return true
  }
  return false
}

/** The kinds of wallet secrets found in `text` */
export function findSecrets(text: string): SecretKind[] {
  const found: SecretKind[] = []
  if (containsSeedPhrase(text)) found.push('seedPhrase')
  if (containsPrivateKey(text)) found.push('privateKey')
  return found
}
