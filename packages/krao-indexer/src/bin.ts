#!/usr/bin/env node
import { KraoIndexer } from './index.js'

const indexer = await KraoIndexer.create({
  port: Number(process.env.KRAO_INDEXER_PORT ?? 2589),
  dbLocation: process.env.KRAO_INDEXER_DB ?? 'krao-indexer.sqlite',
  firehoseUrl: process.env.KRAO_FIREHOSE_URL ?? 'wss://bsky.network',
  plcUrl: process.env.KRAO_PLC_URL ?? 'https://plc.directory',
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
