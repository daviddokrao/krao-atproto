import { domainToASCII } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Database, createDb, migrateDb } from './db.js'
import { setPostTags, trendingTags } from './discovery.js'
import { rankPopularPosts } from './feed.js'
import {
  DomainMatcher,
  SafetyList,
  domainSuffixes,
  normalizeHost,
  parsePhishingConfig,
  postLinkHosts,
  setPostLinks,
  withinDistance,
} from './safety.js'

// metamask.io with a Cyrillic "е", and its punycode form
const FAKE_METAMASK = 'mеtamask.io'
const FAKE_METAMASK_ASCII = domainToASCII(FAKE_METAMASK)

const list = (
  blocked: string[],
  allowed: string[] = [],
  fuzzy: string[] = [],
  tolerance = 0,
) =>
  new DomainMatcher(
    [new Map(blocked.map((d) => [d, { source: 'list', reason: 'Phishing' }]))],
    new Set(allowed),
    fuzzy,
    tolerance,
  )

describe('normalizeHost', () => {
  it('takes the host of URLs and bare names, lowercase', () => {
    expect(normalizeHost('https://App.Evil.COM/claim?x=1')).toBe('app.evil.com')
    expect(normalizeHost('evil.com/path')).toBe('evil.com')
    expect(normalizeHost('evil.com.')).toBe('evil.com')
    expect(normalizeHost('ipfs://bafy.evil.com/x')).toBe('bafy.evil.com')
    expect(normalizeHost('https://user:pw@evil.com:8443/')).toBe('evil.com')
  })

  it('converts internationalized names to punycode', () => {
    expect(FAKE_METAMASK_ASCII).toMatch(/^xn--/)
    expect(normalizeHost(`https://${FAKE_METAMASK}`)).toBe(FAKE_METAMASK_ASCII)
    expect(normalizeHost(FAKE_METAMASK_ASCII)).toBe(FAKE_METAMASK_ASCII)
  })

  it('refuses things that are not hosts', () => {
    expect(normalizeHost('')).toBeNull()
    expect(normalizeHost('localhost')).toBeNull()
    expect(normalizeHost('not a url at all')).toBeNull()
  })
})

describe('DomainMatcher', () => {
  it('matches a listed domain and its subdomains, not lookalike parents', () => {
    const matcher = list(['evil.com'])
    expect(matcher.check('evil.com')).toMatchObject({
      unsafe: true,
      domain: 'evil.com',
    })
    expect(matcher.check('a.b.evil.com')).toMatchObject({
      unsafe: true,
      domain: 'evil.com',
    })
    expect(matcher.check('notevil.com').unsafe).toBe(false)
    expect(matcher.check('evil.com.example.org').unsafe).toBe(false)
  })

  it('matches punycode entries against internationalized links', () => {
    const matcher = list([FAKE_METAMASK_ASCII])
    expect(
      matcher.check(normalizeHost(`https://${FAKE_METAMASK}/`)!).unsafe,
    ).toBe(true)
    expect(matcher.check('metamask.io').unsafe).toBe(false)
  })

  it('lets the whitelist win over list entries, but not over admins', () => {
    const matcher = list(['github.io'], ['safe.github.io'])
    expect(matcher.check('safe.github.io').unsafe).toBe(false)
    expect(matcher.check('docs.safe.github.io').unsafe).toBe(false)
    expect(matcher.check('other.github.io').unsafe).toBe(true)

    const withAdmin = new DomainMatcher(
      [
        new Map([
          ['bad.safe.github.io', { source: 'admin', reason: 'Drainer' }],
        ]),
      ],
      new Set(['safe.github.io']),
    )
    expect(withAdmin.check('bad.safe.github.io')).toMatchObject({
      unsafe: true,
      reason: 'Drainer',
    })
  })

  it('flags close lookalikes of fuzzy list entries', () => {
    const matcher = list([], ['metamask.io'], ['metamask.io'], 1)
    expect(matcher.check('metamsk.io')).toMatchObject({
      unsafe: true,
      reason: 'Looks like metamask.io',
    })
    expect(matcher.check('login.metamaks.io').unsafe).toBe(false)
    expect(matcher.check('metamask.io').unsafe).toBe(false)
    expect(matcher.check('app.metamask.io').unsafe).toBe(false)
  })

  it('lists suffixes down to two labels', () => {
    expect(domainSuffixes('a.b.evil.com')).toEqual([
      'a.b.evil.com',
      'b.evil.com',
      'evil.com',
    ])
    expect(domainSuffixes('1.2.3.4')).toEqual(['1.2.3.4'])
  })

  it('measures edit distance within a bound', () => {
    expect(withinDistance('metamask', 'metamsk', 1)).toBe(true)
    expect(withinDistance('metamask', 'metamaks', 1)).toBe(false)
    expect(withinDistance('metamask', 'metamaks', 2)).toBe(true)
  })
})

