import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRAND,
  brandDid,
  brandHost,
  brandUrl,
  parseBrand,
  webUrl,
} from './index.js'

const raw = JSON.parse(
  readFileSync(new URL('../brand.json', import.meta.url), 'utf8'),
)

describe('@krao/brand', () => {
  it('reads brand.json', () => {
    expect(BRAND).toEqual(raw)
    expect(Object.isFrozen(BRAND)).toBe(true)
  })

  it('derives hosts, URLs and DIDs from the domain', () => {
    const host = `${raw.hosts.api}.${raw.domain}`
    expect(brandHost('api')).toBe(host)
    expect(brandUrl('api')).toBe(`https://${host}`)
    expect(brandDid('api')).toBe(`did:web:${host}`)
    expect(brandHost('indexer')).toBe(`${raw.hosts.indexer}.${raw.domain}`)
  })

  it('builds web URLs', () => {
    expect(webUrl()).toBe(`https://${raw.domain}`)
    expect(webUrl('/terms')).toBe(`https://${raw.domain}/terms`)
    expect(webUrl('terms')).toBe(`https://${raw.domain}/terms`)
  })

  it('refuses a brand.json without its required fields', () => {
    expect(() => parseBrand('{"name":"X"}')).toThrow(/domain/)
    expect(() =>
      parseBrand('{"name":"X","domain":"x.io","nsid":"io.x"}'),
    ).toThrow(/hosts/)
  })
})
