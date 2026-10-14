// The Krao chat service, reached the way the app does: through the PDS with
// an atproto-proxy header naming the service's #bsky_chat endpoint.
// Covers direct messages (requests, replies, reactions, reads, deletes,
// record embeds, who may message whom) and groups (members, join links,
// approvals, locks, roles).
import { ACCOUNTS, PDS, checker, createRecord, login, xrpc } from './lib.mjs'

const CHAT = process.env.KRAO_CHAT_URL ?? 'http://localhost:2590'
const { check, done } = checker()

const chatDid = (await (await fetch(`${CHAT}/_health`)).json()).did
const proxy = `${chatDid}#bsky_chat`

async function call(session, method, { query, body } = {}) {
  const url = new URL(`/xrpc/${method}`, PDS)
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      'atproto-proxy': proxy,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

async function freshAccount(prefix) {
  const handle = `${prefix}${Date.now().toString(36).slice(-6)}.test`
  const res = await xrpc(PDS, 'com.atproto.server.createAccount', {
    body: { handle, email: `${handle}@example.com`, password: 'krao-dev-pass' },
  })
  if (!res.ok) throw new Error(`createAccount: ${res.data.message}`)
  return res.data
}

const krao = await login(ACCOUNTS.krao)
const minh = await login(ACCOUNTS.minh)
const mai = await login(ACCOUNTS.mai)
const lan = await login(ACCOUNTS.lan)
const stranger = await freshAccount('chat')

/*
 * Direct messages
 */

const minhCursor = (await call(minh, 'chat.bsky.convo.getLog')).data.cursor
check('getLog without a cursor returns one', typeof minhCursor === 'string')

const dm = await call(krao, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [minh.did] },
})
const convoId = dm.data.convo?.id
check(
  'getConvoForMembers creates a direct convo',
  dm.ok &&
    dm.data.convo.kind.$type === 'chat.bsky.convo.defs#directConvo' &&
    dm.data.convo.members.length === 2,
  dm.data.message,
)
const again = await call(krao, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [minh.did, krao.did] },
})
check('the same members get the same convo', again.data.convo?.id === convoId)

const hello = await call(krao, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text: 'Chào Minh 👋' } },
})
check(
  'sendMessage returns the message',
  hello.ok && hello.data.text === 'Chào Minh 👋' && hello.data.sender.did === krao.did,
  hello.data.message,
)

const minhList = await call(minh, 'chat.bsky.convo.listConvos')
const minhConvo = minhList.data.convos?.find((c) => c.id === convoId)
check(
  'the recipient sees the convo with one unread message',
  minhConvo?.unreadCount === 1 && minhConvo.lastMessage?.text === 'Chào Minh 👋',
  JSON.stringify(minhConvo?.unreadCount),
)
const counts = await call(minh, 'chat.bsky.convo.getUnreadCounts')
check(
  'getUnreadCounts counts it',
  counts.data.unreadAcceptedConvos + counts.data.unreadRequestConvos >= 1,
  JSON.stringify(counts.data),
)

const log = await call(minh, 'chat.bsky.convo.getLog', {
  query: { cursor: minhCursor },
})
check(
  'getLog delivers the new message to the recipient',
  log.data.logs?.some(
    (l) =>
      l.$type === 'chat.bsky.convo.defs#logCreateMessage' &&
      l.message.id === hello.data.id,
  ),
  log.data.logs?.map((l) => l.$type).join(','),
)

const reply = await call(minh, 'chat.bsky.convo.sendMessage', {
  body: {
    convoId,
    message: { text: 'Chào anh!', replyTo: { messageId: hello.data.id } },
  },
})
check(
  'a reply carries the message it replies to',
  reply.data.replyTo?.id === hello.data.id,
  reply.data.message,
)

const react = await call(minh, 'chat.bsky.convo.addReaction', {
  body: { convoId, messageId: hello.data.id, value: '🔥' },
})
check(
  'addReaction adds the emoji',
  react.data.message?.reactions?.some((r) => r.value === '🔥'),
  react.data.message,
)
const badReact = await call(minh, 'chat.bsky.convo.addReaction', {
  body: { convoId, messageId: hello.data.id, value: 'a' },
})
check(
  'a reaction must be one emoji',
  badReact.data.error === 'ReactionInvalidValue',
  badReact.data.error,
)

