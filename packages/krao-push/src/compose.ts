/*
 * The words of each push. English for now: device tokens carry no language,
 * and Bluesky's courier sends English as well (see DECISIONS).
 */

/** Longest post excerpt in a push */
const EXCERPT_CHARS = 140

export type Profile = { did: string; handle: string; displayName?: string }

/** How a person is named in a push */
export const nameOf = (p: Profile | undefined) =>
  p?.displayName?.trim() || (p?.handle ? `@${p.handle}` : 'Someone')

export function excerpt(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= EXCERPT_CHARS) return t
  // Cut on a code point boundary
  return `${Array.from(t).slice(0, EXCERPT_CHARS).join('').trimEnd()}…`
}

/** Title for an AppView notification, or null for reasons we do not push */
export function socialTitle(reason: string, author: string): string | null {
  switch (reason) {
    case 'like':
      return `${author} liked your post`
    case 'like-via-repost':
      return `${author} liked your repost`
    case 'repost':
      return `${author} reposted your post`
    case 'repost-via-repost':
      return `${author} reposted your repost`
    case 'follow':
      return `${author} followed you`
    case 'follow-back':
      return `${author} followed you back`
    case 'reply':
      return `${author} replied to you`
    case 'mention':
      return `${author} mentioned you`
    case 'quote':
      return `${author} quoted your post`
    case 'starterpack-joined':
      return `${author} signed up with your starter pack`
    case 'subscribed-post':
      return `${author} posted`
    case 'verified':
      return 'Your account was verified'
    case 'unverified':
      return 'Your account is no longer verified'
    default:
      return null
  }
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
