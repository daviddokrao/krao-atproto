import {
  bip39Words,
  containsPrivateKey,
  containsSeedPhrase,
  findSecrets,
} from '../src/index.js'

// The BIP39 test vector phrase (never use it for funds)
const PHRASE_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PHRASE_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'
// Anvil's first public dev key
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('BIP39 wordlist', () => {
  it('has the 2048 English words', () => {
    const words = bip39Words()
    expect(words.size).toBe(2048)
    expect(words.has('abandon')).toBe(true)
    expect(words.has('zoo')).toBe(true)
  })
})

describe('containsSeedPhrase', () => {
  it('finds 12 and 24 word phrases', () => {
    expect(containsSeedPhrase(PHRASE_12)).toBe(true)
    expect(containsSeedPhrase(PHRASE_24)).toBe(true)
  })

  it('finds them inside other text, in any case', () => {
    expect(
      containsSeedPhrase(
        `Đây là ví của mình: ${PHRASE_12.toUpperCase()}. Giữ giùm nhé`,
      ),
    ).toBe(true)
  })

  it('finds numbered lists, one per line or on one line', () => {
    const words = PHRASE_12.split(' ')
    expect(
      containsSeedPhrase(words.map((w, i) => `${i + 1}. ${w}`).join('\n')),
    ).toBe(true)
    expect(
      containsSeedPhrase(words.map((w, i) => `${i + 1}) ${w}`).join(' ')),
    ).toBe(true)
  })

  it('needs 12 words in a row', () => {
    const eleven = PHRASE_12.split(' ').slice(0, 11).join(' ')
    expect(containsSeedPhrase(eleven)).toBe(false)
    // A word outside the list breaks the run
    const broken = PHRASE_12.split(' ')
    broken.splice(6, 0, 'krao')
    expect(containsSeedPhrase(broken.join(' '))).toBe(false)
  })

  it('leaves lists of things alone (commas, one per line)', () => {
    const groceries = [
      'apple',
      'banana',
      'bread',
      'butter',
      'cheese',
      'chicken',
      'coffee',
      'egg',
      'garlic',
      'lemon',
      'milk',
      'onion',
      'orange',
      'potato',
    ]
    expect(groceries.every((w) => bip39Words().has(w))).toBe(true)
    expect(containsSeedPhrase(`Đi chợ: ${groceries.join(', ')}`)).toBe(false)
    expect(containsSeedPhrase(groceries.join('\n'))).toBe(false)
  })

  it('leaves ordinary sentences alone', () => {
    expect(
      containsSeedPhrase(
        'I think the market will go up again after the holiday, what about you and your friends?',
      ),
    ).toBe(false)
    expect(
      containsSeedPhrase(
        'Gas trên Base hôm nay rẻ bất ngờ, phí chưa tới 0.01 USD',
      ),
    ).toBe(false)
  })
})

describe('containsPrivateKey', () => {
  it('finds a key labelled as one, with or without 0x', () => {
    expect(containsPrivateKey(`my key is ${KEY.toUpperCase()}!`)).toBe(true)
    expect(containsPrivateKey(`Private key: 0x${KEY}`)).toBe(true)
    expect(containsPrivateKey(`khóa riêng của mình ${KEY}`)).toBe(true)
  })

  it('finds a bare key sent on its own', () => {
    expect(containsPrivateKey(KEY)).toBe(true)
    expect(containsPrivateKey(`  ${KEY}\n`)).toBe(true)
  })

  it('leaves transaction ids and file hashes alone', () => {
    // EVM transaction hashes are written with 0x
    expect(containsPrivateKey(`0x${KEY}`)).toBe(false)
    expect(containsPrivateKey(`Sent, tx 0x${KEY}`)).toBe(false)
    // Bitcoin and Tron transaction ids, sha256 sums: no 0x
    expect(containsPrivateKey(`txid: ${KEY}`)).toBe(false)
    expect(containsPrivateKey(`Mã giao dịch ${KEY} nhé`)).toBe(false)
    expect(containsPrivateKey(`sha256 hash ${KEY}`)).toBe(false)
    expect(containsPrivateKey(`đã chuyển rồi, ${KEY} kiểm tra giúp`)).toBe(
      false,
    )
    // Inside a URL, even after a key-like word
    expect(
      containsPrivateKey(`key https://tronscan.org/#/transaction/${KEY}`),
    ).toBe(false)
    expect(containsPrivateKey(`https://mempool.space/tx/${KEY}`)).toBe(false)
  })

  it('leaves shorter or longer hex and numbers alone', () => {
    expect(containsPrivateKey(`key ${KEY.slice(1)}`)).toBe(false)
    expect(containsPrivateKey(`key ${KEY}a`)).toBe(false)
    expect(containsPrivateKey('1'.repeat(64))).toBe(false)
    expect(
      containsPrivateKey('key 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    ).toBe(false)
  })
})

describe('findSecrets', () => {
  it('names what it found', () => {
    expect(findSecrets(`${PHRASE_12}\nprivate key: ${KEY}`)).toEqual([
      'seedPhrase',
      'privateKey',
    ])
    expect(findSecrets('gm')).toEqual([])
  })
})
