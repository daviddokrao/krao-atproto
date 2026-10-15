// Smoke test of a rehearsal stack, through Caddy and TLS like the app:
//   smoke.mjs create  sign up, post, follow, like, chat, push, gated media
//   smoke.mjs verify  after a restore: the same data is still there
// State between the two goes to /backups/smoke-state.json.
import fs from 'node:fs'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'

const D = process.env.KRAO_DOMAIN
const host = (name) => `https://${name}.${D}`
const PDS = host('pds')
const API = host('api')
const STATE = '/backups/smoke-state.json'
const mode = process.argv[2]

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function xrpc(base, method, { token, body, query, headers } = {}) {
  const url = new URL(`/xrpc/${method}`, base)
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) }
}

async function waitFor(fn, ms = 30_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => null)
    if (value || Date.now() > until) return value
    await sleep(500)
  }
}

const create = async (s, collection, record, rkey) => {
  const res = await xrpc(PDS, 'com.atproto.repo.createRecord', {
    token: s.accessJwt,
    body: {
      repo: s.did,
      collection,
      rkey,
      record: { $type: collection, createdAt: new Date().toISOString(), ...record },
    },
  })
  if (!res.ok) throw new Error(`${collection}: ${JSON.stringify(res.data)}`)
  return res.data
}

const chatDid = `did:web:chat.${D}`
const chat = (s, method, opts = {}) =>
  xrpc(PDS, method, {
    ...opts,
    token: s.accessJwt,
    headers: { 'atproto-proxy': `${chatDid}#bsky_chat` },
  })

const serviceAuth = async (s, aud, lxm) =>
  (
    await xrpc(PDS, 'com.atproto.server.getServiceAuth', {
      token: s.accessJwt,
      query: { aud, lxm },
    })
  ).data.token

