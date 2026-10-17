// Safety, part 2 (M35): impersonation of verified accounts labeled and
// reported in Krao's Ozone (and unlabeled), unified admin roles that reach
// the indexer, the shared admin log, and the PLC mirror the dev-env
// resolves DIDs through. Needs the dev-env (krao-verify.test,
// rewards-admin.test) and the seed script's data.
import { deflateSync } from 'node:zlib'
import {
  ACCOUNTS,
  GATE_DID,
  INDEXER,
  PDS,
  SIGNUP_CODE,
  checker,
  createRecord,
  login,
  putRecord,
  rewardsCall,
  serviceAuth,
  sleep,
  xrpc,
} from './lib.mjs'

const OZONE = process.env.KRAO_OZONE_URL ?? 'http://localhost:2587'
const OZONE_ADMIN = process.env.KRAO_OZONE_ADMIN_PASSWORD ?? 'admin-pass'
const PLC = process.env.KRAO_PLC_URL ?? 'http://localhost:2582'
const MIRROR = process.env.KRAO_PLC_MIRROR_URL ?? 'http://localhost:2596'
const VERIFIER = ['krao-verify.test', 'krao-dev-pass']
const LABEL = 'impersonation-suspect'

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

/** Polls `fn` until it returns something truthy, or `ms` pass */
async function waitFor(fn, ms = 60_000, every = 2_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value || Date.now() > until) return value
    await sleep(every)
  }
}

// Images
// ------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A 96px grayscale PNG: darker to the right with a dark disc; `seed` adds noise */
function png({ flip = false, seed = 0 } = {}) {
  const size = 96
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size + 1)
    for (let x = 0; x < size; x++) {
      const disc = (x - 48) ** 2 + (y - 32) ** 2 < 300
      let v = disc ? 15 : Math.max(0, 250 - x * 2 - y)
      if (seed) v = Math.min(255, v + ((x * 31 + y * 17 + seed) % 5))
      row[1 + (flip ? size - 1 - x : x)] = v
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 0 // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function uploadBlob(session, bytes) {
  const res = await fetch(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      authorization: `Bearer ${session.accessJwt}`,
    },
    body: bytes,
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`uploadBlob: ${body.message}`)
  return body.blob
}

const setProfile = (session, displayName, avatar) =>
  putRecord(session, 'app.bsky.actor.profile', 'self', {
    displayName,
    ...(avatar ? { avatar } : {}),
  })

// Ozone
// -----

const ozoneAdmin = `Basic ${Buffer.from(`admin:${OZONE_ADMIN}`).toString('base64')}`

async function ozone(method, query) {
  const url = new URL(`/xrpc/${method}`, OZONE)
  for (const [k, v] of Object.entries(query)) {
    for (const x of [v].flat()) url.searchParams.append(k, x)
  }
  const res = await fetch(url, { headers: { authorization: ozoneAdmin } })
  return {
    ok: res.ok,
    status: res.status,
    data: await res.json().catch(() => ({})),
  }
}

/** Whether the account carries the label now (a negation takes it off) */
async function labeled(did) {
  const res = await ozone('com.atproto.label.queryLabels', {
    uriPatterns: did,
    limit: '50',
  })
  const ours = (res.data.labels ?? []).filter(
    (l) => l.val === LABEL && l.uri === did,
  )
  if (!ours.length) return false
  ours.sort((a, b) => Date.parse(a.cts) - Date.parse(b.cts))
  return !ours[ours.length - 1].neg
}

async function events(did, type) {
  const res = await ozone('tools.ozone.moderation.queryEvents', {
    subject: did,
    types: type,
    limit: '50',
  })
  return res.data.events ?? []
}

/*
 * Impersonation
 */

const admin = await login(ACCOUNTS.rewardsAdmin, { phone: false })
const verifier = await login(VERIFIER, { phone: false })
const brand = await signUp('brand')
const fake = await signUp('imp')
const other = await signUp('shop')

const avatarA = await uploadBlob(brand, png())
await setProfile(brand, 'Ngân Hàng Krao', avatarA)
const verified = await createRecord(verifier, 'app.bsky.graph.verification', {
  subject: brand.did,
  handle: brand.handle,
  displayName: 'Ngân Hàng Krao',
  createdAt: new Date().toISOString(),
})
check('krao-verify.test verifies the brand', verified.ok, verified.data.message)

// Cyrillic К, and picture A with a little noise (another blob)
await setProfile(
  fake,
  'Ngân Hàng Кrao',
  await uploadBlob(fake, png({ seed: 7 })),
)
await setProfile(
  other,
  'Cửa Hàng Hoa',
  await uploadBlob(other, png({ flip: true })),
)

