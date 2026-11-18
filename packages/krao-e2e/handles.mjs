// The PDS refuses handles that clash with the app's top-level pages, since
// the app serves profiles at short URLs (krao.net/<name>).
import { readFileSync } from 'node:fs'
import { PDS, SIGNUP_CODE, checker, xrpc } from './lib.mjs'

const BRAND = JSON.parse(
  readFileSync(new URL('../krao-brand/brand.json', import.meta.url), 'utf8'),
)

const { check, done } = checker()
const createAccount = (name) =>
  xrpc(PDS, 'com.atproto.server.createAccount', {
    body: {
      handle: `${name}.test`,
      email: `${name}-${Date.now()}@example.com`,
      password: 'krao-dev-pass',
      inviteCode: SIGNUP_CODE,
    },
  })

// Upstream's list already has search/settings; the rest are Krao's additions
for (const name of [
  'search',
  'settings',
  'saved',
  'hashtag',
  'wallet',
  // The brand's domain without dots (kraonet)
  BRAND.domain.replace(/\./g, ''),
]) {
  const res = await createAccount(name)
  check(
    `"${name}" is reserved`,
    res.data.error === 'HandleNotAvailable',
    res.data.error ?? 'account created',
  )
}

const free = `lan${Date.now().toString(36).slice(-6)}`
const res = await createAccount(free)
check(`an ordinary name ("${free}") is accepted`, res.ok, res.data.message)
done()
