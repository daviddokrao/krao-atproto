import { describe, expect, it } from 'vitest'
import { isVietnamesePost, isVietnameseText } from './language.js'

describe('isVietnameseText', () => {
  it('recognizes Vietnamese by its diacritics', () => {
    for (const text of [
      'Hôm nay trời đẹp quá, đi uống cà phê không?',
      'Thị trường tiền ảo tuần này biến động mạnh',
      'Chúc mừng năm mới!',
      'Đẹp',
      // Decomposed (NFD) input counts the same
      'Xin chào các bạn'.normalize('NFD'),
    ]) {
      expect(isVietnameseText(text), text).toBe(true)
    }
  })

  it('leaves out English, other Latin languages and Vietnamese names in English', () => {
    for (const text of [
      'Good morning everyone, the market looks calm today',
      'Ça va très bien, merci à toi',
      'Não está fácil hoje, mas vamos lá',
      'El niño está aquí',
      'Had lunch with Nguyễn Văn An and the whole team at the office today',
      'I love phở and bánh mì',
      '',
      '🚀🚀🚀 1000x',
    ]) {
      expect(isVietnameseText(text), text).toBe(false)
    }
  })

  it('ignores links, mentions, hashtags and cashtags', () => {
    expect(isVietnameseText('gm #TiếngViệt #ĐàNẵng @người.test $ETH')).toBe(
      false,
    )
    expect(
      isVietnameseText('Đọc bài này nhé https://example.com/tiếng-việt'),
    ).toBe(true)
  })

  it('does not detect Vietnamese typed without diacritics', () => {
    expect(isVietnameseText('hom nay troi dep qua')).toBe(false)
  })
})

describe('isVietnamesePost', () => {
  it('trusts langs first, then the text', () => {
    expect(isVietnamesePost({ text: 'gm', langs: ['vi'] })).toBe(true)
    expect(isVietnamesePost({ text: 'gm', langs: ['en', 'vi-VN'] })).toBe(true)
    expect(isVietnamesePost({ text: 'gm', langs: ['en'] })).toBe(false)
    expect(isVietnamesePost({ text: 'Chào buổi sáng', langs: ['en'] })).toBe(
      true,
    )
    expect(isVietnamesePost({ text: 'gm', langs: ['vie'] })).toBe(false)
    expect(isVietnamesePost(null)).toBe(false)
  })
})
