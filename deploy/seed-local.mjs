#!/usr/bin/env node
/*
 * Seed web3-themed sample data into the local atproto dev-env.
 * The dev-env wipes its data on restart, so run this again after each restart.
 *
 *   node scripts/seed-local.mjs [pdsUrl] [--prefs-only]
 *
 * The Krao indexer is expected at KRAO_INDEXER_URL (default
 * http://localhost:2589). All accounts below are local test accounts
 * (password: krao-dev-pass). Each gets a test phone number verified with the
 * rewards service (KRAO_REWARDS_URL), whose dev-env codes are readable.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Brand values (name, domain): the one source, see DESIGN-brand.md */
const BRAND = JSON.parse(
  readFileSync(
    new URL('../packages/krao-brand/brand.json', import.meta.url),
    'utf8',
  ),
)

const PDS =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ||
  'http://localhost:2583'
const INDEXER = process.env.KRAO_INDEXER_URL || 'http://localhost:2589'
const REWARDS = process.env.KRAO_REWARDS_URL || 'http://localhost:2592'
const REWARDS_DID = process.env.KRAO_REWARDS_DID || 'did:web:rewards.krao.test'
/** The dev-env's PDS <-> rewards token */
const REWARDS_TOKEN =
  process.env.KRAO_REWARDS_INTERNAL_TOKEN || 'krao-dev-rewards-token'
const PASSWORD = 'krao-dev-pass'

const USERS = [
  {
    handle: 'krao.test',
    displayName: `${BRAND.name} Network`,
    description: 'Mạng xã hội phi tập trung cho cộng đồng web3 🌐',
  },
  {
    handle: 'defi-minh.test',
    displayName: 'Minh DeFi',
    description:
      'Yield farmer. Theo dõi các protocol DeFi trên Ethereum và Base.',
  },
  {
    handle: 'nft-lan.test',
    displayName: 'Lan NFT Art',
    description: 'Digital artist. Mint tác phẩm generative art on-chain.',
  },
  {
    handle: 'dev-hung.test',
    displayName: 'Hùng Solidity',
    description: 'Smart contract dev. Audit, gas optimization, ZK.',
  },
  {
    handle: 'dao-mai.test',
    displayName: 'Mai DAO',
    description: 'Governance nerd. Contributor tại nhiều DAO.',
  },
]

const POSTS = {
  'krao.test': [
    `Chào mừng đến với ${BRAND.name} Network! Mạng xã hội phi tập trung trên AT Protocol, dành cho cộng đồng web3. #${BRAND.name} #web3`,
    `Đã có trên ${BRAND.name}: đăng nhập bằng ví, tip bằng token, avatar NFT có xác minh và nội dung giới hạn theo token. Bạn thích tính năng nào nhất? #${BRAND.name} #web3`,
  ],
  'defi-minh.test': [
    'Gas trên Base hôm nay rẻ bất ngờ. Đã rebalance xong LP position, phí còn chưa tới 0.01 USD. #Base #DeFi',
    'Nhắc nhẹ: APY cao bất thường thường đi kèm rủi ro cao bất thường. Luôn đọc audit report trước khi deposit.',
    'Restaking đang là narrative lớn nhất quý này. Mọi người đang dùng protocol nào? #DeFi',
  ],
  'nft-lan.test': [
    'Vừa mint xong collection generative art đầu tiên, 100% on-chain SVG. Mỗi tác phẩm được sinh từ block hash lúc mint. #NFT',
    `Ước gì có thể dùng NFT làm avatar ở đây và được xác minh quyền sở hữu thật sự. ${BRAND.name} làm được không?`,
  ],
  'dev-hung.test': [
    'Tip tối ưu gas: dùng custom errors thay cho require string. Tiết kiệm đáng kể khi deploy lẫn khi revert.',
    'Đang thử nghiệm Sign-In With Ethereum (EIP-4361) để liên kết ví với DID trên AT Protocol. Ý tưởng khá hay!',
    'Reentrancy vẫn là lỗi kinh điển. Checks-Effects-Interactions, đừng bao giờ quên. #Solidity',
  ],
  'dao-mai.test': [
    'Proposal mới về phân bổ treasury đã lên snapshot. Voting kết thúc sau 3 ngày, mọi người nhớ vote nhé. #DAO #web3',
    `Token-gated discussion sẽ giúp DAO thảo luận nội bộ mà vẫn ở trên một mạng mở. Rất mong ${BRAND.name} có tính năng này.`,
  ],
}