const read = await call(minh, 'chat.bsky.convo.updateRead', {
  body: { convoId },
})
check('updateRead clears the unread count', read.data.convo?.unreadCount === 0)

const deleted = await call(krao, 'chat.bsky.convo.deleteMessageForSelf', {
  body: { convoId, messageId: reply.data.id },
})
const kraoMessages = await call(krao, 'chat.bsky.convo.getMessages', {
  query: { convoId },
})
const minhMessages = await call(minh, 'chat.bsky.convo.getMessages', {
  query: { convoId },
})
check(
  'a message deleted for self is gone only for that account',
  deleted.ok &&
    kraoMessages.data.messages?.find((m) => m.id === reply.data.id)?.$type ===
      'chat.bsky.convo.defs#deletedMessageView' &&
    minhMessages.data.messages?.find((m) => m.id === reply.data.id)?.$type ===
      'chat.bsky.convo.defs#messageView',
)

const post = await createRecord(krao, 'app.bsky.feed.post', {
  text: 'Bài để chia sẻ qua chat',
  createdAt: new Date().toISOString(),
})
let embedded
for (let i = 0; i < 10 && !embedded; i++) {
  const sent = await call(krao, 'chat.bsky.convo.sendMessage', {
    body: {
      convoId,
      message: {
        text: '',
        embed: {
          $type: 'app.bsky.embed.record',
          record: { uri: post.data.uri, cid: post.data.cid },
        },
      },
    },
  })
  if (sent.data.embed?.record?.$type === 'app.bsky.embed.record#viewRecord') {
    embedded = sent.data
  } else {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}
check(
  'a shared post is embedded as a record view',
  embedded?.embed?.record?.value?.text === 'Bài để chia sẻ qua chat',
)

const muted = await call(minh, 'chat.bsky.convo.muteConvo', { body: { convoId } })
const unmuted = await call(minh, 'chat.bsky.convo.unmuteConvo', {
  body: { convoId },
})
check(
  'mute and unmute',
  muted.data.convo?.muted === true && unmuted.data.convo?.muted === false,
)

const availability = await call(stranger, 'chat.bsky.convo.getConvoAvailability', {
  query: { members: [krao.did] },
})
const blockedStart = await call(stranger, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [krao.did] },
})
check(
  'accounts that only accept people they follow cannot be messaged by strangers',
  availability.data.canChat === false &&
    blockedStart.data.error === 'NotFollowedBySender',
  blockedStart.data.error,
)

await call(minh, 'chat.bsky.convo.leaveConvo', { body: { convoId } })
const afterLeave = await call(minh, 'chat.bsky.convo.listConvos')
await call(krao, 'chat.bsky.convo.sendMessage', {
  body: { convoId, message: { text: 'Còn đó không?' } },
})
const afterWrite = await call(minh, 'chat.bsky.convo.listConvos', {
  query: { status: 'request' },
})
check(
  'a left convo comes back as a request when the other side writes',
  !afterLeave.data.convos?.some((c) => c.id === convoId) &&
    afterWrite.data.convos?.some((c) => c.id === convoId),
)

/*
 * Groups
 */

const created = await call(krao, 'chat.bsky.group.createGroup', {
  body: { members: [minh.did, mai.did], name: 'Krao DAO' },
})
const groupId = created.data.convo?.id
check(
  'createGroup makes a group with the owner and members',
  created.ok &&
    created.data.convo.kind.name === 'Krao DAO' &&
    created.data.convo.kind.memberCount === 3,
  created.data.message,
)
const maiRequests = await call(mai, 'chat.bsky.convo.listConvoRequests')
check(
  'added members get the group as a request',
  maiRequests.data.requests?.some((r) => r.id === groupId),
)
await call(mai, 'chat.bsky.convo.acceptConvo', { body: { convoId: groupId } })

