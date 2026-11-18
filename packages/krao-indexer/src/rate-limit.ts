import type express from 'express'
import { XRPCError } from '@atproto/xrpc-server'

/**
 * A small fixed-window limit per client IP for public routes that fetch from
 * the internet or the chain. Kept in memory: each indexer instance counts on
 * its own.
 */
export function rateLimit(perMinute: number): express.RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (req, res, next) => {
    const key = req.ip ?? 'unknown'
    const at = Date.now()
    const hit = hits.get(key)
    if (!hit || hit.resetAt <= at) {
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= at) hits.delete(k)
      }
      hits.set(key, { count: 1, resetAt: at + 60_000 })
      return next()
    }
    hit.count++
    if (hit.count <= perMinute) return next()
    res.setHeader('retry-after', Math.ceil((hit.resetAt - at) / 1000))
    res.status(429).json({
      error: 'RateLimitExceeded',
      message: 'Too many requests, try again in a minute',
    })
  }
}

/**
 * A fixed-window limit per key (eg an account DID) for XRPC handlers; throws
 * RateLimitExceeded once the key used up `limit` calls in `windowMs`.
 */
export function keyedLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (key: string) => {
    const at = Date.now()
    const hit = hits.get(key)
    if (!hit || hit.resetAt <= at) {
      if (hits.size > 50_000) {
        for (const [k, v] of hits) if (v.resetAt <= at) hits.delete(k)
      }
      hits.set(key, { count: 1, resetAt: at + windowMs })
      return
    }
    hit.count++
    if (hit.count > limit) {
      throw new XRPCError(
        429,
        'Too many requests, try again in a minute',
        'RateLimitExceeded',
      )
    }
  }
}
