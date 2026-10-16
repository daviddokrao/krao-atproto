/*
 * The words of each push, in English or Vietnamese. The app tells the push
 * service each account's language (net.krao.push.setLanguage, through the
 * rewards service); without one, pushes are in English.
 */

export type Lang = 'en' | 'vi'

/** The push language for a language tag: Vietnamese for vi*, else English */
export function langOf(tag: string | null | undefined): Lang {
  return tag?.trim().toLowerCase().startsWith('vi') ? 'vi' : 'en'
}

/** Longest post excerpt in a push */
const EXCERPT_CHARS = 140

export type Profile = { did: string; handle: string; displayName?: string }

/** How a person is named in a push */
export const nameOf = (p: Profile | undefined, lang: Lang = 'en') =>
  p?.displayName?.trim() ||
  (p?.handle ? `@${p.handle}` : lang === 'vi' ? 'Ai đó' : 'Someone')

export function excerpt(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= EXCERPT_CHARS) return t
  // Cut on a code point boundary
  return `${Array.from(t).slice(0, EXCERPT_CHARS).join('').trimEnd()}…`
}

const SOCIAL_TITLES: Record<
  string,
  Record<Lang, (author: string) => string>
> = {
  like: {
    en: (a) => `${a} liked your post`,
    vi: (a) => `${a} đã thích bài của bạn`,
  },
  'like-via-repost': {
    en: (a) => `${a} liked your repost`,
    vi: (a) => `${a} đã thích bài bạn đăng lại`,
  },
  repost: {
    en: (a) => `${a} reposted your post`,
    vi: (a) => `${a} đã đăng lại bài của bạn`,
  },
  'repost-via-repost': {
    en: (a) => `${a} reposted your repost`,
    vi: (a) => `${a} đã đăng lại bài bạn đăng lại`,
  },
  follow: {
    en: (a) => `${a} followed you`,
    vi: (a) => `${a} đã theo dõi bạn`,
  },
  'follow-back': {
    en: (a) => `${a} followed you back`,
    vi: (a) => `${a} đã theo dõi lại bạn`,
  },
  reply: {
    en: (a) => `${a} replied to you`,
    vi: (a) => `${a} đã trả lời bạn`,
  },
  mention: {
    en: (a) => `${a} mentioned you`,
    vi: (a) => `${a} đã nhắc đến bạn`,
  },
  quote: {
    en: (a) => `${a} quoted your post`,
    vi: (a) => `${a} đã trích dẫn bài của bạn`,
  },
  'starterpack-joined': {
    en: (a) => `${a} signed up with your starter pack`,
    vi: (a) => `${a} đã đăng ký qua gói khởi đầu của bạn`,
  },
  'subscribed-post': {
    en: (a) => `${a} posted`,
    vi: (a) => `${a} đã đăng bài`,
  },
  verified: {
    en: () => 'Your account was verified',
    vi: () => 'Tài khoản của bạn đã được xác minh',
  },
  unverified: {
    en: () => 'Your account is no longer verified',
    vi: () => 'Tài khoản của bạn không còn được xác minh',
  },
}

/** Title for an AppView notification, or null for reasons we do not push */
export function socialTitle(
  reason: string,
  author: string,
  lang: Lang = 'en',
): string | null {
  return SOCIAL_TITLES[reason]?.[lang](author) ?? null
}

/** The words of the pushes for Krao's own events */
export const kraoText = {
  chatTitle: (lang: Lang, name: string, groupName?: string) =>
    groupName
      ? lang === 'vi'
        ? `${name} trong ${groupName}`
        : `${name} in ${groupName}`
      : name,
  chatReaction: (lang: Lang, reaction: string) =>
    lang === 'vi'
      ? `Đã bày tỏ cảm xúc ${reaction} với tin nhắn của bạn`
      : `Reacted ${reaction} to your message`,
  chatMessage: (lang: Lang) =>
    lang === 'vi' ? 'Đã gửi một tin nhắn' : 'Sent a message',
  tipTitle: (lang: Lang, name: string) =>
    lang === 'vi' ? `${name} đã gửi bạn tiền tip` : `${name} sent you a tip`,
  pointsTitle: (lang: Lang) =>
    lang === 'vi' ? 'Điểm của bạn đã được duyệt' : 'Your points were approved',
  pointsBody: (lang: Lang, points: number) =>
    lang === 'vi' ? `+${points} điểm` : `+${points} points`,
  kycTitle: (lang: Lang, approved: boolean) =>
    approved
      ? lang === 'vi'
        ? 'Danh tính của bạn đã được xác minh'
        : 'Your identity is verified'
      : lang === 'vi'
        ? 'Xác minh danh tính chưa được chấp nhận'
        : 'Identity verification was not approved',
  kycBody: (lang: Lang, approved: boolean) =>
    approved
      ? lang === 'vi'
        ? 'Điểm giới thiệu đang chờ của bạn giờ đã có thể được duyệt.'
        : 'Pending referral points can now be approved.'
      : lang === 'vi'
        ? 'Mở Krao để xem cần làm gì tiếp theo.'
        : 'Open Krao to see what to do next.',
}

/** Reasons whose push shows the post they are about (the subject) */
export const SHOWS_SUBJECT = new Set([
  'like',
  'like-via-repost',
  'repost',
  'repost-via-repost',
])
/** Reasons whose push shows the new post itself */
export const SHOWS_RECORD = new Set([
  'reply',
  'mention',
  'quote',
  'subscribed-post',
])

/** Notification preference key for a reason, see app.bsky.notification.defs */
export const PREFERENCE_KEY: Record<string, string> = {
  like: 'like',
  'like-via-repost': 'likeViaRepost',
  repost: 'repost',
  'repost-via-repost': 'repostViaRepost',
  follow: 'follow',
  'follow-back': 'follow',
  reply: 'reply',
  mention: 'mention',
  quote: 'quote',
  'starterpack-joined': 'starterpackJoined',
  'subscribed-post': 'subscribedPost',
  verified: 'verified',
  unverified: 'unverified',
}