if (mode === 'create') {
  for (const name of ['pds', 'api', 'idx', 'chat', 'video', 'rewards']) {
    const path = name === 'pds' || name === 'api' ? '/xrpc/_health' : '/_health'
    const res = await fetch(`${host(name)}${path}`).catch((e) => e)
    check(`${name}.${D} is up over TLS`, res.ok, String(res.status ?? res))
  }
  const ozone = await fetch(`${host('mod')}/xrpc/_health`).catch((e) => e)
  check('Ozone is up', ozone.ok, String(ozone.status ?? ozone))

  const stamp = Date.now().toString(36).slice(-5)
  const signUp = async (name) => {
    const handle = `${name}${stamp}.${D}`
    const res = await xrpc(PDS, 'com.atproto.server.createAccount', {
      body: {
        handle,
        email: `${name}${stamp}@example.com`,
        password: 'rehearsal-pass',
        inviteCode: process.env.KRAO_REWARDS_BOOTSTRAP_CODE,
      },
    })
    check(`${name} signs up with the bootstrap code`, res.ok, JSON.stringify(res.data))
    await create(res.data, 'app.bsky.actor.profile', { displayName: name }, 'self')
    return res.data
  }
  const ana = await signUp('ana')
  const bao = await signUp('bao')

  // Push: Ana's device, through PDS → AppView → krao-push
  const reg = await xrpc(PDS, 'app.bsky.notification.registerPush', {
    token: ana.accessJwt,
    body: {
      serviceDid: `did:web:api.${D}`,
      token: `rehearsal-${stamp}`,
      platform: 'android',
      appId: 'io.krao.app',
    },
  })
  check('a device token registers through the AppView', reg.ok, JSON.stringify(reg.data))

  const post = await create(ana, 'app.bsky.feed.post', { text: 'First post on Krao' })
  await create(bao, 'app.bsky.graph.follow', { subject: ana.did })
  await create(ana, 'app.bsky.graph.follow', { subject: bao.did })
  await create(bao, 'app.bsky.feed.like', { subject: { uri: post.uri, cid: post.cid } })

  const indexed = await waitFor(async () => {
    const res = await xrpc(API, 'app.bsky.feed.getPosts', { query: { uris: post.uri } })
    return res.data.posts?.[0]?.likeCount === 1 ? res.data.posts[0] : null
  })
  check('the AppView indexes the post and the like', !!indexed)

  const pushed = await waitFor(async () => {
    const res = await fetch('http://push:2593/internal/recent', {
      headers: { authorization: `Bearer ${process.env.KRAO_PUSH_INTERNAL_TOKEN}` },
    })
    const { sent } = await res.json()
    return sent.find((s) => s.token === `rehearsal-${stamp}` && s.msg.data.reason === 'like')
  })
  check('the like is pushed to Ana', pushed?.msg.title === 'bao liked your post', JSON.stringify(pushed))

  const convo = await chat(bao, 'chat.bsky.convo.getConvoForMembers', {
    query: { members: [ana.did] },
  })
  check('chat works through the PDS and did:web', convo.ok, JSON.stringify(convo.data))
  const sent = await chat(bao, 'chat.bsky.convo.sendMessage', {
    body: { convoId: convo.data.convo?.id, message: { text: 'Hello Ana' } },
  })
  check('a chat message is sent', sent.ok, JSON.stringify(sent.data))

  // Gated media goes to the S3 bucket
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  const gateToken = await serviceAuth(ana, `did:web:idx.${D}`, 'net.krao.gate.uploadMedia')
  const upload = await fetch(`${host('idx')}/xrpc/net.krao.gate.uploadMedia`, {
    method: 'POST',
    headers: { authorization: `Bearer ${gateToken}`, 'content-type': 'image/png' },
    body: png,
  })
  const media = await upload.json().catch(() => ({}))
  check('gated media uploads', upload.ok, JSON.stringify(media))
  const id = new URL(media.media?.url ?? 'http://x/').pathname.split('/').pop()
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint: process.env.KRAO_GATE_MEDIA_S3_ENDPOINT,
    forcePathStyle: true,
  })
  const head = await s3
    .send(new HeadObjectCommand({ Bucket: process.env.KRAO_GATE_MEDIA_S3_BUCKET, Key: `gate-media/${id}` }))
    .catch((e) => e)
  check('its bytes are in the S3 bucket', head.ContentLength === png.length, String(head))

  const rewardsToken = await serviceAuth(ana, `did:web:rewards.${D}`, 'net.krao.referral.getOverview')
  const overview = await xrpc(host('rewards'), 'net.krao.referral.getOverview', {
    token: rewardsToken,
  })
  check('rewards gave Ana a personal code', /^[2-9A-Z]{8}$/.test(overview.data.code ?? ''), JSON.stringify(overview.data))

  fs.writeFileSync(
    STATE,
    JSON.stringify({ ana: ana.handle, bao: bao.handle, post: post.uri, convoId: convo.data.convo?.id, mediaId: id }),
  )
} else if (mode === 'verify') {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const login = await xrpc(PDS, 'com.atproto.server.createSession', {
    body: { identifier: state.ana, password: 'rehearsal-pass' },
  })
  check('Ana logs in after the restore', login.ok, JSON.stringify(login.data))
  const posts = await waitFor(async () => {
    const res = await xrpc(API, 'app.bsky.feed.getPosts', { query: { uris: state.post } })
    return res.data.posts?.[0]?.likeCount === 1 ? res.data.posts : null
  })
  check('her post and its like are back in the AppView', !!posts)
  const convo = await chat(login.data, 'chat.bsky.convo.getConvo', {
    query: { convoId: state.convoId },
  })
  check(
    'the chat is back',
    convo.ok && convo.data.convo?.lastMessage?.text === 'Hello Ana',
    JSON.stringify(convo.data),
  )
  const recent = await fetch(`${host('idx')}/_health`).then((r) => r.json())
  check('the indexer kept its firehose cursor', recent.firehoseSeq > 0, JSON.stringify(recent))
} else {
  console.error('Usage: smoke.mjs create|verify')
  process.exit(2)
}

console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
process.exit(failed ? 1 : 0)
