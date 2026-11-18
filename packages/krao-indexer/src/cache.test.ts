import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedValue } from './cache.js'

describe('cachedValue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses the value until the ttl has passed', async () => {
    vi.useFakeTimers()
    let calls = 0
    const get = cachedValue(1000, async () => ++calls)
    expect(await get()).toBe(1)
    expect(await get()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(await get()).toBe(2)
  })

  it('shares one computation between concurrent callers', async () => {
    let calls = 0
    const get = cachedValue(1000, async () => ++calls)
    expect(await Promise.all([get(), get(), get()])).toEqual([1, 1, 1])
  })

  it('does not remember a failure', async () => {
    let calls = 0
    const get = cachedValue(1000, async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return calls
    })
    await expect(get()).rejects.toThrow('boom')
    expect(await get()).toBe(2)
  })

  it('computes every time with a ttl of 0', async () => {
    let calls = 0
    const get = cachedValue(0, async () => ++calls)
    await get()
    expect(await get()).toBe(2)
  })
})
