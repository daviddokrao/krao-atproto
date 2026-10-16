/*
 * Vietnamese posts for the "Tiếng Việt" feed (M32): a post counts when its
 * `langs` include Vietnamese (`vi`, `vi-VN`...), or when its text looks
 * Vietnamese by its diacritics:
 *
 * - "strong" letters, which only Vietnamese uses among Latin alphabets: ă,
 *   đ, ơ, ư, ĩ, ũ, and the Latin Extended Additional block U+1EA0–U+1EF9
 *   (ạ, ả, ấ, ầ, ẩ, ẫ, ậ, ắ... ỳ, ỵ, ỷ, ỹ), which holds only Vietnamese
 *   letters;
 * - "marked" words: words with a strong letter or an accent Vietnamese
 *   shares with French, Spanish or Portuguese (à á â ã è é ê ì í ò ó ô õ ù
 *   ú ý). Most Vietnamese words carry one;
 * - the text is Vietnamese when at least 30% of its words are marked and it
 *   has at least two strong letters, or one strong letter and at least 60%
 *   of its words marked (short texts: "Xin chào các bạn").
 *
 * Links, @mentions, #hashtags and $cashtags are left out first. An English
 * post with a Vietnamese name ("lunch with Nguyễn Văn An") stays English;
 * Vietnamese typed without diacritics is not detected (set `langs`).
 */

/** Latin Extended Additional, U+1EA0 to U+1EF9: Vietnamese letters only */
const VI_BLOCK = `${String.fromCharCode(0x1ea0)}-${String.fromCharCode(0x1ef9)}`
const STRONG = new RegExp(`[ăđơưĩũ${VI_BLOCK}]`, 'gu')
const MARKED = new RegExp(`[àáâãèéêìíòóôõùúýăđơưĩũ${VI_BLOCK}]`, 'u')
const MIN_MARKED_SHARE = 0.3
/** With a single strong letter, most words must be marked */
const MIN_MARKED_SHARE_ONE_STRONG = 0.6

export function isVietnameseText(text: string): boolean {
  const cleaned = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, ' ')
    .replace(/[@#$＃][^\s]+/g, ' ')
  const words = cleaned.match(/\p{L}+/gu) ?? []
  if (!words.length) return false
  const strong = cleaned.match(STRONG)?.length ?? 0
  const share = words.filter((word) => MARKED.test(word)).length / words.length
  return (
    share >= MIN_MARKED_SHARE &&
    (strong >= 2 || (strong === 1 && share >= MIN_MARKED_SHARE_ONE_STRONG))
  )
}

/** Whether a post record is in Vietnamese: by its langs, else by its text */
export function isVietnamesePost(record: unknown): boolean {
  const value = (record ?? {}) as { langs?: unknown; text?: unknown }
  if (
    Array.isArray(value.langs) &&
    value.langs.some((l) => typeof l === 'string' && /^vi(?:-|$)/i.test(l))
  ) {
    return true
  }
  return typeof value.text === 'string' && isVietnameseText(value.text)
}
