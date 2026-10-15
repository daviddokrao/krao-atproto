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

  it('finds them inside other text, any case and punctuation', () => {
    expect(
      containsSeedPhrase(
        `Đây là ví của mình: ${PHRASE_12.toUpperCase().replace(/ /g, ', ')}. Giữ giùm nhé`,
      ),
    ).toBe(true)
  })

  it('finds numbered lists', () => {
    const numbered = PHRASE_12.split(' ')
      .map((w, i) => `${i + 1}. ${w}`)
      .join('\n')
    expect(containsSeedPhrase(numbered)).toBe(true)
  })

  it('needs 12 words in a row', () => {
    const eleven = PHRASE_12.split(' ').slice(0, 11).join(' ')
    expect(containsSeedPhrase(eleven)).toBe(false)
    // A word outside the list breaks the run
    const broken = PHRASE_12.split(' ')
    broken.splice(6, 0, 'krao')
    expect(containsSeedPhrase(broken.join(' '))).toBe(false)
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
  it('finds a bare 64 hex character key', () => {
    expect(containsPrivateKey(KEY)).toBe(true)
    expect(containsPrivateKey(`my key is ${KEY.toUpperCase()}!`)).toBe(true)
  })

  it('leaves 0x hashes, shorter or longer hex and numbers alone', () => {
    // Transaction hashes are written with 0x
    expect(containsPrivateKey(`tx: 0x${KEY}`)).toBe(false)
    expect(containsPrivateKey(KEY.slice(1))).toBe(false)
    expect(containsPrivateKey(`${KEY}a`)).toBe(false)
    expect(containsPrivateKey('1'.repeat(64))).toBe(false)
    expect(
      containsPrivateKey('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    ).toBe(false)
  })
})

describe('findSecrets', () => {
  it('names what it found', () => {
    expect(findSecrets(`${PHRASE_12}\n${KEY}`)).toEqual([
      'seedPhrase',
      'privateKey',
    ])
    expect(findSecrets('gm')).toEqual([])
  })
})