const FOLLOWS = {
  'krao.test': [
    'defi-minh.test',
    'nft-lan.test',
    'dev-hung.test',
    'dao-mai.test',
  ],
  'defi-minh.test': [
    'krao.test',
    'dev-hung.test',
    'dao-mai.test',
    'alice.test',
  ],
  'nft-lan.test': ['krao.test', 'dev-hung.test', 'bob.test'],
  'dev-hung.test': ['krao.test', 'defi-minh.test', 'nft-lan.test'],
  'dao-mai.test': ['krao.test', 'defi-minh.test', 'dev-hung.test'],
  'alice.test': [
    'krao.test',
    'defi-minh.test',
    'nft-lan.test',
    'dev-hung.test',
    'dao-mai.test',
  ],
}

/** Tag facets for the #hashtags in `text` (byte offsets, as atproto wants) */
function tagFacets(text) {
  const facets = []
  for (const match of text.matchAll(/#(\w+)/g)) {
    const byteStart = Buffer.byteLength(text.slice(0, match.index))
    facets.push({
      index: { byteStart, byteEnd: byteStart + Buffer.byteLength(match[0]) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: match[1] }],
    })
  }
  return facets
}

async function xrpc(method, { token, body, query } = {}) {
  const url = new URL(`/xrpc/${method}`, PDS)
  if (query)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(
      `${method}: ${data.error ?? res.status} ${data.message ?? ''}`,
    )
    err.code = data.error
    throw err
  }
  return data
}

async function login(handle, password) {
  return xrpc('com.atproto.server.createSession', {
    body: { identifier: handle, password },
  })
}

async function ensureAccount(user) {
  try {
    return await xrpc('com.atproto.server.createAccount', {
      body: {
        handle: user.handle,
        email: `${user.handle.split('.')[0]}@krao.test`,
        password: PASSWORD,
        // Sign-up needs a referral code: the dev-env's campaign code
        inviteCode: process.env.KRAO_SIGNUP_CODE ?? 'KRAO-DEV',
      },
    })
  } catch (e) {
    if (!/already|taken|unavailable/i.test(e.message)) throw e
    return login(user.handle, PASSWORD)
  }
}

function createRecord(session, collection, record) {
  return xrpc('com.atproto.repo.createRecord', {
    token: session.accessJwt,
    body: { repo: session.did, collection, record },
  })
}

const now = () => new Date().toISOString()

/** A test number per account: +849 and 8 digits from its DID */
function testPhone(did) {
  const n = createHash('sha256').update(did).digest().readUInt32BE(0) % 1e8
  return `+849${String(n).padStart(8, '0')}`
}

/**
 * Posting needs a verified phone (Decree 147): request a code, read it from
 * the dev-env rewards service, verify. Skipped where codes are not readable.
 */
async function verifyPhone(session) {
  const call = async (method, body) => {
    const { token } = await xrpc('com.atproto.server.getServiceAuth', {
      token: session.accessJwt,
      query: { aud: REWARDS_DID, lxm: method },
    })
    const res = await fetch(`${REWARDS}/xrpc/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${method}: ${data.error ?? res.status}`)
    return data
  }
  try {
    const status = await call('net.krao.phone.getStatus')
    if (status.verified || !status.available) return
    const phone = testPhone(session.did)
    await call('net.krao.phone.requestCode', { phone })
    const res = await fetch(
      `${REWARDS}/internal/dev/last-otp?did=${encodeURIComponent(session.did)}`,
      { headers: { authorization: `Bearer ${REWARDS_TOKEN}` } },
    )
    if (!res.ok) return
    const { code } = await res.json()
    await call('net.krao.phone.verifyCode', { phone, code })
  } catch (err) {
    console.log(
      `⚠️  ${session.handle}: chưa xác thực số điện thoại (${err.message})`,
    )
  }
}

/** Skips the app's age assurance prompt for test accounts. */
async function setBirthDate(session) {
  const { preferences } = await xrpc('app.bsky.actor.getPreferences', {
    token: session.accessJwt,
  })
  await xrpc('app.bsky.actor.putPreferences', {
    token: session.accessJwt,
    body: {
      preferences: [
        ...preferences.filter(
          (p) => p.$type !== 'app.bsky.actor.defs#personalDetailsPref',
        ),
        {
          $type: 'app.bsky.actor.defs#personalDetailsPref',
          birthDate: '1995-01-01T00:00:00.000Z',
        },
      ],
    },
  })
}

