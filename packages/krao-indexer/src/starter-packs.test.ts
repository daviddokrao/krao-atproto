import { describe, expect, it } from 'vitest'
import { shortLinkTarget } from './starter-packs.js'

const WEB = 'https://krao.net'

describe('shortLinkTarget', () => {
  it('leads to paths on the web app', () => {
    expect(shortLinkTarget('/starter-pack/alice/abc', WEB)).toBe(
      'https://krao.net/starter-pack/alice/abc',
    )
    expect(shortLinkTarget('/profile/alice?tab=media', WEB)).toBe(
      'https://krao.net/profile/alice?tab=media',
    )
  })

  it('never leads to another site', () => {
    for (const path of [
      '//evil.com',
      '/\\evil.com',
      '/\\/evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      'https://evil.com/',
      'evil.com',
    ]) {
      expect(shortLinkTarget(path, WEB)).toBeNull()
    }
  })

  it('refuses anything that is not a short path', () => {
    expect(shortLinkTarget(undefined, WEB)).toBeNull()
    expect(shortLinkTarget('/' + 'a'.repeat(600), WEB)).toBeNull()
  })
})
