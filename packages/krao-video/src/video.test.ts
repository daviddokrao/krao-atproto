import { describe, expect, it } from 'vitest'
import { type ProbeResult, renditionsFor } from './ffmpeg.js'
import { tokenExpiry } from './jobs.js'
import { DEFAULT_LIMITS, Quotas } from './uploads.js'

const probe = (width: number, height: number): ProbeResult => ({
  durationSec: 10,
  width,
  height,
  videoCodec: 'h264',
  audioCodec: 'aac',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
})

describe('renditionsFor', () => {
  it('encodes every ladder step the source can fill', () => {
    expect(renditionsFor(probe(1920, 1080)).map((r) => r.name)).toEqual([
      '360p',
      '720p',
    ])
    expect(renditionsFor(probe(640, 360)).map((r) => r.name)).toEqual(['360p'])
  })

  it('uses the short side, so portrait videos are not upscaled', () => {
    expect(renditionsFor(probe(720, 1280)).map((r) => r.name)).toEqual([
      '360p',
      '720p',
    ])
  })

  it('keeps a small source at its own even size', () => {
    const [only] = renditionsFor(probe(320, 241))
    expect(only.size).toBe(240)
  })
})

describe('tokenExpiry', () => {
  const jwt = (payload: unknown) =>
    [
      Buffer.from('{"alg":"ES256K"}').toString('base64url'),
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'sig',
    ].join('.')

  it('reads the exp claim in ms', () => {
    expect(tokenExpiry(jwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000)
  })

  it('is undefined for tokens it cannot read', () => {
    expect(tokenExpiry('not-a-jwt')).toBeUndefined()
    expect(tokenExpiry(jwt({ iss: 'did:plc:x' }))).toBeUndefined()
  })
})

describe('Quotas', () => {
  const limits = { ...DEFAULT_LIMITS, dailyVideos: 2, dailyBytes: 100 }

  it('counts videos and bytes per account', () => {
    const quotas = new Quotas(limits)
    quotas.reserve('did:plc:a', 60)
    expect(quotas.remaining('did:plc:a')).toEqual({ videos: 1, bytes: 40 })
    expect(quotas.remaining('did:plc:b')).toEqual({ videos: 2, bytes: 100 })
  })

  it('refuses a video over the remaining allowance', () => {
    const quotas = new Quotas(limits)
    quotas.reserve('did:plc:a', 60)
    expect(() => quotas.reserve('did:plc:a', 50)).toThrow(/allowance/)
    quotas.reserve('did:plc:a', 40)
    expect(() => quotas.reserve('did:plc:a', 0)).toThrow(/daily video/)
  })

  it('gives the allowance back when a video fails', () => {
    const quotas = new Quotas(limits)
    quotas.reserve('did:plc:a', 60)
    quotas.release('did:plc:a', 60)
    expect(quotas.remaining('did:plc:a')).toEqual({ videos: 2, bytes: 100 })
  })
})