check(
  'the lookalike gets impersonation-suspect within 60 seconds',
  await waitFor(() => labeled(fake.did)),
)
const reports = await waitFor(async () => {
  const found = await events(
    fake.did,
    'tools.ozone.moderation.defs#modEventReport',
  )
  return found.length ? found : undefined
}, 15_000)
check(
  'and a report about it waits in Ozone, naming the brand',
  reports?.some((e) => (e.event.comment ?? '').includes(brand.did)),
  JSON.stringify(reports?.[0]?.event ?? {}),
)
const statuses = await ozone('tools.ozone.moderation.queryStatuses', {
  subject: fake.did,
})
check(
  'the account is in the review queue',
  statuses.data.subjectStatuses?.[0]?.reviewState ===
    'tools.ozone.moderation.defs#reviewOpen',
  statuses.data.subjectStatuses?.[0]?.reviewState,
)
check('another name and picture: no label', !(await labeled(other.did)))
check('the verified brand is never labeled', !(await labeled(brand.did)))

// The labeled account appeals through the existing flow (PDS → Ozone)
const appeal = await xrpc(PDS, 'com.atproto.moderation.createReport', {
  token: fake.accessJwt,
  body: {
    reasonType: 'com.atproto.moderation.defs#reasonAppeal',
    reason: 'This is my own bakery, not the bank',
    subject: { $type: 'com.atproto.admin.defs#repoRef', did: fake.did },
  },
})
check('the labeled account can appeal', appeal.ok, appeal.data.message)

const labelLog = await waitFor(async () => {
  const log = await rewardsCall(admin, 'net.krao.admin.getAuditLog', {
    query: { service: 'moderation', limit: 100 },
  })
  return log.data.entries?.find(
    (e) => e.action === 'impersonation.label' && e.subject === fake.did,
  )
}, 20_000)
check(
  'the label is in the shared admin log (moderation)',
  labelLog?.details?.target === brand.did,
  JSON.stringify(labelLog ?? {}),
)

// Renamed: the label comes off
await setProfile(
  fake,
  'Tiệm Bánh Mì Hạnh',
  await uploadBlob(fake, png({ seed: 7 })),
)
check(
  'renaming takes the label off within 60 seconds',
  await waitFor(async () => !(await labeled(fake.did))),
)
const unlabelLog = await waitFor(async () => {
  const log = await rewardsCall(admin, 'net.krao.admin.getAuditLog', {
    query: { service: 'moderation', limit: 100 },
  })
  return log.data.entries?.find(
    (e) => e.action === 'impersonation.unlabel' && e.subject === fake.did,
  )
}, 20_000)
check('and the unlabel is logged', !!unlabelLog)
check('the brand still has no label', !(await labeled(brand.did)))

/*
 * Admin roles
 */

const plain = await signUp('role')
const mine = await rewardsCall(plain, 'net.krao.admin.getMyRoles')
check(
  'an ordinary account has no roles',
  mine.ok && JSON.stringify(mine.data.roles) === '[]',
  JSON.stringify(mine.data),
)
const list = await rewardsCall(plain, 'net.krao.admin.listRoles')
check('and may not list roles', list.status === 403, list.status)
const adminRoles = await rewardsCall(admin, 'net.krao.admin.getMyRoles')
check(
  'the env admin has every role',
  adminRoles.data.roles?.length === 6,
  JSON.stringify(adminRoles.data),
)

const listDomains = 'net.krao.safety.admin.listDomains'
const indexerAdmin = async (session, method, { body, query } = {}) => {
  const token = await serviceAuth(session, method, GATE_DID)
  return xrpc(INDEXER, method, { token, body, query })
}
check(
  'without a role the indexer refuses its safety admin methods',
  (await indexerAdmin(plain, listDomains)).status === 403,
)
const grant = await rewardsCall(admin, 'net.krao.admin.setRole', {
  body: { did: plain.did, role: 'safety', enabled: true },
})
check(
  'an admin grants safety',
  grant.ok &&
    grant.data.roles?.some((r) => r.role === 'safety' && r.source === 'db'),
  JSON.stringify(grant.data),
)
const allowed = await waitFor(
  async () => (await indexerAdmin(plain, listDomains)).ok,
  65_000,
  3_000,
)
check('within 60 seconds the indexer takes the new safety admin', allowed)
const domain = `role-${stamp}.test`
const added = await indexerAdmin(plain, 'net.krao.safety.admin.addDomain', {
  body: { domain, reason: 'M35 e2e' },
})
check('and its admin actions work', added.ok, added.data.message)
const indexerLog = await waitFor(async () => {
  const log = await rewardsCall(admin, 'net.krao.admin.getAuditLog', {
    query: { service: 'indexer', actor: plain.did },
  })
  return log.data.entries?.find(
    (e) => e.action === 'domain.add' && e.subject === domain,
  )
}, 20_000)
check('which reach the shared log (indexer)', !!indexerLog)
await indexerAdmin(plain, 'net.krao.safety.admin.removeDomain', {
  body: { domain },
})

