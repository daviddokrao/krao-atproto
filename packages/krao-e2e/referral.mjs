// Mandatory referral codes, points and KYC (the Krao rewards service).
// Sign-up needs a code; a referral gives both sides pending points, which
// are approved once both have passed KYC (by hand here: no provider in the
// dev-env).
import {
  ACCOUNTS,
  PDS,
  REWARDS,
  REWARDS_DID,
  SIGNUP_CODE,
  checker,
  login,
  serviceAuth,
  sleep,
  xrpc,
} from './lib.mjs'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)

const signUp = (name, inviteCode) =>
  xrpc(PDS, 'com.atproto.server.createAccount', {
    body: {
      handle: `${name}${stamp}.test`,
      email: `${name}${stamp}@example.com`,
      password: 'krao-dev-pass',
      ...(inviteCode !== undefined ? { inviteCode } : {}),
    },
  })

/** Calls the rewards service as `session`, the way the app does */
async function call(session, method, { body, query, post } = {}) {
  const token = await serviceAuth(session, method, REWARDS_DID)
  if (post && !body) {
    // A procedure without input: POST with no body
    const res = await fetch(`${REWARDS}/xrpc/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    return { ok: res.ok, status: res.status, data: await res.json() }
  }
  return xrpc(REWARDS, method, { token, body, query })
}

/** The PDS reports sign-ups some seconds after they happen */
async function waitFor(fn, ms = 30_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value || Date.now() > until) return value
    await sleep(500)
  }
}

const desc = await xrpc(PDS, 'com.atproto.server.describeServer')
check('the PDS asks for a code', desc.data.inviteCodeRequired === true)

const none = await signUp('nocode')
check(
  'sign-up without a code is refused',
  none.data.error === 'InvalidInviteCode',
  none.data.error,
)
const bogus = await signUp('bogus', 'NOT-A-CODE')
check(
  'sign-up with an unknown code is refused',
  bogus.data.error === 'InvalidInviteCode',
  bogus.data.error,
)

const devCheck = await xrpc(REWARDS, 'net.krao.referral.checkCode', {
  query: { code: SIGNUP_CODE.toLowerCase() },
})
check('codes are checked case-insensitively', devCheck.data.valid === true)

// Ana joins with the campaign code, then invites Ben with her own code
const anaRes = await signUp('ana', SIGNUP_CODE)
check('sign-up with a valid code works', anaRes.ok, anaRes.data.message)
const ana = anaRes.data
const overview = await call(ana, 'net.krao.referral.getOverview')
const code = overview.data.code
check(
  'each account gets a personal code',
  /^[2-9A-Z]{8}$/.test(code ?? ''),
  code,
)

const codeCheck = await xrpc(REWARDS, 'net.krao.referral.checkCode', {
  query: { code },
})
check(
  'the personal code names its owner',
  codeCheck.data.valid && codeCheck.data.referrer === ana.did,
)

const benRes = await signUp('ben', code.toLowerCase())
check('a friend joins with the personal code', benRes.ok, benRes.data.message)
const ben = benRes.data

const referrals = await waitFor(async () => {
  const res = await call(ana, 'net.krao.referral.listReferrals')
  return res.data.referrals?.length ? res.data.referrals : null
})
check(
  'the referrer sees who joined',
  referrals?.[0]?.did === ben.did && referrals[0].verified === false,
)
const benOverview = await call(ben, 'net.krao.referral.getOverview')
check(
  'the new account knows who invited it',
  benOverview.data.invitedBy === ana.did,
)

const balance = async (session) =>
  (await call(session, 'net.krao.points.getBalance')).data
// Ana also joined with a (campaign) code, so she has her own 50 too
check(
  'the referrer gets 100 pending points',
  JSON.stringify(await balance(ana)) ===
    JSON.stringify({ pending: 150, approved: 0 }),
)
check(
  'the new account gets 50 pending points',
  JSON.stringify(await balance(ben)) ===
    JSON.stringify({ pending: 50, approved: 0 }),
)

const status = await call(ben, 'net.krao.kyc.getStatus')
check(
  'KYC starts at none, without a provider here',
  status.data.status === 'none' && status.data.available === false,
)
const start = await call(ben, 'net.krao.kyc.startVerification', { post: true })
check(
  'starting KYC without a provider says so',
  start.data.error === 'KycUnavailable',
  start.data.error,
)

const forbidden = await call(ben, 'net.krao.rewards.admin.listRules')
check('users cannot call admin methods', forbidden.status === 403)

// Manual KYC: approving Ben alone leaves the points waiting for Ana
const admin = await login(ACCOUNTS.rewardsAdmin)
const review = (did, decision = 'approve') =>
  call(admin, 'net.krao.rewards.admin.reviewKyc', {
    body: {
      did,
      decision,
      reasonCode: 'provider_outage',
      note: 'Checked documents on a video call (e2e)',
    },
  })
const shortNote = await call(admin, 'net.krao.rewards.admin.reviewKyc', {
  body: {
    did: ben.did,
    decision: 'approve',
    reasonCode: 'other',
    note: 'ok',
  },
})
check('a manual review needs a real note', shortNote.status === 400)

const benReview = await review(ben.did)
check('an admin can approve KYC by hand', benReview.data.status === 'approved')
const entries = await call(ben, 'net.krao.points.listEntries')
check(
  'points wait for the other side’s KYC',
  entries.data.entries?.[0]?.status === 'pending' &&
    entries.data.entries[0].waitingFor?.join() === 'kyc:related',
)
await review(ana.did)
check(
  'once both pass KYC the points are approved',
  JSON.stringify(await balance(ana)) ===
    JSON.stringify({ pending: 0, approved: 150 }) &&
    JSON.stringify(await balance(ben)) ===
      JSON.stringify({ pending: 0, approved: 50 }),
)
const verified = await call(ana, 'net.krao.referral.getOverview')
check('verified referrals are counted', verified.data.verifiedCount === 1)

// Campaign codes with limits
const campaign = await call(admin, 'net.krao.rewards.admin.createCode', {
  body: { code: `E2E-${stamp}`, kind: 'campaign', maxUses: 1 },
})
check(
  'admins create campaign codes (stored upper case)',
  campaign.data.code === `E2E-${stamp}`.toUpperCase(),
)
const first = await signUp('cam', `e2e-${stamp}`)
check('a campaign code works', first.ok, first.data.message)
await waitFor(async () => {
  const res = await xrpc(REWARDS, 'net.krao.referral.checkCode', {
    query: { code: `E2E-${stamp}`.toUpperCase() },
  })
  return res.data.valid === false
})
const second = await signUp('cam2', `E2E-${stamp}`)
check(
  'a used up code is refused',
  second.data.error === 'InvalidInviteCode',
  second.data.error,
)

const disabled = await call(admin, 'net.krao.rewards.admin.updateCode', {
  body: { code, disabled: true },
})
const afterDisable = await signUp('dis', code)
check(
  'a disabled code is refused',
  disabled.data.disabled === true &&
    afterDisable.data.error === 'InvalidInviteCode',
)

// Rules are data: a change applies to later sign-ups
const rules = await call(admin, 'net.krao.rewards.admin.listRules')
check(
  'the default rules are 100 and 50',
  rules.data.rules?.find((r) => r.id === 'referral.inviter')?.amount === 100 &&
    rules.data.rules?.find((r) => r.id === 'referral.invitee')?.amount === 50,
)

const revoke = await call(admin, 'net.krao.rewards.admin.revokePoints', {
  body: { did: ana.did, note: 'Revoked in the e2e test' },
})
check(
  'revoking takes approved points back',
  revoke.data.reversed === 2 &&
    JSON.stringify(await balance(ana)) ===
      JSON.stringify({ pending: 0, approved: 0 }),
)

const audit = await call(admin, 'net.krao.rewards.admin.listAuditLog', {
  query: { subject: ana.did },
})
const actions = (audit.data.entries ?? []).map((e) => e.action)
check(
  'admin actions are logged',
  ['kyc.review', 'kyc.status', 'points.revoke'].every((a) =>
    actions.includes(a),
  ),
  actions.join(', '),
)

const webhook = await fetch(`${REWARDS}/webhooks/sumsub`, {
  method: 'POST',
  body: '{}',
})
check(
  'webhooks of an unconfigured provider are refused',
  webhook.status === 404,
)

done()
