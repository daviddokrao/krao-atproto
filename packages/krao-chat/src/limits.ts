import { XRPCError } from '@atproto/xrpc-server'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/**
 * Per-account limits on what reaches other people, against spam. Kept in
 * memory (one chat instance), counted in fixed windows.
 */
const LIMITS: Record<string, { limit: number; windowMs: number }> = {
  'chat.bsky.convo.sendMessage': { limit: 30, windowMs: MINUTE },
  'chat.bsky.convo.sendMessageBatch': { limit: 3, windowMs: MINUTE },
  'chat.bsky.convo.addReaction': { limit: 60, windowMs: MINUTE },
  'chat.bsky.group.createGroup': { limit: 10, windowMs: DAY },
  'chat.bsky.group.createJoinLink': { limit: 20, windowMs: DAY },
  'chat.bsky.group.requestJoin': { limit: 30, windowMs: DAY },
  'chat.bsky.group.addMembers': { limit: 100, windowMs: DAY },
}

/** New direct convos an account may start per day */
export const NEW_CONVOS_PER_DAY = 30

export class ChatLimits {
  private hits = new Map<string, { count: number; resetAt: number }>()

  /** Throws RateLimitExceeded once `did` used up its allowance for `key` */
  take(did: string, key: string, limit?: number, windowMs?: number) {
    const rule = LIMITS[key]
    const max = limit ?? rule?.limit
    const window = windowMs ?? rule?.windowMs
    if (max === undefined || window === undefined) return
    const at = Date.now()
    const id = `${key} ${did}`
    const hit = this.hits.get(id)
    if (!hit || hit.resetAt <= at) {
      if (this.hits.size > 50_000) {
        for (const [k, v] of this.hits) if (v.resetAt <= at) this.hits.delete(k)
      }
      this.hits.set(id, { count: 1, resetAt: at + window })
      return
    }
    hit.count++
    if (hit.count > max) {
      throw new XRPCError(
        429,
        'Too many requests, please slow down',
        'RateLimitExceeded',
      )
    }
  }
}

export { DAY }