const revoke = await rewardsCall(admin, 'net.krao.admin.setRole', {
  body: { did: plain.did, role: 'safety', enabled: false },
})
check('the admin removes it again', revoke.ok, revoke.data.message)
const refused = await waitFor(
  async () => (await indexerAdmin(plain, listDomains)).status === 403,
  65_000,
  3_000,
)
check('within 60 seconds the indexer refuses again', refused)
const rewardsLog = await rewardsCall(admin, 'net.krao.admin.getAuditLog', {
  query: { service: 'rewards', limit: 100 },
})
const roleActions = (rewardsLog.data.entries ?? [])
  .filter((e) => e.subject === plain.did)
  .map((e) => e.action)
check(
  'role changes are in the shared log (rewards)',
  roleActions.includes('role.grant') && roleActions.includes('role.revoke'),
  JSON.stringify(roleActions),
)
const envRole = await rewardsCall(admin, 'net.krao.admin.setRole', {
  body: { did: admin.did, role: 'rewards', enabled: false },
})
check(
  'roles from the configuration cannot be removed',
  envRole.status === 400 && envRole.data.error === 'EnvRole',
  JSON.stringify(envRole.data),
)
const members = await rewardsCall(admin, 'net.krao.admin.listRoles')
check(
  'the role list shows env roles as locked',
  members.data.members
    ?.find((m) => m.did === admin.did)
    ?.roles.every((r) => r.source === 'env'),
)

/*
 * PLC mirror
 */

const getJson = async (base, path) => {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}
const health = await getJson(MIRROR, '/_health')
check(
  'the PLC mirror answers and has caught up with the PLC',
  health.body?.ok && typeof health.body.lagSeconds === 'number',
  JSON.stringify(health.body),
)
const repos = await xrpc(PDS, 'com.atproto.sync.listRepos', {
  query: { limit: '200' },
})
const dids = (repos.data.repos ?? [])
  .map((r) => r.did)
  .filter((d) => d.startsWith('did:plc:'))
let same = 0
const differ = []
for (const did of dids) {
  const [mine, theirs] = await Promise.all([
    getJson(MIRROR, `/${did}`),
    getJson(PLC, `/${did}`),
  ])
  if (JSON.stringify(mine.body) === JSON.stringify(theirs.body)) same++
  else differ.push(did)
}
check(
  `every seeded DID (${dids.length}) has the same DID document in the mirror`,
  dids.length > 5 && !differ.length,
  differ.slice(0, 3).join(', '),
)
const fresh = await signUp('plc')
const copied = await waitFor(
  async () => {
    const audit = await getJson(MIRROR, `/${fresh.did}/log/audit`)
    return audit.status === 200 && audit.body.length >= 1
  },
  10_000,
  500,
)
check('a new account is in the mirror within 10 seconds', copied)
const handle = `plc2${stamp}.test`
await xrpc(PDS, 'com.atproto.identity.updateHandle', {
  token: fresh.accessJwt,
  body: { handle },
})
const renamed = await waitFor(
  async () => {
    const doc = await getJson(MIRROR, `/${fresh.did}`)
    return doc.body?.alsoKnownAs?.includes(`at://${handle}`)
  },
  10_000,
  500,
)
check('and its handle change too', renamed)
// A forged operation (no valid signature) is refused, and not taken
const last = await getJson(MIRROR, `/${fresh.did}/log/last`)
const forged = await fetch(`${MIRROR}/${fresh.did}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...last.body, alsoKnownAs: ['at://evil.test'] }),
})
const after = await getJson(MIRROR, `/${fresh.did}`)
check(
  'a forged operation is refused',
  forged.status >= 400 && after.body?.alsoKnownAs?.includes(`at://${handle}`),
  forged.status,
)
// The AppView resolves through the mirror: it knows the new handle
const profile = await waitFor(async () => {
  const res = await xrpc(
    process.env.KRAO_APPVIEW_URL ?? 'http://localhost:2584',
    'app.bsky.actor.getProfile',
    { query: { actor: fresh.did } },
  )
  return res.data.handle === handle ? res.data : undefined
}, 20_000)
check('the AppView (resolving through the mirror) shows it', !!profile)

done()
