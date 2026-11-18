import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type FfmpegTools = {
  ffmpeg: string
  ffprobe: string
}

export type ProbeResult = {
  durationSec: number
  /** Display size, after applying the rotation stored in the file */
  width: number
  height: number
  videoCodec: string
  audioCodec: string | null
  /** ffprobe's format name, eg `mov,mp4,m4a,3gp,3g2,mj2` */
  formatName: string
}

export class FfmpegError extends Error {}

/** Keep only the end of a process's stderr, where ffmpeg puts the error */
const STDERR_TAIL = 4096
/** A stuck ffmpeg or ffprobe is killed after this long */
const RUN_TIMEOUT_MS = 15 * 60 * 1000

function run(
  cmd: string,
  args: string[],
  opts: { onStdoutLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.any([
        AbortSignal.timeout(RUN_TIMEOUT_MS),
        ...(opts.signal ? [opts.signal] : []),
      ]),
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    let pending = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (!opts.onStdoutLine) {
        stdout += chunk
        return
      }
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) opts.onStdoutLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL)
    })
    child.on('error', (err) => reject(new FfmpegError(err.message)))
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else {
        reject(
          new FfmpegError(
            `${path.basename(cmd)} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
          ),
        )
      }
    })
  })
}

export async function probe(
  tools: FfmpegTools,
  file: string,
): Promise<ProbeResult> {
  const out = await run(tools.ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ])
  const data = JSON.parse(out) as {
    format?: { duration?: string; format_name?: string }
    streams?: Array<{
      codec_type?: string
      codec_name?: string
      width?: number
      height?: number
      duration?: string
      tags?: { rotate?: string }
      side_data_list?: Array<{ rotation?: number }>
    }>
  }
  const streams = data.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  if (!video?.width || !video.height || !video.codec_name) {
    throw new FfmpegError('The file has no video stream')
  }
  const audio = streams.find((s) => s.codec_type === 'audio')
  const rotation = Math.abs(
    Number(
      video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
        video.tags?.rotate ??
        0,
    ),
  )
  const sideways = rotation % 180 === 90
  const durationSec = Number(data.format?.duration ?? video.duration ?? NaN)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new FfmpegError('Could not read the video duration')
  }
  return {
    durationSec,
    width: sideways ? video.height : video.width,
    height: sideways ? video.width : video.height,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    formatName: data.format?.format_name ?? '',
  }
}

/**
 * Writes the video as an mp4 that plays everywhere (the `app.bsky.embed.video`
 * blob must be video/mp4). H.264 mp4s are only remuxed, so the stored file
 * keeps the quality the client chose; anything else is re-encoded.
 */
export async function toPlayableMp4(
  tools: FfmpegTools,
  src: string,
  dest: string,
  info: ProbeResult,
) {
  const isMp4 = info.formatName.split(',').includes('mp4')
  const copyVideo = isMp4 && info.videoCodec === 'h264'
  const copyAudio = info.audioCodec === null || info.audioCodec === 'aac'
  await run(tools.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    src,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    ...(copyVideo
      ? ['-c:v', 'copy']
      : [
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-vf',
          // At most 1920px on the long side, with even dimensions for x264
          "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))'",
        ]),
    ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']),
    '-movflags',
    '+faststart',
    dest,
  ])
}

type Rendition = {
  name: string
  /** Length of the short side */
  size: number
  videoBitrate: number
}

const LADDER: Rendition[] = [
  { name: '360p', size: 360, videoBitrate: 800_000 },
  { name: '720p', size: 720, videoBitrate: 2_500_000 },
]
const AUDIO_BITRATE = 128_000
/** HLS segment length; keyframes are forced on this grid */
const SEGMENT_SEC = 4

/** The renditions to encode: every ladder step the source can fill, at least one */
export function renditionsFor(info: ProbeResult): Rendition[] {
  const shortSide = Math.min(info.width, info.height)
  const fitting = LADDER.filter((r) => r.size <= shortSide)
  if (fitting.length) return fitting
  return [{ ...LADDER[0], size: Math.max(2, shortSide - (shortSide % 2)) }]
}

function outputSize(info: ProbeResult, size: number) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return info.width >= info.height
    ? { width: even((info.width * size) / info.height), height: size }
    : { width: size, height: even((info.height * size) / info.width) }
}

/**
 * Encodes the video as HLS into `dir`: one folder per rendition plus a master
 * `playlist.m3u8`, and a `thumbnail.jpg`. Reports progress as 0..1.
 */
export async function encodeHls(
  tools: FfmpegTools,
  src: string,
  dir: string,
  info: ProbeResult,
  onProgress: (progress: number) => void = () => {},
) {
  const renditions = renditionsFor(info)
  const variants: string[] = []
  for (const [i, r] of renditions.entries()) {
    const out = path.join(dir, r.name)
    await mkdir(out, { recursive: true })
    const { width, height } = outputSize(info, r.size)
    await run(
      tools.ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-nostats',
        '-progress',
        'pipe:1',
        '-i',
        src,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        `scale=${width}:${height}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-profile:v',
        'main',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        String(r.videoBitrate),
        '-maxrate',
        String(Math.round(r.videoBitrate * 1.2)),
        '-bufsize',
        String(r.videoBitrate * 2),
        '-force_key_frames',
        `expr:gte(t,n_forced*${SEGMENT_SEC})`,
        '-c:a',
        'aac',
        '-b:a',
        String(AUDIO_BITRATE),
        '-ac',
        '2',
        '-f',
        'hls',
        '-hls_time',
        String(SEGMENT_SEC),
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        path.join(out, 'seg%04d.ts'),
        path.join(out, 'video.m3u8'),
      ],
      {
        onStdoutLine: (line) => {
          const match = /^out_time_us=(\d+)/.exec(line)
          if (!match) return
          const done = Math.min(1, Number(match[1]) / 1e6 / info.durationSec)
          onProgress((i + done) / renditions.length)
        },
      },
    )
    variants.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(r.videoBitrate * 1.2) + AUDIO_BITRATE},RESOLUTION=${width}x${height}`,
      `${r.name}/video.m3u8`,
    )
  }
  await writeFile(
    path.join(dir, 'playlist.m3u8'),
    ['#EXTM3U', '#EXT-X-VERSION:3', ...variants, ''].join('\n'),
  )
  await run(tools.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-ss',
    String(Math.min(1, info.durationSec / 2)),
    '-i',
    src,
    '-frames:v',
    '1',
    '-vf',
    "scale='if(gte(iw,ih),min(720,iw),-2)':'if(gte(iw,ih),-2,min(720,ih))'",
    '-q:v',
    '3',
    path.join(dir, 'thumbnail.jpg'),
  ])
  onProgress(1)
}
