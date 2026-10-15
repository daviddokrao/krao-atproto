// Push notifications through Krao's push service (krao-push), which stands in
// for Bluesky's closed courier. A device token goes the way the app sends it
// (PDS → AppView → krao-push); likes, follows, replies, chat messages and
// KYC decisions then reach it. The dev-env has no FCM/APNs keys, so krao-push
// only logs pushes and lists them at /internal/recent.
import {
  ACCOUNTS,
  PDS,
  REWARDS,
  REWARDS_DID,
  SIGNUP_CODE,
  checker,
  createRecord,
  deleteRecord,
  login,
  serviceAuth,
  sleep,
  verifyPhone,
  xrpc,
} from './lib.mjs'

const PUSH = process.env.KRAO_PUSH_URL ?? 'http://localhost:2593'
const PUSH_TOKEN =
  process.env.KRAO_PUSH_INTERNAL_TOKEN ?? 'krao-dev-push-internal-token'
/** The dev-env AppView's DID (fixed by its key) */
const APPVIEW_DID =
  process.env.KRAO_APPVIEW_DID ?? 'did:plc:dw4kbjf5mn7nhenabiqpkyh3'
const CHAT = process.env.KRAO_CHAT_URL ?? 'http://localhost:2590'

const { check, done } = checker()

async function create(session, collection, record, opts) {
  const res = await createRecord(session, collection, record, opts)
  if (!res.ok) throw new Error(`createRecord: ${JSON.stringify(res.data)}`)
  return res.data
}
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
  // Posting and chat need a verified phone in the dev-env
  await verifyPhone(res.data)
  // A display name, for the push titles
  await create(
    res.data,
    'app.bsky.actor.profile',
    { $type: 'app.bsky.actor.profile', displayName: name },
    { rkey: 'self' },
  )
  return res.data
}

/** What krao-push sent to `token` so far */
async function sentTo(token) {
  const res = await fetch(`${PUSH}/internal/recent`, {
    headers: { authorization: `Bearer ${PUSH_TOKEN}` },
  })
  const { sent } = await res.json()
  return sent.filter((s) => s.token === token).map((s) => s.msg)
}

/** Waits for a push to `token` that `match` accepts */
async function waitForPush(token, match, ms = 15_000) {
  const until = Date.now() + ms
  for (;;) {
    const found = (await sentTo(token)).find(match)
    if (found || Date.now() > until) return found
    await sleep(300)
  }
}

const reg = (session, token, method = 'app.bsky.notification.registerPush') =>
  xrpc(PDS, method, {
    token: session.accessJwt,
    body: {
      serviceDid: APPVIEW_DID,
      token,
      platform: 'ios',
      appId: 'io.krao.app',
    },
  })

const ana = await signUp('Ana')
const bao = await signUp('Bao')
const anaToken = `e2e-ana-${stamp}`

const registered = await reg(ana, anaToken)
check(
  'the app registers a device token through the PDS and AppView',
  registered.ok,
  JSON.stringify(registered.data),
)

// Bao follows Ana
await create(bao, 'app.bsky.graph.follow', {
  $type: 'app.bsky.graph.follow',
  subject: ana.did,
  createdAt: new Date().toISOString(),
})
const follow = await waitForPush(anaToken, (m) => m.data.reason === 'follow')
check(
  'a new follower is pushed, named',
  follow?.title === 'Bao followed you' && follow.data.recipientDid === ana.did,
  JSON.stringify(follow),
)

// Ana posts, Bao likes and replies
const post = await create(ana, 'app.bsky.feed.post', {
  $type: 'app.bsky.feed.post',
  text: 'Hello from Ana',
  createdAt: new Date().toISOString(),
})
const like = await create(bao, 'app.bsky.feed.like', {
  $type: 'app.bsky.feed.like',
  subject: { uri: post.uri, cid: post.cid },
  createdAt: new Date().toISOString(),
})
const liked = await waitForPush(anaToken, (m) => m.data.reason === 'like')
check(
  'a like is pushed with the liked post',
  liked?.title === 'Bao liked your post' &&
    liked.body === 'Hello from Ana' &&
    liked.data.subject === post.uri,
  JSON.stringify(liked),
)
await create(bao, 'app.bsky.feed.post', {
  $type: 'app.bsky.feed.post',
  text: 'Nice post!',
  reply: {
    root: { uri: post.uri, cid: post.cid },
    parent: { uri: post.uri, cid: post.cid },
  },
  createdAt: new Date().toISOString(),
})
const reply = await waitForPush(anaToken, (m) => m.data.reason === 'reply')
check(
  'a reply is pushed with its text',
  reply?.title === 'Bao replied to you' && reply.body === 'Nice post!',
  JSON.stringify(reply),
)

