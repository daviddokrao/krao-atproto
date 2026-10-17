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
    displayName: 'Krao Network',
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
    'Chào mừng đến với Krao Network! Mạng xã hội phi tập trung trên AT Protocol, dành cho cộng đồng web3. #Krao #web3',
    'Đã có trên Krao: đăng nhập bằng ví, tip bằng token, avatar NFT có xác minh và nội dung giới hạn theo token. Bạn thích tính năng nào nhất? #Krao #web3',
  ],
  'defi-minh.test': [
    'Gas trên Base hôm nay rẻ bất ngờ. Đã rebalance xong LP position, phí còn chưa tới 0.01 USD. #Base #DeFi',
    'Nhắc nhẹ: APY cao bất thường thường đi kèm rủi ro cao bất thường. Luôn đọc audit report trước khi deposit.',
    'Restaking đang là narrative lớn nhất quý này. Mọi người đang dùng protocol nào? #DeFi',
  ],
  'nft-lan.test': [
    'Vừa mint xong collection generative art đầu tiên, 100% on-chain SVG. Mỗi tác phẩm được sinh từ block hash lúc mint. #NFT',
    'Ước gì có thể dùng NFT làm avatar ở đây và được xác minh quyền sở hữu thật sự. Krao làm được không?',
  ],
  'dev-hung.test': [
    'Tip tối ưu gas: dùng custom errors thay cho require string. Tiết kiệm đáng kể khi deploy lẫn khi revert.',
    'Đang thử nghiệm Sign-In With Ethereum (EIP-4361) để liên kết ví với DID trên AT Protocol. Ý tưởng khá hay!',
    'Reentrancy vẫn là lỗi kinh điển. Checks-Effects-Interactions, đừng bao giờ quên. #Solidity',
  ],
  'dao-mai.test': [
    'Proposal mới về phân bổ treasury đã lên snapshot. Voting kết thúc sau 3 ngày, mọi người nhớ vote nhé. #DAO #web3',
    'Token-gated discussion sẽ giúp DAO thảo luận nội bộ mà vẫn ở trên một mạng mở. Rất mong Krao có tính năng này.',
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
 * newest first.
 */
const FEEDS = [
  {
    rkey: 'popular',
    displayName: 'Nổi bật',
    description: 'Bài được thích và đăng lại nhiều trong tuần trên Krao.',
  },
  {
    rkey: 'latest',
    displayName: 'Mới nhất',
    description: 'Bài mới nhất từ cộng đồng Krao.',
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
  const verifier = await login('krao-verify.test', PASSWORD).catch(() => null)
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
        displayName: 'Krao Verify',
        description: 'Tài khoản xác minh chính thức của Krao.',
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
