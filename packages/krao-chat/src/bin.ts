#!/usr/bin/env node
import { KraoChat } from './index.js'

const chat = await KraoChat.create({
  port: Number(process.env.KRAO_CHAT_PORT ?? 2590),
  serviceDid: process.env.KRAO_CHAT_DID ?? 'did:web:chat.krao.net',
  dbLocation: process.env.KRAO_CHAT_DB ?? 'krao-chat.sqlite',
  plcUrl: process.env.KRAO_PLC_URL ?? 'https://plc.directory',
  appviewUrl: process.env.KRAO_APPVIEW_URL ?? 'https://api.krao.net',
  publicUrl: process.env.KRAO_CHAT_PUBLIC_URL,
})
await chat.start()
console.log(`Krao chat service listening on ${chat.url}`)

const shutdown = async () => {
  await chat.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
