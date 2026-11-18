#!/usr/bin/env node
import { KraoPlcMirror } from './index.js'

const env = process.env
const positive = (name: string, fallback: number) => {
  const value = Number(env[name] || fallback)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

const mirror = await KraoPlcMirror.create({
  port: positive('KRAO_PLC_MIRROR_PORT', 2596),
  dbLocation: env.KRAO_PLC_MIRROR_DB ?? 'krao-plc-mirror.sqlite',
  source: env.KRAO_PLC_MIRROR_SOURCE || 'https://plc.directory',
  pollMs: positive('KRAO_PLC_MIRROR_POLL_MS', 5_000),
  maxBackoffMs: positive('KRAO_PLC_MIRROR_MAX_BACKOFF_MS', 60_000),
  fallback: env.KRAO_PLC_MIRROR_FALLBACK !== 'false',
  // Eg the day Krao starts: older DIDs are copied when first asked for
  startAfter: env.KRAO_PLC_MIRROR_START_AFTER || undefined,
})
await mirror.start()
console.log(
  `Krao PLC mirror of ${mirror.mirror.source} listening on ${mirror.url}`,
)

const shutdown = async () => {
  await mirror.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