describe('parsePhishingConfig', () => {
  it('reads the eth-phishing-detect shape, normalized', () => {
    const config = parsePhishingConfig({
      version: 2,
      tolerance: 2,
      fuzzylist: ['MetaMask.io'],
      whitelist: ['metamask.io', 'not a domain'],
      blacklist: ['Evil.com', 'evil.com', FAKE_METAMASK, 42],
    })
    expect(config).toEqual({
      blacklist: ['evil.com', FAKE_METAMASK_ASCII],
      whitelist: ['metamask.io'],
      fuzzylist: ['metamask.io'],
      tolerance: 2,
    })
  })

  it('refuses other JSON', () => {
    expect(() => parsePhishingConfig({ domains: [] })).toThrow()
    expect(() => parsePhishingConfig(null)).toThrow()
  })
})

describe('postLinkHosts', () => {
  it('reads link facets, external embeds and URLs in the text', () => {
    expect(
      postLinkHosts({
        text: 'Claim at https://free-airdrop-claim.test/now and see docs',
        facets: [
          {
            features: [
              {
                $type: 'app.bsky.richtext.facet#link',
                uri: 'https://Drainer.test/x',
              },
            ],
          },
        ],
        embed: {
          $type: 'app.bsky.embed.recordWithMedia',
          media: { external: { uri: 'https://news.example.com/a' } },
        },
      }).sort(),
    ).toEqual(['drainer.test', 'free-airdrop-claim.test', 'news.example.com'])
  })
})

describe('SafetyList', () => {
  let db: Database
  let safety: SafetyList

  beforeEach(async () => {
    db = createDb(':memory:')
    await migrateDb(db)
    safety = new SafetyList(db)
    await safety.init()
  })

  afterEach(async () => {
    await safety.destroy()
    await db.destroy()
  })

  const post = async (uri: string, hosts: string[]) => {
    const at = new Date().toISOString()
    await db
      .insertInto('feed_post')
      .values({ uri, cid: uri, did: 'did:a', indexedAt: at, createdAt: at })
      .execute()
    await setPostTags(db, uri, 'did:a', ['airdrop'])
    await setPostLinks(db, uri, 'did:a', hosts, safety.matcher)
  }

  it('knows the seed domains', () => {
    expect(safety.check('https://drainer.test/connect').unsafe).toBe(true)
    expect(safety.check('https://sub.free-airdrop-claim.test').unsafe).toBe(
      true,
    )
    expect(safety.check('https://krao.net').unsafe).toBe(false)
  })

  it('keeps posts linking to unsafe domains out of Popular and trending', async () => {
    await post('at://a/p/bad', ['drainer.test'])
    await post('at://a/p/good', ['krao.net'])
    expect(await rankPopularPosts(db)).toEqual(['at://a/p/good'])
    const [tag] = await trendingTags(db, 10)
    expect(tag).toMatchObject({ tag: 'airdrop', postCount: 1 })
  })

  it('flags indexed posts again when admins change the list', async () => {
    await post('at://a/p/1', ['scam.example.com'])
    expect(await rankPopularPosts(db)).toEqual(['at://a/p/1'])

    const row = await safety.addDomain(
      'did:admin',
      'https://example.com/whatever',
      'Drainer kit',
    )
    expect(row).toMatchObject({ domain: 'example.com', source: 'admin' })
    expect(await rankPopularPosts(db)).toEqual([])

    expect(await safety.removeDomain('did:admin', 'example.com')).toBe(true)
    expect(await rankPopularPosts(db)).toEqual(['at://a/p/1'])
    // Seed and list entries cannot be removed
    expect(await safety.removeDomain('did:admin', 'drainer.test')).toBe(false)

    const log = await db
      .selectFrom('safety_audit_log')
      .select(['action', 'domain'])
      .orderBy('id')
      .execute()
    expect(log).toEqual([
      { action: 'domain.add', domain: 'example.com' },
      { action: 'domain.remove', domain: 'example.com' },
    ])
  })

  it('replaces the synced list and applies its whitelist', async () => {
    await safety.replaceList(
      parsePhishingConfig({
        blacklist: ['phish.example', 'old.example'],
        whitelist: [],
        fuzzylist: [],
      }),
    )
    expect(safety.check('a.phish.example').unsafe).toBe(true)
    await safety.replaceList(
      parsePhishingConfig({
        blacklist: ['phish.example'],
        whitelist: ['ok.phish.example'],
        fuzzylist: [],
      }),
    )
    expect(safety.check('old.example').unsafe).toBe(false)
    expect(safety.check('ok.phish.example').unsafe).toBe(false)
    expect(safety.check('a.phish.example').unsafe).toBe(true)
    // Seed entries survive a sync
    expect(safety.check('drainer.test').unsafe).toBe(true)
  })

  it('lists domains newest first, by source and text', async () => {
    await safety.addDomain('did:admin', 'one.example')
    await safety.addDomain('did:admin', 'two.example')
    const page = await safety.listDomains({ source: 'admin', limit: 1 })
    expect(page.domains.map((d) => d.domain)).toEqual(['two.example'])
    const next = await safety.listDomains({
      source: 'admin',
      limit: 1,
      cursor: page.cursor,
    })
    expect(next.domains.map((d) => d.domain)).toEqual(['one.example'])
    const found = await safety.listDomains({ query: 'airdrop', limit: 10 })
    expect(found.domains.map((d) => d.domain)).toEqual([
      'free-airdrop-claim.test',
    ])
  })
})
