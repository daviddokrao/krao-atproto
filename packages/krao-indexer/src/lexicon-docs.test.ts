import { describe, expect, it } from 'vitest'

/*
 * docs/krao/lexicons.md is generated from lexicons/net/krao by
 * scripts/krao-lexicon-docs.mjs; this keeps it (and the permission sets and
 * docs/krao/miniapps.md) in step with the lexicons.
 */
describe('Krao lexicon docs', () => {
  it('match the lexicons', async () => {
    const script = new URL(
      '../../../scripts/krao-lexicon-docs.mjs',
      import.meta.url,
    ).href
    const { check } = (await import(script)) as { check: () => string[] }
    expect(check()).toEqual([])
  })
})
