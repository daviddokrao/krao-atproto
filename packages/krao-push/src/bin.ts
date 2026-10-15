#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { KraoPush } from './index.js'

const required = (name: string, minLength = 32) => {
  const value = process.env[name] ?? ''
  if (value.length < minLength) {
    throw new Error(`${name} is required (at least ${minLength} characters)`)
  }
  return value
}

const fcmFile = process.env.KRAO_PUSH_FCM_SERVICE_ACCOUNT_FILE
const apnsFile = process.env.KRAO_PUSH_APNS_KEY_FILE

const push = await KraoPush.create({
  port: Number(process.env.KRAO_PUSH_PORT ?? 2593),
  dbLocation: process.env.KRAO_PUSH_DB ?? 'krao-push.sqlite',
  courierKey: required('KRAO_PUSH_COURIER_KEY'),
  internalToken: required('KRAO_PUSH_INTERNAL_TOKEN'),
  appviewUrl: process.env.KRAO_PUSH_APPVIEW_URL ?? 'https://api.krao.net',
  appviewDb: process.env.KRAO_PUSH_APPVIEW_DB_URL
    ? {
        url: process.env.KRAO_PUSH_APPVIEW_DB_URL,
        schema: process.env.KRAO_PUSH_APPVIEW_DB_SCHEMA || undefined,
      }
    : undefined,
  // A Firebase service account JSON, for Android
  fcm: fcmFile ? JSON.parse(readFileSync(fcmFile, 'utf8')) : undefined,
  // An APNs auth key (.p8), for iOS
  apns: apnsFile
    ? {
        key: readFileSync(apnsFile, 'utf8'),
        keyId: required('KRAO_PUSH_APNS_KEY_ID', 1),
        teamId: required('KRAO_PUSH_APNS_TEAM_ID', 1),
        topic: process.env.KRAO_PUSH_APNS_TOPIC || 'io.krao.app',
        production: process.env.KRAO_PUSH_APNS_PRODUCTION !== 'false',
      }
    : undefined,
})
await push.start()
console.log(
  `Krao push listening on ${push.url}` +
    (fcmFile || apnsFile ? '' : ' (no FCM/APNs configured: pushes are logged)'),
)

const shutdown = async () => {
  await push.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
