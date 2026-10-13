#!/usr/bin/env node
import { KraoIndexer } from './index.js'

const indexer = await KraoIndexer.create({
  port: Number(process.env.KRAO_INDEXER_PORT ?? 2589),
  dbLocation: process.env.KRAO_INDEXER_DB ?? 'krao-indexer.sqlite',
  firehoseUrl: process.env.KRAO_FIREHOSE_URL ?? 'wss://bsky.network',
  plcUrl: process.env.KRAO_PLC_URL ?? 'https://plc.directory',
  rpcUrls: process.env.KRAO_RPC_URLS
    ? (JSON.parse(process.env.KRAO_RPC_URLS) as Record<string, string>)
    : { 'eip155:8453': 'https://mainnet.base.org' },
  appviewUrl: process.env.KRAO_APPVIEW_URL ?? 'https://public.api.bsky.app',
  gateDid: process.env.KRAO_GATE_DID ?? 'did:web:gate.krao.net',
  feedGenDid: process.env.KRAO_FEEDGEN_DID,
  feedPdsUrl: process.env.KRAO_FEED_PDS_URL,
  publicUrl: process.env.KRAO_INDEXER_PUBLIC_URL,
  klipyApiKey: process.env.KRAO_KLIPY_API_KEY,
  webUrl: process.env.KRAO_WEB_URL,
  handleResolverUrl:
    process.env.KRAO_HANDLE_RESOLVER_URL ?? 'https://public.api.bsky.app',
})
await indexer.start()
console.log(`Krao indexer listening on ${indexer.url}`)

const shutdown = async () => {
  await indexer.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
