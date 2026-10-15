// Compliance (M26): phone verification before posting and chat (Decree 147),
// one account per number, consent records and data exports (Decree 13),
// one-level referral rules, moderators reading gated content (with a log),
// and what account deletion clears. Needs the dev-env with phones required
// (the default) and the rewards log SMS driver.
import {
  ACCOUNTS,
  GATE,
  GATE_DID,
  INDEXER,
  PDS,
  SIGNUP_CODE,
  checker,
  createRecord,
  lastOtp,
  login,
  rewardsCall,
  serviceAuth,
  sleep,
  verifyPhone,
  xrpc,
} from './lib.mjs'

const CHAT = process.env.KRAO_CHAT_URL ?? 'http://localhost:2590'
const PUSH = process.env.KRAO_PUSH_URL ?? 'http://localhost:2593'
const PUSH_TOKEN =
  process.env.KRAO_PUSH_INTERNAL_TOKEN ?? 'krao-dev-push-internal-token'
const APPVIEW_DID =
  process.env.KRAO_APPVIEW_DID ?? 'did:plc:dw4kbjf5mn7nhenabiqpkyh3'
const PDS_ADMIN_PASSWORD = process.env.KRAO_PDS_ADMIN_PASSWORD ?? 'admin-pass'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)
const chatDid = (await (await fetch(`${CHAT}/_health`)).json()).did

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

/** A chat call through the PDS, the way the app makes it */
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

const post = (session, text) =>
  createRecord(session, 'app.bsky.feed.post', {
    text,
    createdAt: new Date().toISOString(),
  })

