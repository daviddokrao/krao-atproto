import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { dHash, hammingDistance, similarAvatars } from './avatar-hash.js'
import {
  handleKey,
  levenshtein,
  namesMatch,
  normalizeName,
} from './lookalike.js'

describe('normalizeName', () => {
  it('drops Vietnamese diacritics, case, spaces and punctuation', () => {
    expect(normalizeName('Ngân Hàng Krao')).toBe('nganhangkrao')
    expect(normalizeName('ĐỒNG ĐÔ-LA, Krao!')).toBe('dongdoiakrao')
    expect(normalizeName('  ngan.hang_krao 🏦 ')).toBe('nganhangkrao')
  })

  it('reads Cyrillic and Greek lookalikes as Latin', () => {
    // К (Cyrillic Ka), а (Cyrillic a), о (Cyrillic o)
    expect(normalizeName('Ngân Hàng Кrао')).toBe('nganhangkrao')
    // Greek omicron and alpha
    expect(normalizeName('Krοα')).toBe('kroa')
    expect(normalizeName('Віnance')).toBe('binance')
  })

  it('reads fullwidth letters and look-alike digits', () => {
    expect(normalizeName('ＫＲＡＯ')).toBe('krao')
    expect(normalizeName('Kra0 0ffic1al')).toBe(normalizeName('Krao Official'))
    expect(normalizeName('VietcornBank')).toBe(normalizeName('Vietcombank'))
    expect(normalizeName('Pay Pal')).toBe(normalizeName('PayPaI'))
  })

  it('keeps other scripts', () => {
    expect(normalizeName('東京 銀行')).toBe('東京銀行')
  })
})

describe('namesMatch', () => {
  it('matches equal names of 4 characters or more', () => {
    expect(namesMatch('krao', 'krao')).toBe(true)
    expect(namesMatch('kra', 'kra')).toBe(false)
    expect(namesMatch('', '')).toBe(false)
  })

  it('takes one edit from 8 characters', () => {
    expect(namesMatch('nganhangkrao', 'nganhangkra0')).toBe(true)
    expect(namesMatch('nganhangkrao', 'nganhangkraoo')).toBe(true)
    expect(namesMatch('nganhangkrao', 'nganhangkr')).toBe(false)
    expect(namesMatch('kraotest', 'kraotext')).toBe(true)
    expect(namesMatch('kraotes', 'kraotex')).toBe(false)
  })

  it('counts edits by code point and stops early', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('kitten', 'sitting', 1)).toBe(2)
    expect(levenshtein('東京', '東都')).toBe(1)
  })

  it('compares handles by their first label', () => {
    expect(handleKey('ngan-hang-krao.krao.net')).toBe('nganhangkrao')
    expect(handleKey(null)).toBe('')
  })
})

describe('avatar hashes', () => {
  const picture = (shift = 0, noise = 0) => {
    const width = 64
    const data = Buffer.alloc(width * width * 3)
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3
        // Darker to the right, with a dark disc
        const disc = (x - 32 - shift) ** 2 + (y - 24) ** 2 < 200
        const v = disc
          ? 20
          : Math.max(0, 255 - x * 3 - y + noise * ((x * y) % 7))
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
      }
    }
    return sharp(data, { raw: { width, height: width, channels: 3 } })
  }

  it('finds the same picture again after re-encoding and resizing', async () => {
    const png = await picture().png().toBuffer()
    const jpeg = await picture()
      .resize(200, 200)
      .jpeg({ quality: 60 })
      .toBuffer()
    const a = await dHash(png)
    const b = await dHash(jpeg)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(10)
    expect(similarAvatars(a, b)).toBe(true)
  })

  it('tells different pictures apart', async () => {
    const a = await dHash(await picture().png().toBuffer())
    const other = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#808080' },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 32, height: 64, channels: 3, background: '#fff' },
          })
            .png()
            .toBuffer(),
          left: 32,
          top: 0,
        },
      ])
      .png()
      .toBuffer()
    // Brightness that falls from left to right instead
    const flipped = await picture().flop().png().toBuffer()
    expect(similarAvatars(a, await dHash(flipped))).toBe(false)
    expect(hammingDistance(a, await dHash(other))).toBeGreaterThan(10)
    expect(similarAvatars(a, null)).toBe(false)
  })

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64)
    expect(hammingDistance('00000000000000f0', '0000000000000000')).toBe(4)
  })
})
