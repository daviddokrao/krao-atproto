// Crypto safety (M27): phishing link checks and the unsafe domain list,
// posts linking to it kept out of Popular, address owner lookups, the
// verification badge from Krao's trusted verifier, seed phrases refused in
// chat and the opt-in "human" badge. Needs the dev-env (krao-verify.test,
// rewards-admin.test as safety admin) and the seed script's data.
import {
  ACCOUNTS,
  APPVIEW,
  GATE_DID,
  INDEXER,
  PDS,
  SIGNUP_CODE,
  checker,
  createRecord,
  linkWallet,
  login,
  rewardsCall,
  serviceAuth,
  sleep,
  verifyPhone,
  wallet,
  xrpc,
} from './lib.mjs'

const CHAT = process.env.KRAO_CHAT_URL ?? 'http://localhost:2590'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)

async function signUp(name) {
  const handle = `${name}${stamp}.test`
  const res = await xrpc(PDS, 'com.atproto.server.createAccount', {
    body: {
      handle,
      email: `${handle}@example.com`,
      password: 'krao-dev-pass',
      inviteCode: SIGNUP_CODE,
    },
  })
  if (!res.ok) throw new Error(`createAccount: ${res.data.message}`)
  return res.data
}

const checkLinks = (urls) =>
  xrpc(INDEXER, 'net.krao.safety.checkLinks', { body: { urls } })

/** A safety admin method on the indexer, called as `session` */
async function admin(session, method, { body, query } = {}) {
  const token = await serviceAuth(session, method, GATE_DID)
  return xrpc(INDEXER, method, { token, body, query })
}

/*
 * Link checks and the unsafe domain list
 */

const links = await checkLinks([
  'https://drainer.test/connect',
  'https://claim.free-airdrop-claim.test/now',
  'https://krao.net/',
])
const unsafe = links.data.results?.map((r) => r.unsafe)
check(
  'checkLinks flags the seed drainer domains, subdomains too',
  links.ok && JSON.stringify(unsafe) === '[true,true,false]',
  JSON.stringify(links.data),
)
check(
  'and names the listed domain',
  links.data.results?.[1]?.domain === 'free-airdrop-claim.test',
  links.data.results?.[1]?.domain,
)
const tooMany = await checkLinks(
  Array.from({ length: 21 }, (_, i) => `https://a${i}.example`),
)
check('at most 20 links per call', tooMany.status === 400, tooMany.status)

const safetyAdmin = await login(ACCOUNTS.rewardsAdmin, { phone: false })
const krao = await login(ACCOUNTS.krao)
const phish = `phish-${stamp}.test`
const notAdmin = await admin(krao, 'net.krao.safety.admin.addDomain', {
  body: { domain: phish },
})
check(
  'only safety admins may add domains',
  notAdmin.status === 403,
  notAdmin.status,
)
const added = await admin(safetyAdmin, 'net.krao.safety.admin.addDomain', {
  body: { domain: `https://${phish}/x`, reason: 'e2e drainer' },
})
check(
  'a safety admin adds a domain (from a URL)',
  added.ok && added.data.domain === phish && added.data.source === 'admin',
  JSON.stringify(added.data),
)
const afterAdd = await checkLinks([`https://wallet.${phish}`])
check(
  'checkLinks flags it at once',
  afterAdd.data.results?.[0]?.unsafe === true &&
    afterAdd.data.results?.[0]?.reason === 'e2e drainer',
  JSON.stringify(afterAdd.data),
)
const listed = await admin(safetyAdmin, 'net.krao.safety.admin.listDomains', {
  query: { source: 'admin', query: phish },
})
check(
  'listDomains finds it',
  listed.data.domains?.length === 1,
  JSON.stringify(listed.data),
)
const removed = await admin(safetyAdmin, 'net.krao.safety.admin.removeDomain', {
  body: { domain: phish },
})
const afterRemove = await checkLinks([`https://${phish}`])
check(
  'removing it clears the flag',
  removed.data.removed === true &&
    afterRemove.data.results?.[0]?.unsafe === false,
  JSON.stringify(afterRemove.data),
)

/*
 * Posts linking to an unsafe domain stay out of Popular
 */

