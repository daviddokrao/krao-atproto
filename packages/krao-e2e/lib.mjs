// Shared helpers for the Krao end-to-end checks. They talk to the local
// dev-env (`make run-dev-env`) and the Anvil Base fork (`krao-anvil`).
import { createHash } from 'node:crypto'
import {
  evmAddressFromPublicKey,
  formatSignInMessage,
  hashEvmMessage,
} from '@krao/wallet'
import { secp256k1 } from '@noble/curves/secp256k1'
import * as ui8 from 'uint8arrays'

export const PDS = process.env.KRAO_PDS_URL ?? 'http://localhost:2583'
export const APPVIEW = process.env.KRAO_APPVIEW_URL ?? 'http://localhost:2584'
export const INDEXER = process.env.KRAO_INDEXER_URL ?? 'http://localhost:2589'
export const GATE = process.env.KRAO_GATE_URL ?? INDEXER
export const GATE_DID = process.env.KRAO_GATE_DID ?? 'did:web:gate.krao.test'
export const RPC = process.env.KRAO_RPC_URL ?? 'http://localhost:8545'
export const REWARDS = process.env.KRAO_REWARDS_URL ?? 'http://localhost:2592'
export const REWARDS_DID =
  process.env.KRAO_REWARDS_DID ?? 'did:web:rewards.krao.test'
/** Campaign code the dev-env creates; sign-up needs a referral code */
export const SIGNUP_CODE = process.env.KRAO_SIGNUP_CODE ?? 'KRAO-DEV'
/** The dev-env's PDS <-> rewards token, for the rewards /internal routes */
export const REWARDS_TOKEN =
  process.env.KRAO_REWARDS_INTERNAL_TOKEN ?? 'krao-dev-rewards-token'

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const ETH_ASSET = 'eip155:8453/slip44:60'
export const USDC_ASSET = `eip155:8453/erc20:${USDC}`

// Anvil's well-known, publicly documented dev keys (local chain only)
export const ANVIL_KEYS = [
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]

// Accounts created by scripts/seed-local.mjs and the dev-env mock data
export const ACCOUNTS = {
  krao: ['krao.test', 'krao-dev-pass'],
  minh: ['defi-minh.test', 'krao-dev-pass'],
  mai: ['dao-mai.test', 'krao-dev-pass'],
  lan: ['nft-lan.test', 'krao-dev-pass'],
  alice: ['alice.test', 'hunter2'],
  rewardsAdmin: ['rewards-admin.test', 'krao-dev-pass'],
}

/** An EVM wallet from a hex private key, or a random one */
export function wallet(hexKey) {
  const key = hexKey
    ? ui8.fromString(hexKey, 'base16')
    : secp256k1.utils.randomPrivateKey()
  const address = evmAddressFromPublicKey(secp256k1.getPublicKey(key, false))
  const sign = (message) => {
    const s = secp256k1.sign(hashEvmMessage(message), key)
    const v = (s.recovery + 27).toString(16)
    return '0x' + ui8.toString(s.toCompactRawBytes(), 'base16') + v
  }
  return { address, account: `eip155:8453:${address}`, sign }
}

export async function xrpc(base, method, { token, body, query } = {}) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return {
    ok: res.ok,
    status: res.status,
    data: await res.json().catch(() => ({})),
  }
}

export async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

/**
 * Signs in. Posting and chat need a verified phone in the dev-env (Decree
 * 147), so the account gets one unless `{ phone: false }`.
 */
export async function login([identifier, password], { phone = true } = {}) {
  const res = await xrpc(PDS, 'com.atproto.server.createSession', {
    body: { identifier, password },
  })
  if (!res.ok) {
    throw new Error(
      `Cannot sign in as ${identifier} (${res.data.error}). ` +
        'Did you run `node scripts/seed-local.mjs` after starting the dev-env?',
    )
  }
  if (phone) await verifyPhone(res.data)
  return res.data
}

/** Calls the rewards service as `session`, the way the app does */
export async function rewardsCall(session, method, { body, query } = {}) {
  const token = await serviceAuth(session, method, REWARDS_DID)
  return xrpc(REWARDS, method, { token, body, query })
}