/**
 * Krao's feeds: feed generator records in krao.test's repo, served by the
 * Krao indexer. "popular" is the app's Discover feed, found by handle as
 * at://krao.test/app.bsky.feed.generator/popular; "latest" lists everything
 * newest first; "vietnamese" ("Tiếng Việt") lists Vietnamese posts newest
 * first; "holders-usdc" and "holders-eth" list posts of token holders.
 */
const FEEDS = [
  {
    rkey: 'popular',
    displayName: 'Nổi bật',
    description: `Bài được thích và đăng lại nhiều trong tuần trên ${BRAND.name}.`,
  },
  {
    rkey: 'latest',
    displayName: 'Mới nhất',
    description: `Bài mới nhất từ cộng đồng ${BRAND.name}.`,
  },
  {
    rkey: 'vietnamese',
    displayName: 'Tiếng Việt',
    description: `Bài viết tiếng Việt mới nhất trên ${BRAND.name}.`,
  },
  // "Holders of $X" (M33): posts of accounts whose verified wallets hold the
  // token; the rkey is holders-<symbol in lower case>
  {
    rkey: 'holders-usdc',
    displayName: 'Người giữ $USDC',
    description:
      'Bài mới nhất của những người đang giữ USDC trong ví đã xác minh.',
  },
  {
    rkey: 'holders-eth',
    displayName: 'Người giữ $ETH',
    description:
      'Bài mới nhất của những người đang giữ ETH trong ví đã xác minh.',
  },
]

async function publishFeeds(session) {
  const res = await fetch(
    `${INDEXER}/xrpc/app.bsky.feed.describeFeedGenerator`,
  ).catch(() => null)
  if (!res?.ok) {
    console.log('⚠️  Krao indexer chưa phục vụ feed, bỏ qua các feed Krao')
    return
  }
  const { did } = await res.json()
  for (const feed of FEEDS) {
    await xrpc('com.atproto.repo.putRecord', {
      token: session.accessJwt,
      body: {
        repo: session.did,
        collection: 'app.bsky.feed.generator',
        rkey: feed.rkey,
        record: {
          $type: 'app.bsky.feed.generator',
          did,
          displayName: feed.displayName,
          description: feed.description,
          createdAt: now(),
        },
      },
    })
    console.log(`📰 Feed "${feed.displayName}" (${did})`)
  }
}

/**
 * The dev-env's trusted verifier (krao-verify.test) verifies krao.test, so
 * the official account shows the blue check. The record names the subject's
 * handle and display name, which must stay as they are for it to count.
 */
async function verifyOfficialAccount(subject, user) {
  // The dev-env creates krao-verify.test a little after its services answer
  let verifier = null
  for (let i = 0; i < 15 && !verifier; i++) {
    verifier = await login('krao-verify.test', PASSWORD).catch(() => null)
    if (!verifier) await new Promise((r) => setTimeout(r, 2000))
  }
  if (!verifier) {
    console.log(
      '⚠️  Không có krao-verify.test (dev-env cũ?), bỏ qua huy hiệu xác minh',
    )
    return
  }
  await xrpc('com.atproto.repo.putRecord', {
    token: verifier.accessJwt,
    body: {
      repo: verifier.did,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record: {
        $type: 'app.bsky.actor.profile',
        displayName: `${BRAND.name} Verify`,
        description: `Tài khoản xác minh chính thức của ${BRAND.name}.`,
      },
    },
  })
  const { records } = await xrpc('com.atproto.repo.listRecords', {
    query: {
      repo: verifier.did,
      collection: 'app.bsky.graph.verification',
      limit: 100,
    },
  })
  if (records.some((r) => r.value.subject === subject.did)) return
  await createRecord(verifier, 'app.bsky.graph.verification', {
    $type: 'app.bsky.graph.verification',
    subject: subject.did,
    handle: user.handle,
    displayName: user.displayName,
    createdAt: now(),
  })
  console.log(`☑️  ${user.handle} được krao-verify.test xác minh`)
}

