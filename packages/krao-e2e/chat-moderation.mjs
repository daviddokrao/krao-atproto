// Chat moderation: Ozone reviews a reported chat message through the Krao
// chat service's chat.bsky.moderation.* methods, which only accept Ozone's
// service auth.
import { ACCOUNTS, PDS, checker, login } from './lib.mjs'

const OZONE = process.env.KRAO_OZONE_URL ?? 'http://localhost:2587'
const CHAT = process.env.KRAO_CHAT_URL ?? 'http://localhost:2590'
const ADMIN = `Basic ${Buffer.from(
  `admin:${process.env.KRAO_ADMIN_PASSWORD ?? 'admin-pass'}`,
).toString('base64')}`
const { check, done } = checker()

const chatDid = (await (await fetch(`${CHAT}/_health`)).json()).did

async function call(base, method, { query, body, headers } = {}) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return {
    ok: res.ok,
    status: res.status,
    data: await res.json().catch(() => ({})),
  }
}
const asUser = (session) => ({
  authorization: `Bearer ${session.accessJwt}`,
  'atproto-proxy': `${chatDid}#bsky_chat`,
})

const krao = await login(ACCOUNTS.krao)
const minh = await login(ACCOUNTS.minh)

const convo = await call(PDS, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [minh.did] },
  headers: asUser(krao),
})
const convoId = convo.data.convo?.id
const text = `Mua token này đi, lãi x100! ${Date.now()}`
const sent = await call(PDS, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text } },
  headers: asUser(krao),
})
const messageId = sent.data.id
check('a message to report', sent.ok && !!messageId, sent.data.message)

const notReported = await call(
  OZONE,
  'chat.bsky.moderation.getMessageContext',
  { query: { convoId, messageId }, headers: { authorization: ADMIN } },
)
check(
  'Ozone only shows messages that were reported',
  !notReported.ok,
  notReported.data.message,
)

const report = await call(OZONE, 'tools.ozone.moderation.emitEvent', {
  headers: { authorization: ADMIN },
  body: {
    event: {
      $type: 'tools.ozone.moderation.defs#modEventReport',
      reportType: 'com.atproto.moderation.defs#reasonSpam',
      comment: 'krao e2e: chat spam',
    },
    subject: {
      $type: 'chat.bsky.convo.defs#messageRef',
      did: krao.did,
      convoId,
      messageId,
    },
    createdBy: minh.did,
  },
})
check('the message can be reported to Ozone', report.ok, report.data.message)

const context = await call(OZONE, 'chat.bsky.moderation.getMessageContext', {
  query: { convoId, messageId },
  headers: { authorization: ADMIN },
})
check(
  'Ozone reads the reported message from the Krao chat service',
  context.ok && context.data.messages?.some((m) => m.text === text),
  context.data.message ?? context.data.error,
)

const modConvo = await call(OZONE, 'chat.bsky.moderation.getConvo', {
  query: { convoId },
  headers: { authorization: ADMIN },
})
const members = await call(OZONE, 'chat.bsky.moderation.getConvoMembers', {
  query: { convoId },
  headers: { authorization: ADMIN },
})
check(
  'Ozone sees the convo and its members',
  modConvo.data.convo?.id === convoId &&
    modConvo.data.convo.kind?.$type ===
      'chat.bsky.moderation.defs#directConvo' &&
    [krao.did, minh.did].every((did) =>
      members.data.members?.some((m) => m.did === did),
    ),
  modConvo.data.message ?? members.data.message,
)

const metadata = await call(OZONE, 'chat.bsky.moderation.getActorMetadata', {
  query: { actor: krao.did },
  headers: { authorization: ADMIN },
})
check(
  'Ozone gets activity counts for the account',
  metadata.ok &&
    metadata.data.day?.messagesSent >= 1 &&
    metadata.data.all?.convos >= 1,
  JSON.stringify(metadata.data),
)

// Users cannot call moderation methods themselves
const asMember = await call(PDS, 'chat.bsky.moderation.getConvo', {
  query: { convoId },
  headers: asUser(minh),
})
check(
  'moderation methods refuse ordinary accounts',
  !asMember.ok,
  `${asMember.status} ${asMember.data.error}`,
)
done()
