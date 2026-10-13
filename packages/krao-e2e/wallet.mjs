// M3: wallet linking (SIWE proofs verified by the indexer) and sign in with
// wallet on the PDS (io.krao.server.*).
import {
  ACCOUNTS,
  INDEXER,
  PDS,
  checker,
  createRecord,
  deleteRecord,
  login,
  sameAccount,
  sleep,
  wallet,
  walletRecord,
  xrpc,
} from './lib.mjs'

async function walletLogin(w, signer = w) {
  const ch = await xrpc(PDS, 'io.krao.server.getWalletChallenge', {
    query: { account: w.account },
  })
  if (!ch.ok) return ch
  const signature = signer.sign(ch.data.message)
  const res = await xrpc(PDS, 'io.krao.server.createWalletSession', {
    body: { account: w.account, message: ch.data.message, signature },
  })
  return { ...res, challenge: ch.data.message, signature }
}

const { check, done } = checker()
const s = await login(ACCOUNTS.krao)
const alice = await login(ACCOUNTS.alice)

// 1. Link a fresh wallet to krao.test, after a failed attempt (bad proof)
const w1 = wallet()
const failedFirst = await createRecord(
  s,
  'io.krao.actor.wallet',
  walletRecord(s.did, w1, wallet()),
)
const created = await createRecord(
  s,
  'io.krao.actor.wallet',
  walletRecord(s.did, w1),
)
check('link wallet record accepted by PDS', created.ok, created.data.error)
const linkedAgain = await createRecord(
  s,
  'io.krao.actor.wallet',
  walletRecord(s.did, w1),
)

// 2. alice.test copies the link; its proof names krao.test's DID
const stolen = await createRecord(
  alice,
  'io.krao.actor.wallet',
  walletRecord(s.did, w1),
)

await sleep(1500)
const prof = await xrpc(INDEXER, 'io.krao.actor.getChainProfiles', {
  query: { actors: ['krao.test', 'alice.test'] },
})
const statusOf = (did) =>
  prof.data.profiles
    ?.find((p) => p.did === did)
    ?.wallets?.find((w) => sameAccount(w.account, w1.account))?.status
check(
  'indexer shows the krao.test wallet as verified',
  statusOf(s.did) === 'verified',
  statusOf(s.did),
)
check(
  'indexer marks the copied proof on alice.test as invalid',
  statusOf(alice.did) === 'invalid',
  statusOf(alice.did),
)
const w1Entries =
  prof.data.profiles
    ?.find((p) => p.did === s.did)
    ?.wallets?.filter((w) => sameAccount(w.account, w1.account)) ?? []
check(
  'a wallet linked several times is listed once, as its first verified link',
  w1Entries.length === 1 && w1Entries[0].uri === created.data.uri,
  `${w1Entries.length} entries`,
)

// 3. Sign in with the linked wallet
const session = await walletLogin(w1)
check(
  'wallet sign-in returns a session for krao.test',
  session.ok && session.data.did === s.did,
  session.data.error ?? session.data.handle,
)
if (session.ok) {
  const me = await xrpc(PDS, 'com.atproto.server.getSession', {
    token: session.data.accessJwt,
  })
  check(
    'wallet session token works (getSession)',
    me.ok && me.data.handle === 'krao.test',
  )
}

// 4. Attacks
const replay = await xrpc(PDS, 'io.krao.server.createWalletSession', {
  body: {
    account: w1.account,
    message: session.challenge,
    signature: session.signature,
  },
})
check(
  'replaying a used challenge is rejected',
  !replay.ok && replay.data.error === 'ExpiredChallenge',
  replay.data.error,
)
const forged = await walletLogin(w1, wallet())
check(
  'signature from another wallet is rejected',
  !forged.ok && forged.data.error === 'InvalidSignature',
  forged.data.error,
)
const unlinked = await walletLogin(wallet())
check(
  'unlinked wallet is rejected',
  !unlinked.ok && unlinked.data.error === 'WalletNotLinked',
  unlinked.data.error,
)
const badChain = await xrpc(PDS, 'io.krao.server.getWalletChallenge', {
  query: { account: 'cosmos:hub:abc' },
})
check(
  'unsupported chain is rejected',
  !badChain.ok && badChain.data.error === 'UnsupportedChain',
  badChain.data.error,
)

// 5. Unlinking removes sign-in
await deleteRecord(s, created.data.uri)
if (stolen.ok) await deleteRecord(alice, stolen.data.uri)
await sleep(1500)
// The duplicate link still counts, which is why clients unlink every record
const stillLinked = await walletLogin(w1)
check(
  'a remaining duplicate link still signs in',
  stillLinked.ok && stillLinked.data.did === s.did,
  stillLinked.data.error,
)
for (const r of [failedFirst, linkedAgain]) {
  if (r.ok) await deleteRecord(s, r.data.uri)
}
await sleep(1500)
const afterUnlink = await walletLogin(w1)
check(
  'sign-in fails after the wallet is unlinked',
  !afterUnlink.ok && afterUnlink.data.error === 'WalletNotLinked',
  afterUnlink.data.error,
)
done()