/**
 * Krao's sample Mini App (M34), served by the dev-env at :2595: registered
 * in krao.test's repo, approved by the dev-env's safety admin
 * (rewards-admin.test) and shown in a post of krao.test. Done once per
 * dev-env run: an unchanged record is left alone.
 */
const MINIAPP_URL =
  process.env.KRAO_MINIAPP_SAMPLE_URL || 'http://localhost:2595/'
const GATE_DID = process.env.KRAO_GATE_DID || 'did:web:gate.krao.test'
// A 1x1 PNG, enough for the icon proxy
const MINIAPP_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function seedMiniApp(session) {
  const rkey = 'bo-phieu-nhanh'
  const existing = await xrpc('com.atproto.repo.getRecord', {
    query: { repo: session.did, collection: 'net.krao.miniapp.app', rkey },
  }).catch(() => null)
  let ref = existing && { uri: existing.uri, cid: existing.cid }
  if (!existing || existing.value.url !== MINIAPP_URL) {
    const upload = await fetch(
      new URL('/xrpc/com.atproto.repo.uploadBlob', PDS),
      {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          authorization: `Bearer ${session.accessJwt}`,
        },
        body: MINIAPP_ICON,
      },
    ).then((res) => res.json())
    ref = await xrpc('com.atproto.repo.putRecord', {
      token: session.accessJwt,
      body: {
        repo: session.did,
        collection: 'net.krao.miniapp.app',
        rkey,
        record: {
          $type: 'net.krao.miniapp.app',
          name: 'Bỏ phiếu nhanh',
          description: `Mini App mẫu của ${BRAND.name}: biết bạn là ai, kết nối ví, ký phiếu và ủng hộ bằng ETH.`,
          url: MINIAPP_URL,
          ...(upload.blob ? { icon: upload.blob } : {}),
          permissions: ['identity', 'wallet', 'sign', 'transaction'],
          chains: ['eip155:8453'],
          createdAt: now(),
        },
      },
    })
  }

  // Approved by the safety admin, once the indexer has the record
  const admin = await login('rewards-admin.test', PASSWORD).catch(() => null)
  if (!admin) {
    console.log('⚠️  Không có rewards-admin.test, Mini App mẫu chưa được duyệt')
    return
  }
  let app
  for (let i = 0; i < 20; i++) {
    const res = await fetch(
      `${INDEXER}/xrpc/net.krao.miniapp.getApp?uri=${encodeURIComponent(ref.uri)}`,
    ).catch(() => null)
    app = res?.ok ? (await res.json()).app : undefined
    if (app?.cid === ref.cid) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (app?.cid !== ref.cid) {
    console.log('⚠️  Indexer chưa thấy Mini App mẫu, bỏ qua bước duyệt')
    return
  }
  if (app.status !== 'approved') {
    const method = 'net.krao.miniapp.admin.approve'
    const { token } = await xrpc('com.atproto.server.getServiceAuth', {
      token: admin.accessJwt,
      query: { aud: GATE_DID, lxm: method },
    })
    const res = await fetch(`${INDEXER}/xrpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ uri: ref.uri, cid: ref.cid }),
    })
    if (!res.ok) {
      console.log(`⚠️  Duyệt Mini App mẫu lỗi: ${(await res.json()).message}`)
      return
    }
  }

  // One post per dev-env run showing it
  if (app.status !== 'approved') {
    await createRecord(session, 'app.bsky.feed.post', {
      $type: 'app.bsky.feed.post',
      text: `Thử Mini App đầu tiên trên ${BRAND.name}: Bỏ phiếu nhanh 🗳️`,
      langs: ['vi'],
      embed: {
        $type: 'net.krao.embed.miniapp',
        app: { uri: ref.uri, cid: ref.cid },
      },
      createdAt: now(),
    })
  }
  console.log(`🧩 Mini App "Bỏ phiếu nhanh" (${ref.uri}) đã duyệt`)
}

async function main() {
  await xrpc('com.atproto.server.describeServer').catch(() => {
    throw new Error(`Không kết nối được PDS tại ${PDS}. Dev-env đã chạy chưa?`)
  })

  const sessions = {}
  for (const user of USERS) {
    const s = await ensureAccount(user)
    sessions[user.handle] = s
    await xrpc('com.atproto.repo.putRecord', {
      token: s.accessJwt,
      body: {
        repo: s.did,
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: {
          $type: 'app.bsky.actor.profile',
          displayName: user.displayName,
          description: user.description,
        },
      },
    })
    // Anyone may message the demo accounts; without a declaration only the
    // accounts they follow can, so a new account could message no one
    await xrpc('com.atproto.repo.putRecord', {
      token: s.accessJwt,
      body: {
        repo: s.did,
        collection: 'chat.bsky.actor.declaration',
        rkey: 'self',
        record: {
          $type: 'chat.bsky.actor.declaration',
          allowIncoming: 'all',
        },
      },
    })
    await setBirthDate(s)
    await verifyPhone(s)
    console.log(`👤 ${user.handle} (${s.did})`)
  }
  // alice.test is created by the dev-env mock setup
  sessions['alice.test'] = await login('alice.test', 'hunter2').catch(
    () => null,
  )
  if (sessions['alice.test']) {
    await setBirthDate(sessions['alice.test'])
    await verifyPhone(sessions['alice.test'])
  }
  await publishFeeds(sessions['krao.test'])
  await verifyOfficialAccount(sessions['krao.test'], USERS[0])
  // The krao.net demo does not expose the sample's port: no broken embed there
  if (process.env.KRAO_SEED_MINIAPP !== 'false') {
    await seedMiniApp(sessions['krao.test']).catch((err) =>
      console.log(`⚠️  Mini App mẫu: ${err.message}`),
    )
  }
  if (process.argv.includes('--prefs-only')) return

  const posts = []
  for (const [handle, texts] of Object.entries(POSTS)) {
    for (const text of texts) {
      const ref = await createRecord(sessions[handle], 'app.bsky.feed.post', {
        $type: 'app.bsky.feed.post',
        text,
        facets: tagFacets(text),
        langs: ['vi'],
        createdAt: now(),
      })
      posts.push({ handle, ...ref })
    }
  }
  console.log(`📝 ${posts.length} bài viết`)

  let follows = 0
  for (const [handle, targets] of Object.entries(FOLLOWS)) {
    if (!sessions[handle]) continue
    for (const target of targets) {
      const t = sessions[target]
      const did =
        t?.did ??
        (
          await xrpc('com.atproto.identity.resolveHandle', {
            query: { handle: target },
          })
        ).did
      await createRecord(sessions[handle], 'app.bsky.graph.follow', {
        $type: 'app.bsky.graph.follow',
        subject: did,
        createdAt: now(),
      })
      follows++
    }
  }
  console.log(`🤝 ${follows} lượt follow`)

  let likes = 0
  for (const [i, post] of posts.entries()) {
    for (const [j, handle] of Object.keys(sessions).entries()) {
      if (handle === post.handle || !sessions[handle] || (i + j) % 2) continue
      await createRecord(sessions[handle], 'app.bsky.feed.like', {
        $type: 'app.bsky.feed.like',
        subject: { uri: post.uri, cid: post.cid },
        createdAt: now(),
      })
      likes++
    }
  }
  console.log(`❤️  ${likes} lượt thích`)

  const replies = [
    [
      'nft-lan.test',
      'krao.test',
      1,
      'Avatar NFT có xác minh! Mình chờ cái này lâu lắm rồi 🎨',
    ],
    [
      'dev-hung.test',
      'krao.test',
      1,
      'Đăng nhập bằng ví + SIWE, mình sẵn sàng đóng góp code.',
    ],
    [
      'dao-mai.test',
      'defi-minh.test',
      1,
      'Chuẩn! DYOR luôn là nguyên tắc số 1.',
    ],
  ]
  for (const [author, target, idx, text] of replies) {
    const parent = posts.filter((p) => p.handle === target)[idx]
    const ref = { uri: parent.uri, cid: parent.cid }
    await createRecord(sessions[author], 'app.bsky.feed.post', {
      $type: 'app.bsky.feed.post',
      text,
      langs: ['vi'],
      reply: { root: ref, parent: ref },
      createdAt: now(),
    })
  }
  console.log(`💬 ${replies.length} trả lời`)

  console.log(
    `\n✅ Xong. Đăng nhập app với một trong các handle trên, mật khẩu: ${PASSWORD}`,
  )
}

main().catch((e) => {
  console.error('❌', e.message)
  process.exit(1)
})
