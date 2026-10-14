#!/usr/bin/env node
import { KraoVideo } from './index.js'

const envInt = (name: string) =>
  process.env[name] ? Number(process.env[name]) : undefined

const pdsUrls = (process.env.KRAO_VIDEO_PDS_URLS ?? 'https://pds.krao.io')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean)

const video = KraoVideo.create({
  port: envInt('KRAO_VIDEO_PORT') ?? 2591,
  serviceDid: process.env.KRAO_VIDEO_DID ?? 'did:web:video.krao.io',
  dataDir: process.env.KRAO_VIDEO_DATA_DIR ?? 'krao-video-data',
  plcUrl: process.env.KRAO_PLC_URL ?? 'https://plc.directory',
  pdsUrls,
  publicUrl: process.env.KRAO_VIDEO_PUBLIC_URL,
  limits: {
    maxBytes: envInt('KRAO_VIDEO_MAX_BYTES'),
    maxDurationSec: envInt('KRAO_VIDEO_MAX_DURATION_SEC'),
    dailyVideos: envInt('KRAO_VIDEO_DAILY_VIDEOS'),
    dailyBytes: envInt('KRAO_VIDEO_DAILY_BYTES'),
  },
  concurrency: envInt('KRAO_VIDEO_CONCURRENCY'),
  ffmpegPath: process.env.KRAO_FFMPEG_PATH,
  ffprobePath: process.env.KRAO_FFPROBE_PATH,
})
await video.start()
console.log(`Krao video service listening on ${video.url}`)

const shutdown = async () => {
  await video.destroy()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
