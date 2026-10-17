/*
 * Lookalike names (M35, impersonation checks). Names are compared after
 * normalizing what makes two names look alike to a reader:
 *   NFKC (fullwidth and styled letters) → lower case → no diacritics (đ → d)
 *   → homoglyphs (Cyrillic, Greek and digits that look like Latin letters,
 *   "rn" → "m", "vv" → "w") → letters and digits only (no spaces,
 *   punctuation or emoji).
 * Two names match when they normalize to the same string of at least 4
 * characters, or, from 8 characters, are one edit apart.
 */

/** Characters that look like a Latin letter, by that letter */
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic
  а: 'a',
  в: 'b',
  с: 'c',
  ԁ: 'd',
  е: 'e',
  ё: 'e',
  һ: 'h',
  н: 'h',
  і: 'i',
  ї: 'i',
  ј: 'j',
  к: 'k',
  ӏ: 'i',
  м: 'm',
  о: 'o',
  р: 'p',
  ԛ: 'q',
  г: 'r',
  ѕ: 's',
  т: 't',
  υ: 'u',
  ц: 'u',
  ѵ: 'v',
  ԝ: 'w',
  ш: 'w',
  х: 'x',
  у: 'y',
  ү: 'y',
  з: 'e',
  п: 'n',
  ь: 'b',
  // Greek
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  χ: 'x',
  γ: 'y',
  ω: 'w',
  // Latin lookalikes
  ı: 'i',
  ȷ: 'j',
  ł: 'l',
  ø: 'o',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  // Digits and symbols that read as letters
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '|': 'i',
}

/**
 * Capitals that look like a Latin capital whose small letter does not look
 * like the Latin small letter (Greek Ν lowercases to ν, read as `v` above):
 * read before lowercasing
 */
const CAPITAL_HOMOGLYPHS: Record<string, string> = {
  // Greek
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Ζ: 'z',
  Η: 'h',
  Ι: 'i',
  Κ: 'k',
  Μ: 'm',
  Ν: 'n',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Υ: 'y',
  Χ: 'x',
}

/** Letter pairs that read as one letter, applied after the table above */
const PAIRS: [RegExp, string][] = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
]

/** A name as it reads: see the top of this file */
export function normalizeName(name: string): string {
  let s = ''
  for (const ch of name.normalize('NFKC')) s += CAPITAL_HOMOGLYPHS[ch] ?? ch
  s = s.toLowerCase()
  // Diacritics: decompose, drop the marks; đ has no decomposition
  s = s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd')
  let mapped = ''
  for (const ch of s) mapped += HOMOGLYPHS[ch] ?? ch
  // `l` and `i` look alike in many fonts (and `1` maps to `i` above)
  mapped = mapped.replace(/l/g, 'i')
  // Letters and digits only: spaces, punctuation, symbols and emoji go
  mapped = mapped.replace(/[^\p{L}\p{N}]/gu, '')
  for (const [pattern, letter] of PAIRS)
    mapped = mapped.replace(pattern, letter)
  return mapped
}

/** The first label of a handle, normalized ("ngan-hang.krao.net" → "nganhang") */
export function handleKey(handle: string | null | undefined): string {
  if (!handle) return ''
  return normalizeName(handle.split('.')[0] ?? '')
}

/** Edit distance, stopping early once it exceeds `max` */
export function levenshtein(a: string, b: string, max = Infinity): number {
  const x = [...a]
  const y = [...b]
  if (Math.abs(x.length - y.length) > max) return max + 1
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      row.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[y.length]
}

/** Shortest normalized name that can match at all */
export const MIN_NAME_LENGTH = 4
/** From this length, names one edit apart match too */
export const FUZZY_NAME_LENGTH = 8

/** Whether two normalized names look alike (see the top of this file) */
export function namesMatch(a: string, b: string): boolean {
  if (a.length < MIN_NAME_LENGTH || b.length < MIN_NAME_LENGTH) return false
  if (a === b) return true
  if (Math.min(a.length, b.length) < FUZZY_NAME_LENGTH) return false
  return levenshtein(a, b, 1) <= 1
}