const groupMsg = await call(krao, 'chat.bsky.convo.sendMessage', {
  body: { convoId: groupId, message: { text: 'Chào cả nhà DAO' } },
})
const maiGroupMsgs = await call(mai, 'chat.bsky.convo.getMessages', {
  query: { convoId: groupId },
})
check(
  'members see the message and the system messages',
  groupMsg.ok &&
    maiGroupMsgs.data.messages?.some((m) => m.text === 'Chào cả nhà DAO') &&
    maiGroupMsgs.data.messages?.some(
      (m) => m.$type === 'chat.bsky.convo.defs#systemMessageView',
    ),
)

const notOwner = await call(minh, 'chat.bsky.group.editGroup', {
  body: { convoId: groupId, name: 'Hijacked' },
})
check(
  'only the owner can edit the group',
  notOwner.data.error === 'InsufficientRole',
  notOwner.data.error,
)

const link = await call(krao, 'chat.bsky.group.createJoinLink', {
  body: { convoId: groupId, joinRule: 'anyone' },
})
const code = link.data.joinLink?.code
check('createJoinLink returns a code', link.ok && /^[a-z2-7]{8}$/.test(code ?? ''))

const preview = await fetch(
  `${CHAT}/xrpc/chat.bsky.group.getJoinLinkPreviews?codes=${code}`,
).then((r) => r.json())
check(
  'join link previews are readable signed out',
  preview.joinLinkPreviews?.[0]?.name === 'Krao DAO' &&
    preview.joinLinkPreviews[0].memberCount === 3,
  JSON.stringify(preview).slice(0, 120),
)

const joined = await call(lan, 'chat.bsky.group.requestJoin', { body: { code } })
check(
  'anyone can join through an open link',
  joined.data.status === 'joined' && joined.data.convo?.kind.memberCount === 4,
  joined.data.message,
)

const removed = await call(krao, 'chat.bsky.group.removeMembers', {
  body: { convoId: groupId, members: [lan.did] },
})
const lanView = await call(lan, 'chat.bsky.convo.getConvo', {
  query: { convoId: groupId },
})
const rejoin = await call(lan, 'chat.bsky.group.requestJoin', { body: { code } })
check(
  'removed members lose the group and cannot rejoin by link',
  removed.data.convo?.kind.memberCount === 3 &&
    lanView.data.error === 'InvalidConvo' &&
    rejoin.data.error === 'UserKicked',
  `${lanView.data.error} ${rejoin.data.error}`,
)

await call(krao, 'chat.bsky.group.editJoinLink', {
  body: { convoId: groupId, requireApproval: true },
})
const pending = await call(stranger, 'chat.bsky.group.requestJoin', {
  body: { code },
})
const requests = await call(krao, 'chat.bsky.group.listJoinRequests', {
  query: { convoId: groupId },
})
const approved = await call(krao, 'chat.bsky.group.approveJoinRequest', {
  body: { convoId: groupId, member: stranger.did },
})
check(
  'join requests wait for the owner',
  pending.data.status === 'pending' &&
    requests.data.requests?.some((r) => r.requestedBy.did === stranger.did) &&
    approved.data.convo?.kind.memberCount === 4,
  `${pending.data.status} ${approved.data.message ?? ''}`,
)

await call(krao, 'chat.bsky.convo.lockConvo', { body: { convoId: groupId } })
const whileLocked = await call(minh, 'chat.bsky.convo.sendMessage', {
  body: { convoId: groupId, message: { text: 'nope' } },
})
await call(krao, 'chat.bsky.convo.unlockConvo', { body: { convoId: groupId } })
check(
  'nobody can post in a locked group',
  whileLocked.data.error === 'ConvoLocked',
  whileLocked.data.error,
)

const mutual = await call(krao, 'chat.bsky.group.listMutualGroups', {
  query: { subject: mai.did },
})
check(
  'listMutualGroups finds the shared group',
  mutual.data.convos?.some((c) => c.id === groupId),
)

const ownerLeave = await call(krao, 'chat.bsky.convo.leaveConvo', {
  body: { convoId: groupId },
})
const maiLeave = await call(mai, 'chat.bsky.convo.leaveConvo', {
  body: { convoId: groupId },
})
check(
  'members can leave, the owner cannot',
  ownerLeave.data.error === 'OwnerCannotLeave' && maiLeave.ok,
  ownerLeave.data.error,
)
done()