const desc = await xrpc(INDEXER, 'app.bsky.feed.describeFeedGenerator')
const popularUri = `at://${krao.did}/app.bsky.feed.generator/popular`
const latestUri = `at://${krao.did}/app.bsky.feed.generator/latest`
check(
  'krao.test publishes the popular feed (seed script)',
  desc.data.feeds?.some((f) => f.uri === popularUri),
  JSON.stringify(desc.data.feeds),
)

const linkPost = (text, url) => {
  const byteStart = Buffer.byteLength(text)
  return createRecord(krao, 'app.bsky.feed.post', {
    text: `${text}${url}`,
    facets: [
      {
        index: { byteStart, byteEnd: byteStart + Buffer.byteLength(url) },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
      },
    ],
    createdAt: new Date().toISOString(),
  })
}
const bad = await linkPost(
  `Free airdrop ${stamp}, connect here: `,
  'https://drainer.test/claim',
)
const good = await linkPost(`Docs ${stamp}: `, 'https://krao.net/docs')
check('both posts are written', bad.ok && good.ok, bad.data.message)

/** Every post of a feed, following cursors */
async function feedPosts(feed) {
  const posts = []
  let cursor
  for (let i = 0; i < 20; i++) {
    const page = await xrpc(INDEXER, 'app.bsky.feed.getFeedSkeleton', {
      query: { feed, limit: 100, ...(cursor ? { cursor } : {}) },
    })
    posts.push(...(page.data.feed ?? []).map((item) => item.post))
    cursor = page.data.cursor
    if (!cursor) break
  }
  return posts
}
let latest = []
for (let i = 0; i < 20 && !latest.includes(bad.data.uri); i++) {
  await sleep(500)
  latest = await feedPosts(latestUri)
}
const popular = await feedPosts(popularUri)
check(
  'the drainer post is indexed (latest feed)',
  latest.includes(bad.data.uri),
)
check(
  'but left out of Popular, unlike a safe link',
  !popular.includes(bad.data.uri) && popular.includes(good.data.uri),
  `bad in popular: ${popular.includes(bad.data.uri)}, good: ${popular.includes(good.data.uri)}`,
)

/*
 * Address checks: owners of verified wallets (lookalike detection itself is
 * covered by unit tests: a crafted lookalike address cannot sign a link)
 */

const owners = [await signUp('owner'), await signUp('other')]
const wallets = [wallet(), wallet()]
for (const [i, session] of owners.entries()) {
  const res = await linkWallet(session, wallets[i])
  check(`account ${i + 1} links a wallet`, res.ok, res.data.message)
}
const checkAddresses = (addresses, expectedDid) =>
  xrpc(INDEXER, 'net.krao.safety.checkAddresses', {
    body: { addresses, ...(expectedDid ? { expectedDid } : {}) },
  })
let addrs
for (let i = 0; i < 20; i++) {
  await sleep(500)
  addrs = await checkAddresses(
    [wallets[0].address, wallets[1].address.toUpperCase().replace('0X', '0x')],
    owners[0].did,
  )
  if (addrs.data.results?.every((r) => r.owner)) break
}
const [first, second] = addrs.data.results ?? []
check(
  'checkAddresses resolves the owner of each verified wallet',
  first?.owner === owners[0].did && second?.owner === owners[1].did,
  JSON.stringify(addrs.data),
)
check(
  'tells whether it is the expected account',
  first?.matchesExpected === true && second?.matchesExpected === false,
)
check(
  'and finds no lookalikes for unrelated addresses',
  first?.lookalikes?.length === 0 && second?.lookalikes?.length === 0,
)
const stranger = await checkAddresses([wallet().address])
check(
  'an unknown address has no owner',
  stranger.ok && !stranger.data.results?.[0]?.owner,
  JSON.stringify(stranger.data),
)
const malformed = await checkAddresses(['0x1234'])
check(
  'malformed addresses are refused',
  malformed.data.error === 'InvalidAddress',
  malformed.data.error,
)

/*
 * Verification badge from Krao's trusted verifier
 */

const official = await xrpc(APPVIEW, 'app.bsky.actor.getProfile', {
  query: { actor: 'krao.test' },
})
const verifierProfile = await xrpc(APPVIEW, 'app.bsky.actor.getProfile', {
  query: { actor: 'krao-verify.test' },
})
check(
  'krao.test is verified by krao-verify.test',
  official.data.verification?.verifiedStatus === 'valid' &&
    official.data.verification?.verifications?.some(
      (v) => v.issuer === verifierProfile.data.did && v.isValid,
    ),
  JSON.stringify(official.data.verification),
)
check(
  'krao-verify.test is a trusted verifier',
  verifierProfile.data.verification?.trustedVerifierStatus === 'valid',
  JSON.stringify(verifierProfile.data.verification),
)

