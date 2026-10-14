/**
 * Remembers the result of an expensive computation for `ttlMs`. Concurrent
 * callers share one computation; a failed one is not remembered. A ttl of 0
 * turns caching off (tests and the dev-env, which check results right away).
 */
export function cachedValue<T>(ttlMs: number, compute: () => Promise<T>) {
  let value: { at: number; result: Promise<T> } | undefined
  return () => {
    if (ttlMs <= 0) return compute()
    const now = Date.now()
    if (!value || now - value.at >= ttlMs) {
      const result = compute()
      value = { at: now, result }
      result.catch(() => {
        if (value?.result === result) value = undefined
      })
    }
    return value.result
  }
}