// Ana turns off like pushes: a new like is not pushed
const prefs = await xrpc(PDS, 'app.bsky.notification.putPreferencesV2', {
  token: ana.accessJwt,
  body: { like: { include: 'all', list: true, push: false } },
})
check('push preferences can be changed', prefs.ok, JSON.stringify(prefs.data))
await deleteRecord(bao, like.uri)
const post2 = await create(ana, 'app.bsky.feed.post', {
  $type: 'app.bsky.feed.post',
  text: 'Second post',
  createdAt: new Date().toISOString(),
})
await create(bao, 'app.bsky.feed.like', {
  $type: 'app.bsky.feed.like',
  subject: { uri: post2.uri, cid: post2.cid },
  createdAt: new Date().toISOString(),
})
// A reply after the like: once it is pushed, the like had its chance
await create(bao, 'app.bsky.feed.post', {
  $type: 'app.bsky.feed.post',
  text: 'Marker reply',
  reply: {
    root: { uri: post2.uri, cid: post2.cid },
    parent: { uri: post2.uri, cid: post2.cid },
  },
  createdAt: new Date().toISOString(),
})
await waitForPush(anaToken, (m) => m.body === 'Marker reply')
check(
  'a reason turned off is not pushed',
  !(await sentTo(anaToken)).some(
    (m) => m.data.reason === 'like' && m.data.subject === post2.uri,
  ),
)

// Ana mutes Bao: his replies stop
await xrpc(PDS, 'app.bsky.graph.muteActor', {
  token: ana.accessJwt,
  body: { actor: bao.did },
})
await create(bao, 'app.bsky.feed.post', {
  $type: 'app.bsky.feed.post',
  text: 'Muted reply',
  reply: {
    root: { uri: post.uri, cid: post.cid },
    parent: { uri: post.uri, cid: post.cid },
  },
  createdAt: new Date().toISOString(),
})
await sleep(4000)
check(
  'a muted account is not pushed',
  !(await sentTo(anaToken)).some((m) => m.body === 'Muted reply'),
)
await xrpc(PDS, 'app.bsky.graph.unmuteActor', {
  token: ana.accessJwt,
  body: { actor: bao.did },
})

// Chat: Ana follows Bao back, so he may message her
await create(ana, 'app.bsky.graph.follow', {
  $type: 'app.bsky.graph.follow',
  subject: bao.did,
  createdAt: new Date().toISOString(),
})
await sleep(1000)
const chatDid = (await (await fetch(`${CHAT}/_health`)).json()).did
const chat = async (session, method, { query, body } = {}) => {
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
  return { ok: res.ok, data: await res.json().catch(() => ({})) }
}
const convo = await chat(bao, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [ana.did] },
})
const convoId = convo.data.convo?.id
const sent = await chat(bao, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text: 'Hi Ana, coffee?' } },
})
check('Bao messages Ana', sent.ok, JSON.stringify(sent.data))
const message = await waitForPush(
  anaToken,
  (m) => m.data.reason === 'chat-message',
)
check(
  'a chat message is pushed with what the app needs to open it',
  message?.title === 'Bao' &&
    message.body === 'Hi Ana, coffee?' &&
    message.data.convoId === convoId &&
    message.data.messageId === sent.data.id,
  JSON.stringify(message),
)
await chat(ana, 'chat.bsky.convo.muteConvo', { body: { convoId } })
await chat(bao, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text: 'Still there?' } },
})
await sleep(2000)
check(
  'a muted conversation is not pushed',
  !(await sentTo(anaToken)).some((m) => m.body === 'Still there?'),
)

// KYC decided by hand: Ana hears about it
const admin = await login(ACCOUNTS.rewardsAdmin)
const adminToken = await serviceAuth(
  admin,
  'net.krao.rewards.admin.reviewKyc',
  REWARDS_DID,
)
const review = await xrpc(REWARDS, 'net.krao.rewards.admin.reviewKyc', {
  token: adminToken,
  body: {
    did: ana.did,
    decision: 'approve',
    reasonCode: 'provider_outage',
    note: 'Checked documents on a video call (e2e)',
  },
})
check('an admin approves Ana’s KYC', review.ok, JSON.stringify(review.data))
const kyc = await waitForPush(
  anaToken,
  (m) => m.data.reason === 'krao-kyc',
  30_000,
)
check(
  'a KYC decision is pushed',
  kyc?.title === 'Your identity is verified',
  JSON.stringify(kyc),
)

// After unregistering, nothing more arrives
const unreg = await reg(ana, anaToken, 'app.bsky.notification.unregisterPush')
check('the app unregisters its token', unreg.ok, JSON.stringify(unreg.data))
const before = (await sentTo(anaToken)).length
await create(bao, 'app.bsky.feed.post', {
  $type: 'app.bsky.feed.post',
  text: 'After logout',
  reply: {
    root: { uri: post.uri, cid: post.cid },
    parent: { uri: post.uri, cid: post.cid },
  },
  createdAt: new Date().toISOString(),
})
await sleep(4000)
check(
  'an unregistered device gets nothing',
  (await sentTo(anaToken)).length === before,
)

done()
