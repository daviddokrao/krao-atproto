#!/usr/bin/env node
import { KraoIndexer } from './index.js'

// Signs gated media URLs: a random secret would break them on every restart
// and between instances
if ((process.env.KRAO_GATE_MEDIA_SECRET ?? '').length < 32) {
  throw new Error('KRAO_GATE_MEDIA_SECRET is required (at least 32 characters)')
}

const indexer = await KraoIndexer.create({
  // Rehearsals and dev only: identity lookups to private hosts over http
  insecureFetch: process.env.KRAO_INSECURE_FETCH === 'true',
  port: Number(process.env.KRAO_INDEXER_PORT ?? 2589),
  dbLocation: process.env.KRAO_INDEXER_DB ?? 'krao-indexer.sqlite',
  // Krao is its own network: index Krao's PDS, not the whole Bluesky relay
  firehoseUrl: process.env.KRAO_FIREHOSE_URL ?? 'wss://pds.krao.net',
  plcUrl: process.env.KRAO_PLC_URL ?? 'https://plc.directory',
  rpcUrls: process.env.KRAO_RPC_URLS
    ? (JSON.parse(process.env.KRAO_RPC_URLS) as Record<string, string>)
    : { 'eip155:8453': 'https://mainnet.base.org' },
  appviewUrl: process.env.KRAO_APPVIEW_URL ?? 'https://api.krao.net',
  gateDid: process.env.KRAO_GATE_DID ?? 'did:web:gate.krao.net',
  feedGenDid: process.env.KRAO_FEEDGEN_DID,
  feedPdsUrl: process.env.KRAO_FEED_PDS_URL,
  publicUrl: process.env.KRAO_INDEXER_PUBLIC_URL,
  gateMediaSecret: process.env.KRAO_GATE_MEDIA_SECRET,
  // A private bucket; credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  gateMediaS3: process.env.KRAO_GATE_MEDIA_S3_BUCKET
    ? {
        bucket: process.env.KRAO_GATE_MEDIA_S3_BUCKET,
        region: process.env.KRAO_GATE_MEDIA_S3_REGION,
        endpoint: process.env.KRAO_GATE_MEDIA_S3_ENDPOINT,
        forcePathStyle: process.env.KRAO_GATE_MEDIA_S3_PATH_STYLE === 'true',
      }
    : undefined,
  klipyApiKey: process.env.KRAO_KLIPY_API_KEY,
  webUrl: process.env.KRAO_WEB_URL,
  handleResolverUrl:
    process.env.KRAO_HANDLE_RESOLVER_URL ?? 'https://pds.krao.net',
  push: process.env.KRAO_PUSH_URL
    ? {
        url: process.env.KRAO_PUSH_URL,
        token: process.env.KRAO_PUSH_INTERNAL_TOKEN ?? '',
      }
    : undefined,
  // Verified communities and polls ask the rewards service (phone or KYC)
  rewards: process.env.KRAO_REWARDS_URL
    ? {
        url: process.env.KRAO_REWARDS_URL,
        token: process.env.KRAO_REWARDS_INTERNAL_TOKEN ?? '',
      }
    : undefined,
  // Moderators (accounts, or Ozone's service DID) who may read gated content
  gateModeratorDids: (process.env.KRAO_GATE_MODERATOR_DIDS ?? '')
    .split(',')
    .map((did) => did.trim())
    .filter(Boolean),
  gateModerationAccess: process.env.KRAO_GATE_MODERATION_ACCESS !== 'false',
  // eg MetaMask's https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json
  phishingListUrl: process.env.KRAO_PHISHING_LIST_URL || undefined,
  // Accounts that may add and remove unsafe domains
  safetyAdminDids: (process.env.KRAO_SAFETY_ADMIN_DIDS ?? '')
    .split(',')
    .map((did) => did.trim())
    .filter(Boolean),
})
await indexer.start()
console.log(`Krao indexer listening on ${indexer.url}`)

const shutdown = async () => {
  await indexer.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
