#!/usr/bin/env node
import { KraoRewards } from './index.js'

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

const rewards = await KraoRewards.create({
  port: Number(env.KRAO_REWARDS_PORT ?? 2592),
  serviceDid: env.KRAO_REWARDS_DID ?? 'did:web:rewards.krao.net',
  dbLocation: env.KRAO_REWARDS_DB ?? 'krao-rewards.sqlite',
  plcUrl: env.KRAO_PLC_URL ?? 'https://plc.directory',
  internalToken,
  publicUrl: env.KRAO_REWARDS_PUBLIC_URL,
  adminDids: list(env.KRAO_REWARDS_ADMIN_DIDS),
  kycReviewerDids: list(env.KRAO_KYC_REVIEWER_DIDS),
  sumsub,
  manualReview: {
    dailyLimit: env.KRAO_KYC_MANUAL_DAILY_LIMIT
      ? Number(env.KRAO_KYC_MANUAL_DAILY_LIMIT)
      : undefined,
    requireSecondApprover: env.KRAO_KYC_REQUIRE_SECOND_APPROVER === 'true',
  },
  push: process.env.KRAO_PUSH_URL
    ? {
        url: process.env.KRAO_PUSH_URL,
        token: process.env.KRAO_PUSH_INTERNAL_TOKEN ?? '',
      }
    : undefined,
})
await rewards.start()
console.log(`Krao rewards service listening on ${rewards.url}`)

const shutdown = async () => {
  await rewards.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
