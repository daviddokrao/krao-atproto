#!/usr/bin/env node
import { KraoChat } from './index.js'

const chat = await KraoChat.create({
  // Rehearsals and dev only: identity lookups to private hosts over http
  insecureFetch: process.env.KRAO_INSECURE_FETCH === 'true',
  port: Number(process.env.KRAO_CHAT_PORT ?? 2590),
  serviceDid: process.env.KRAO_CHAT_DID ?? 'did:web:chat.krao.net',
  dbLocation: process.env.KRAO_CHAT_DB ?? 'krao-chat.sqlite',
  plcUrl: process.env.KRAO_PLC_URL ?? 'https://plc.directory',
  appviewUrl: process.env.KRAO_APPVIEW_URL ?? 'https://api.krao.net',
  publicUrl: process.env.KRAO_CHAT_PUBLIC_URL,
  moderatorDids: (process.env.KRAO_CHAT_MODERATOR_DIDS ?? '')
    .split(',')
    .map((did) => did.trim())
    .filter(Boolean),
  push: process.env.KRAO_PUSH_URL
    ? {
        url: process.env.KRAO_PUSH_URL,
        token: process.env.KRAO_PUSH_INTERNAL_TOKEN ?? '',
      }
    : undefined,
})
await chat.start()
console.log(`Krao chat service listening on ${chat.url}`)

const shutdown = async () => {
  await chat.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
