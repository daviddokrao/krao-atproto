#!/usr/bin/env node
import {
  HttpSmsProvider,
  KraoRewards,
  LogSmsProvider,
  type SmsProvider,
} from './index.js'

const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const env = process.env
const internalToken = env.KRAO_REWARDS_INTERNAL_TOKEN ?? ''
if (internalToken.length < 32) {
  throw new Error(
    'KRAO_REWARDS_INTERNAL_TOKEN is required (shared with the PDS, at least 32 characters)',
  )
}
const sumsub =
  env.SUMSUB_APP_TOKEN && env.SUMSUB_SECRET_KEY
    ? {
        appToken: env.SUMSUB_APP_TOKEN,
        secretKey: env.SUMSUB_SECRET_KEY,
        levelName: env.SUMSUB_LEVEL ?? 'basic-kyc-level',
        webhookSecret: env.SUMSUB_WEBHOOK_SECRET ?? '',
        baseUrl: env.SUMSUB_BASE_URL,
      }
    : undefined
if (sumsub && !sumsub.webhookSecret) {
  throw new Error('SUMSUB_WEBHOOK_SECRET is required with Sumsub')
}

/*
 * Phone verification: KRAO_SMS_PROVIDER is log (codes in the log: dev and
 * rehearsals, with KRAO_DEV_MODE), http (a JSON gateway) or none (off). Its secrets are required
 * with a provider: the HMAC secret keys the stored numbers, so changing it
 * loses them.
 */
const smsProvider = env.KRAO_SMS_PROVIDER || 'none'
const devMode = env.KRAO_DEV_MODE === 'true'
let sms: SmsProvider | undefined
if (smsProvider === 'log') {
  // Nobody could read the codes: never in production
  if (!devMode) {
    throw new Error('KRAO_SMS_PROVIDER=log needs KRAO_DEV_MODE=true')
  }
  sms = new LogSmsProvider()
} else if (smsProvider === 'http') {
  if (!env.KRAO_SMS_HTTP_URL || !env.KRAO_SMS_HTTP_TOKEN) {
    throw new Error(
      'KRAO_SMS_HTTP_URL and KRAO_SMS_HTTP_TOKEN are required with KRAO_SMS_PROVIDER=http',
    )
  }
  sms = new HttpSmsProvider({
    url: env.KRAO_SMS_HTTP_URL,
    token: env.KRAO_SMS_HTTP_TOKEN,
  })
} else if (smsProvider !== 'none') {
  throw new Error('KRAO_SMS_PROVIDER must be log, http or none')
}
if (sms && (!env.KRAO_PHONE_HMAC_SECRET || !env.KRAO_PHONE_ENC_KEY)) {
  throw new Error(
    'KRAO_PHONE_HMAC_SECRET and KRAO_PHONE_ENC_KEY are required with an SMS provider',
  )
}
const positive = (name: string, fallback: number) => {
  const value = Number(env[name] || fallback)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
const phoneLimits = {
  // Comma-separated E.164 prefixes; Vietnam only by default
  allowedPrefixes: list(env.KRAO_PHONE_ALLOWED_PREFIXES || '+84'),
  globalHourlyCap: positive('KRAO_SMS_GLOBAL_HOURLY_CAP', 500),
  ipHourlyCap: positive('KRAO_SMS_IP_HOURLY_CAP', 30),
}

const rewards = await KraoRewards.create({
  // Rehearsals and dev only: identity lookups to private hosts over http
  insecureFetch: process.env.KRAO_INSECURE_FETCH === 'true',
  port: Number(env.KRAO_REWARDS_PORT ?? 2592),
  serviceDid: env.KRAO_REWARDS_DID ?? 'did:web:rewards.krao.net',
  dbLocation: env.KRAO_REWARDS_DB ?? 'krao-rewards.sqlite',
  plcUrl: env.KRAO_PLC_URL ?? 'https://plc.directory',
  internalToken,
  publicUrl: env.KRAO_REWARDS_PUBLIC_URL,
  adminDids: list(env.KRAO_REWARDS_ADMIN_DIDS),
  kycReviewerDids: list(env.KRAO_KYC_REVIEWER_DIDS),
  // Shown as Krao admin roles (the indexer reads the same variables)
  safetyAdminDids: list(env.KRAO_SAFETY_ADMIN_DIDS),
  gateModeratorDids: list(env.KRAO_GATE_MODERATOR_DIDS),
  sumsub,
  manualReview: {
    dailyLimit: env.KRAO_KYC_MANUAL_DAILY_LIMIT
      ? Number(env.KRAO_KYC_MANUAL_DAILY_LIMIT)
      : undefined,
    requireSecondApprover: env.KRAO_KYC_REQUIRE_SECOND_APPROVER === 'true',
  },
  bootstrapCode: process.env.KRAO_REWARDS_BOOTSTRAP_CODE
    ? {
        code: process.env.KRAO_REWARDS_BOOTSTRAP_CODE,
        maxUses: Number(process.env.KRAO_REWARDS_BOOTSTRAP_CODE_MAX_USES || 5),
      }
    : undefined,
  push: process.env.KRAO_PUSH_URL
    ? {
        url: process.env.KRAO_PUSH_URL,
        token: process.env.KRAO_PUSH_INTERNAL_TOKEN ?? '',
      }
    : undefined,
  phone: sms
    ? {
        sms,
        secrets: {
          hmacSecret: env.KRAO_PHONE_HMAC_SECRET ?? '',
          encKey: env.KRAO_PHONE_ENC_KEY ?? '',
        },
        limits: phoneLimits,
      }
    : undefined,
  devMode,
})
await rewards.start()
console.log(`Krao rewards service listening on ${rewards.url}`)

const shutdown = async () => {
  await rewards.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