/** A fresh Vietnamese number in national form (0 and 9 digits) */
const nationalNumber = () =>
  `081${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

/*
 * Phone verification before posting and chat
 */

const ana = await signUp('ana')
const krao = await login(ACCOUNTS.krao)

const blocked = await post(ana, 'Hello before verifying')
check(
  'an account without a verified phone cannot post',
  blocked.status === 400 && blocked.data.error === 'PhoneVerificationRequired',
  JSON.stringify(blocked.data),
)
const blockedBatch = await xrpc(PDS, 'com.atproto.repo.applyWrites', {
  token: ana.accessJwt,
  body: {
    repo: ana.did,
    writes: [
      {
        $type: 'com.atproto.repo.applyWrites#create',
        collection: 'app.bsky.feed.post',
        value: {
          $type: 'app.bsky.feed.post',
          text: 'Through applyWrites',
          createdAt: new Date().toISOString(),
        },
      },
    ],
  },
})
check(
  'nor through applyWrites',
  blockedBatch.data.error === 'PhoneVerificationRequired',
  JSON.stringify(blockedBatch.data),
)
const profile = await createRecord(
  ana,
  'app.bsky.actor.profile',
  { displayName: 'Ana' },
  { rkey: 'self' },
)
check('other records are still allowed', profile.ok, profile.data.message)
const blockedChat = await chat(ana, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [krao.did] },
})
check(
  'nor start a chat',
  blockedChat.data.error === 'PhoneVerificationRequired',
  JSON.stringify(blockedChat.data),
)

const before = await rewardsCall(ana, 'net.krao.phone.getStatus')
check(
  'getStatus: not verified, codes available',
  before.data.verified === false && before.data.available === true,
  JSON.stringify(before.data),
)
const invalid = await rewardsCall(ana, 'net.krao.phone.requestCode', {
  body: { phone: '12345' },
})
check(
  'a number that is not E.164 is refused',
  invalid.data.error === 'InvalidPhone',
  invalid.data.error,
)

const number = nationalNumber()
const e164 = `+84${number.slice(1)}`
const sent = await rewardsCall(ana, 'net.krao.phone.requestCode', {
  body: { phone: number },
})
check(
  'requestCode takes a Vietnamese national number',
  sent.ok && Date.parse(sent.data.expiresAt) > Date.now(),
  JSON.stringify(sent.data),
)
const again = await rewardsCall(ana, 'net.krao.phone.requestCode', {
  body: { phone: number },
})
check('a second code within a minute is refused', again.status === 429)
const code = await lastOtp(ana.did)
const wrong = await rewardsCall(ana, 'net.krao.phone.verifyCode', {
  body: { phone: e164, code: code === '000000' ? '111111' : '000000' },
})
check(
  'a wrong code is refused',
  wrong.data.error === 'InvalidCode',
  wrong.data.error,
)
const verified = await rewardsCall(ana, 'net.krao.phone.verifyCode', {
  body: { phone: e164, code },
})
check(
  'the right code verifies the number, shown masked',
  verified.ok &&
    verified.data.verified === true &&
    verified.data.maskedPhone === `+84******${e164.slice(-3)}`,
  JSON.stringify(verified.data),
)

// The PDS keeps a "not verified" answer for up to 15 seconds
let posted
for (let i = 0; i < 25; i++) {
  posted = await post(ana, 'Hello after verifying')
  if (posted.ok || posted.data.error !== 'PhoneVerificationRequired') break
  await sleep(1000)
}
check('once verified, the account can post', posted.ok, posted.data.message)

const bao = await signUp('bao')
const taken = await rewardsCall(bao, 'net.krao.phone.requestCode', {
  body: { phone: e164 },
})
check(
  'a second account cannot verify the same number',
  taken.data.error === 'PhoneTaken',
  JSON.stringify(taken.data),
)

/*
 * Consent and data exports
 */

const consent = await rewardsCall(ana, 'net.krao.account.recordConsent', {
  body: { version: '2026-10-16', items: ['terms', 'privacy', 'phone'] },
})
check('recordConsent stores a consent', consent.ok, consent.data.message)
const badConsent = await rewardsCall(ana, 'net.krao.account.recordConsent', {
  body: { version: '2026-10-16', items: ['marketing'] },
})
check('unknown consent items are refused', badConsent.status === 400)
const consents = await rewardsCall(ana, 'net.krao.account.getConsent')
check(
  'getConsent lists it',
  consents.data.consents?.[0]?.version === '2026-10-16' &&
    consents.data.consents[0].items.includes('phone'),
  JSON.stringify(consents.data),
)

// Ana gets a personal code (as the Invite screen does), then exports
await rewardsCall(ana, 'net.krao.referral.getOverview')
const rewardsExport = await rewardsCall(ana, 'net.krao.account.exportData')
const rewardsData = rewardsExport.data.data ?? {}
check(
  'the rewards export has code, points, KYC, phone and consents',
  rewardsExport.ok &&
    rewardsExport.data.service === 'rewards' &&
    rewardsExport.data.did === ana.did &&
    ['referralCode', 'points', 'kyc', 'phone', 'consents'].every(
      (k) => k in rewardsData,
    ) &&
    rewardsData.phone.verified === true &&
    rewardsData.consents.length === 1,
  JSON.stringify(Object.keys(rewardsData)),
)
check(
  'it shows the number masked only',
  !JSON.stringify(rewardsExport.data).includes(e164.slice(3)),
)

const indexerExport = await xrpc(INDEXER, 'net.krao.account.exportData', {
  token: await serviceAuth(ana, 'net.krao.account.exportData', GATE_DID),
})
check(
  'the indexer export has wallets, tips, gate rules and gated content',
  indexerExport.ok &&
    indexerExport.data.service === 'indexer' &&
    ['wallets', 'tipsSent', 'tipsReceived', 'gateRules', 'gatedContent'].every(
      (k) => Array.isArray(indexerExport.data.data?.[k]),
    ),
  JSON.stringify(indexerExport.data),
)

const chatExport = await xrpc(CHAT, 'net.krao.account.exportData', {
  token: await serviceAuth(ana, 'net.krao.account.exportData', chatDid),
})
check(
  'the chat export has convos and messages',
  chatExport.ok &&
    chatExport.data.service === 'chat' &&
    Array.isArray(chatExport.data.data?.convos) &&
    Array.isArray(chatExport.data.data?.messages),
  JSON.stringify(chatExport.data),
)

/*
 * One-level referrals
 */

const admin = await login(ACCOUNTS.rewardsAdmin)
for (const beneficiary of ['referrer_l2', 'referrer2']) {
  const rule = await rewardsCall(admin, 'net.krao.rewards.admin.upsertRule', {
    body: {
      id: `e2e.level2.${stamp}`,
      version: 1,
      enabled: true,
      event: 'account.created',
      beneficiary,
      amount: 10,
      vesting: [],
    },
  })
  check(
    `a rule for ${beneficiary} is refused`,
    rule.status === 400 && rule.data.error === 'MultiLevelReferral',
    JSON.stringify(rule.data),
  )
}
const rules = await rewardsCall(admin, 'net.krao.rewards.admin.listRules')
const inviter = rules.data.rules?.find((r) => r.id === 'referral.inviter')
check(
  'the default inviter rule has a daily cap',
  inviter?.capPerDay > 0,
  JSON.stringify(inviter),
)

/*
 * Moderators reading gated content
 */

const gated = (await post(krao, '🔒 Chỉ cho holder')).data
const secret = `Nội dung gate ${stamp}`
await xrpc(GATE, 'net.krao.gate.putContent', {
  token: await serviceAuth(krao, 'net.krao.gate.putContent'),
  body: { uri: gated.uri, text: secret },
})
const modRead = await xrpc(GATE, 'net.krao.gate.moderation.getContent', {
  token: await serviceAuth(admin, 'net.krao.gate.moderation.getContent'),
  query: { uri: gated.uri, reason: `e2e report ${stamp}` },
})
check(
  'a moderator reads gated content',
  modRead.ok && modRead.data.text === secret,
  JSON.stringify(modRead.data),
)
const accessLog = await xrpc(GATE, 'net.krao.gate.moderation.listAccessLog', {
  token: await serviceAuth(admin, 'net.krao.gate.moderation.listAccessLog'),
  query: { uri: gated.uri },
})
check(
  'the read is in the access log',
  accessLog.data.entries?.some(
    (e) => e.moderator === admin.did && e.reason === `e2e report ${stamp}`,
  ),
  JSON.stringify(accessLog.data),
)
for (const [name, session, method] of [
  ['getContent', ana, 'net.krao.gate.moderation.getContent'],
  ['listAccessLog', ana, 'net.krao.gate.moderation.listAccessLog'],
]) {
  const res = await xrpc(GATE, method, {
    token: await serviceAuth(session, method),
    query: { uri: gated.uri },
  })
  check(`others get a 403 from ${name}`, res.status === 403, res.data.error)
}

/*
 * Account deletion clears phone (the number is free again), push devices
 * and chat messages
 */

const cam = await signUp('cam')
const camNumber = nationalNumber()
await verifyPhone(cam, camNumber)
await xrpc(PDS, 'app.bsky.notification.registerPush', {
  token: cam.accessJwt,
  body: {
    serviceDid: APPVIEW_DID,
    token: `e2e-cam-${stamp}`,
    platform: 'ios',
    appId: 'io.krao.app',
  },
})
// Cam follows Krao, so Krao may message Cam; Cam answers
await createRecord(cam, 'app.bsky.graph.follow', {
  subject: krao.did,
  createdAt: new Date().toISOString(),
})
await sleep(1500)
const camConvo = await chat(krao, 'chat.bsky.convo.getConvoForMembers', {
  query: { members: [cam.did] },
})
const camText = `Tin nhắn của Cam ${stamp}`
const camConvoId = camConvo.data.convo?.id
await chat(krao, 'chat.bsky.convo.sendMessage', {
  body: { convoId: camConvoId, message: { text: 'Chào Cam' } },
})
const camSent = await chat(cam, 'chat.bsky.convo.sendMessage', {
  body: { convoId: camConvoId, message: { text: camText } },
})
check('Cam sends a message', camSent.ok, JSON.stringify(camSent.data))
const devices = async () => {
  const res = await fetch(`${PUSH}/internal/devices?did=${cam.did}`, {
    headers: { authorization: `Bearer ${PUSH_TOKEN}` },
  })
  return (await res.json()).count
}
check('Cam has a push device', (await devices()) === 1)

const deleted = await fetch(`${PDS}/xrpc/com.atproto.admin.deleteAccount`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`admin:${PDS_ADMIN_PASSWORD}`).toString('base64')}`,
  },
  body: JSON.stringify({ did: cam.did }),
})
check('an admin deletes Cam', deleted.ok, String(deleted.status))

// The PDS reports deletions to rewards some seconds later
let freed
for (let i = 0; i < 40; i++) {
  freed = await rewardsCall(bao, 'net.krao.phone.requestCode', {
    body: { phone: camNumber },
  })
  if (freed.ok || freed.data.error !== 'PhoneTaken') break
  await sleep(1000)
}
check(
  "the deleted account's number is free again",
  freed.ok,
  JSON.stringify(freed.data),
)
check('its push devices are gone', (await devices()) === 0)
const kraoView = await chat(krao, 'chat.bsky.convo.getMessages', {
  query: { convoId: camConvoId },
})
check(
  'its chat messages are wiped',
  kraoView.ok &&
    !JSON.stringify(kraoView.data.messages ?? []).includes(camText),
  JSON.stringify(kraoView.data).slice(0, 300),
)

done()