/*
 * Seed phrases and private keys are refused in chat
 */

const chatDid = (await (await fetch(`${CHAT}/_health`)).json()).did
async function chat(session, method, { query, body } = {}) {
  const url = new URL(`/xrpc/${method}`, PDS)
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'atproto-proxy': `${chatDid}#bsky_chat`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, status: res.status, data: await res.json() }
}
const minh = await login(ACCOUNTS.minh)
const convo = await chat(krao, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [minh.did] },
})
const convoId = convo.data.convo?.id
const phrase =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const seedMsg = await chat(krao, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text: `Giữ giúp mình nhé: ${phrase}` } },
})
check(
  'a message with 12 BIP39 words is refused (SensitiveSecret)',
  seedMsg.status === 400 && seedMsg.data.error === 'SensitiveSecret',
  JSON.stringify(seedMsg.data),
)
const keyMsg = await chat(krao, 'chat.bsky.convo.sendMessageBatch', {
  body: {
    items: [
      { convoId, message: { text: 'first, harmless' } },
      {
        convoId,
        message: { text: `key ${'ab12'.repeat(16)}` },
      },
    ],
  },
})
check(
  'so is a private key, and its whole batch',
  keyMsg.data.error === 'SensitiveSecret',
  JSON.stringify(keyMsg.data),
)
const txMsg = await chat(krao, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text: `Sent, tx 0x${'ab12'.repeat(16)}` } },
})
check('a 0x transaction hash is fine', txMsg.ok, JSON.stringify(txMsg.data))
const recent = await chat(minh, 'chat.bsky.convo.getMessages', {
  query: { convoId, limit: 5 },
})
check(
  'nothing of the refused batch was sent',
  !recent.data.messages?.some((m) => m.text === 'first, harmless'),
)

/*
 * The "human" badge: verified phone (or KYC), shown only when opted in
 */

const human = await signUp('human')
const badges = async () =>
  (
    await xrpc(
      process.env.KRAO_REWARDS_URL ?? 'http://localhost:2592',
      'net.krao.kyc.getBadges',
      { query: { dids: [human.did, krao.did] } },
    )
  ).data.actors ?? []
const optedEarly = await rewardsCall(human, 'net.krao.kyc.setBadgeVisibility', {
  body: { human: true },
})
check(
  'an account without a verified phone can opt in, but is not eligible',
  optedEarly.data.human === true && optedEarly.data.eligible === false,
  JSON.stringify(optedEarly.data),
)
check('and shows no badge', !(await badges()).some((a) => a.did === human.did))
await verifyPhone(human)
const shown = await badges()
check(
  'with a verified phone the human badge shows',
  shown.some((a) => a.did === human.did && a.badges.includes('human')),
  JSON.stringify(shown),
)
const visibility = await rewardsCall(human, 'net.krao.kyc.getBadgeVisibility')
check(
  'getBadgeVisibility reports it',
  visibility.data.human === true && visibility.data.eligible === true,
  JSON.stringify(visibility.data),
)
await rewardsCall(human, 'net.krao.kyc.setBadgeVisibility', {
  body: { human: false },
})
check(
  'opting out hides it again',
  !(await badges()).some((a) => a.did === human.did),
)
check(
  'the badge does not say how the account verified',
  shown.every((a) => Object.keys(a).sort().join() === 'badges,did'),
)

/*
 * Operations: safety admins replay the indexer's failed firehose events
 */
const replay = await admin(
  safetyAdmin,
  'net.krao.indexer.admin.replayFailedEvents',
  { body: { limit: 100 } },
)
check(
  'a safety admin replays failed firehose events, with counts',
  replay.ok &&
    ['replayed', 'failed', 'remaining'].every(
      (k) => typeof replay.data[k] === 'number',
    ),
  JSON.stringify(replay.data),
)
const replayDenied = await admin(
  krao,
  'net.krao.indexer.admin.replayFailedEvents',
  { body: {} },
)
check('others may not replay', replayDenied.status === 403, replayDenied.status)

done()