/** A test number per account: +849 and 8 digits from its DID */
export function testPhone(did) {
  const n = createHash('sha256').update(did).digest().readUInt32BE(0) % 1e8
  return `+849${String(n).padStart(8, '0')}`
}

/** The last code the dev-env rewards service "sent" to the account */
export async function lastOtp(did) {
  const url = new URL('/internal/dev/last-otp', REWARDS)
  url.searchParams.set('did', did)
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${REWARDS_TOKEN}` },
  })
  return res.ok ? (await res.json()).code : undefined
}

/**
 * Verifies a phone number for the account through the real flow: request
 * a code, read it from the dev-env, send it back. Does nothing when the
 * account already has one.
 */
export async function verifyPhone(session, phone = testPhone(session.did)) {
  const status = await rewardsCall(session, 'net.krao.phone.getStatus')
  if (status.data.verified) return status.data
  const sent = await rewardsCall(session, 'net.krao.phone.requestCode', {
    body: { phone },
  })
  if (!sent.ok) {
    throw new Error(`requestCode for ${session.handle}: ${sent.data.message}`)
  }
  const code = await lastOtp(session.did)
  const verified = await rewardsCall(session, 'net.krao.phone.verifyCode', {
    body: { phone, code },
  })
  if (!verified.ok) {
    throw new Error(
      `verifyCode for ${session.handle}: ${verified.data.message}`,
    )
  }
  return verified.data
}

export function createRecord(session, collection, record, { rkey } = {}) {
  return xrpc(PDS, 'com.atproto.repo.createRecord', {
    token: session.accessJwt,
    body: {
      repo: session.did,
      collection,
      rkey,
      validate: true,
      record: { $type: collection, ...record },
    },
  })
}

export function putRecord(session, collection, rkey, record) {
  return xrpc(PDS, 'com.atproto.repo.putRecord', {
    token: session.accessJwt,
    body: {
      repo: session.did,
      collection,
      rkey,
      validate: true,
      record: { $type: collection, ...record },
    },
  })
}

export function deleteRecord(session, uri) {
  const [collection, rkey] = uri.split('/').slice(-2)
  return xrpc(PDS, 'com.atproto.repo.deleteRecord', {
    token: session.accessJwt,
    body: { repo: session.did, collection, rkey },
  })
}

/** An net.krao.actor.wallet record whose SIWE proof is signed by `signer` */
export function walletRecord(did, w, signer = w) {
  const message = formatSignInMessage({
    domain: 'krao.net',
    chain: 'Ethereum',
    address: w.address,
    statement: 'Link this wallet to my Krao account.',
    uri: did,
    version: '1',
    chainId: '8453',
    nonce: Math.random().toString(36).slice(2, 12),
    issuedAt: new Date().toISOString(),
    resources: [],
  })
  return {
    account: w.account,
    proof: { type: 'siwe', message, signature: signer.sign(message) },
    createdAt: new Date().toISOString(),
  }
}

export function linkWallet(session, w) {
  return createRecord(
    session,
    'net.krao.actor.wallet',
    walletRecord(session.did, w),
  )
}

export async function serviceAuth(session, lxm, aud = GATE_DID) {
  const res = await xrpc(PDS, 'com.atproto.server.getServiceAuth', {
    token: session.accessJwt,
    query: { aud, lxm },
  })
  return res.data.token
}

/** Sets an ERC-20 balance on the Anvil fork (absolute, not a top-up) */
export function dealErc20(address, token, amount) {
  return rpc('anvil_dealERC20', [address, token, '0x' + amount.toString(16)])
}

export const pad32 = (hex) =>
  hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const sameAccount = (a, b) => a?.toLowerCase() === b?.toLowerCase()

/** PASS/FAIL reporter; `done()` exits non-zero if any check failed */
export function checker() {
  let failures = 0
  const check = (name, cond, detail = '') => {
    if (!cond) failures++
    console.log(
      `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`,
    )
  }
  const done = () => process.exit(failures ? 1 : 0)
  return { check, done }
}
