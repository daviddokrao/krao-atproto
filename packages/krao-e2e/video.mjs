// Video upload through the Krao video service, the way the app does it:
// multipart upload -> processing -> blob on the PDS -> post -> HLS playback
// at the URLs the AppView hands out. Needs ffmpeg on the PATH (to make the
// test video, and for the video service itself).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ACCOUNTS,
  APPVIEW,
  PDS,
  checker,
  createRecord,
  login,
  xrpc,
} from './lib.mjs'

const VIDEO = process.env.KRAO_VIDEO_URL ?? 'http://localhost:2591'
const VIDEO_DID = process.env.KRAO_VIDEO_DID ?? 'did:web:video.krao.test'
const { check, done } = checker()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A 4 second 640x360 clip with sound at a constant 30 Mbit/s (~15 MB), so it
// spans more than one part
const dir = mkdtempSync(path.join(tmpdir(), 'krao-e2e-video-'))
const file = path.join(dir, 'clip.mp4')
execFileSync('ffmpeg', [
  ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30'],
  ...['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4'],
  ...['-c:v', 'libx264', '-b:v', '30M', '-minrate', '30M', '-maxrate', '30M'],
  ...['-bufsize', '30M', '-x264-params', 'nal-hrd=cbr:force-cfr=1'],
  ...['-c:a', 'aac', '-pix_fmt', 'yuv420p', file],
])
const bytes = readFileSync(file)
rmSync(dir, { recursive: true, force: true })

const session = await login(ACCOUNTS.krao)
const other = await login(ACCOUNTS.minh)
const pdsDid = (await xrpc(PDS, 'com.atproto.server.describeServer')).data.did

async function serviceAuth(who, aud, lxm) {
  const res = await xrpc(PDS, 'com.atproto.server.getServiceAuth', {
    token: who.accessJwt,
    query: { aud, lxm, exp: Math.floor(Date.now() / 1000) + 1800 },
  })
  if (!res.ok) throw new Error(`getServiceAuth: ${res.data.error}`)
  return res.data.token
}
const uploadToken = (who) =>
  serviceAuth(who, pdsDid, 'com.atproto.repo.uploadBlob')

async function sendPart(token, jobId, partNumber, chunk) {
  const url = new URL('/xrpc/app.bsky.video.uploadPart', VIDEO)
  url.searchParams.set('jobId', jobId)
  url.searchParams.set('partNumber', String(partNumber))
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    body: chunk,
  })
  return { ok: res.ok, status: res.status, data: await res.json() }
}

const limits = await xrpc(VIDEO, 'app.bsky.video.getUploadLimits', {
  token: await serviceAuth(
    session,
    VIDEO_DID,
    'app.bsky.video.getUploadLimits',
  ),
})
check(
  'getUploadLimits allows uploading',
  limits.ok && limits.data.canUpload === true,
  JSON.stringify(limits.data),
)

const token = await uploadToken(session)
const wrongAud = await xrpc(VIDEO, 'app.bsky.video.startUpload', {
  token: await serviceAuth(session, VIDEO_DID, 'com.atproto.repo.uploadBlob'),
  body: { sizeBytes: bytes.length, mimeType: 'video/mp4' },
})
check(
  'a token not addressed to the PDS is refused',
  wrongAud.status === 401,
  `${wrongAud.status} ${wrongAud.data.error}`,
)
const unsupported = await xrpc(VIDEO, 'app.bsky.video.startUpload', {
  token,
  body: { sizeBytes: 10, mimeType: 'application/pdf' },
})
check(
  'unsupported types are refused',
  unsupported.data.error === 'UnsupportedContentType',
  unsupported.data.error,
)

const started = await xrpc(VIDEO, 'app.bsky.video.startUpload', {
  token,
  body: { sizeBytes: bytes.length, mimeType: 'video/mp4', name: 'clip.mp4' },
})
const { jobId, partSizeBytes, partCount } = started.data
check(
  'startUpload plans the parts',
  started.ok &&
    partCount === Math.ceil(bytes.length / partSizeBytes) &&
    partCount >= 2,
  `${bytes.length} bytes -> ${partCount} x ${partSizeBytes}`,
)

const short = await sendPart(token, jobId, 1, bytes.subarray(0, 10))
check(
  'a part of the wrong size is refused',
  short.data.error === 'PartSizeMismatch',
  short.data.error,
)
const outOfRange = await sendPart(
  token,
  jobId,
  partCount + 1,
  bytes.subarray(0, 1),
)
check(
  'a part number out of range is refused',
  outOfRange.data.error === 'InvalidPartNumber',
  outOfRange.data.error,
)
const early = await xrpc(VIDEO, 'app.bsky.video.finishUpload', {
  token,
  body: { jobId },
})
check(
  'finishing before every part is in reports the missing parts',
  early.data.error === 'MissingParts',
  early.data.message,
)

// Upload the parts last to first, as concurrent clients may
for (let n = partCount; n >= 1; n--) {
  const chunk = bytes.subarray((n - 1) * partSizeBytes, n * partSizeBytes)
  const res = await sendPart(token, jobId, n, chunk)
  if (!res.ok) check(`part ${n} uploads`, false, res.data.error)
}
const status = await xrpc(VIDEO, 'app.bsky.video.getUploadStatus', {
  token,
  query: { jobId },
})
check(
  'getUploadStatus lists every part',
  status.data.state === 'created' &&
    status.data.receivedParts?.length === partCount,
  JSON.stringify(status.data.receivedParts),
)
const otherStatus = await xrpc(VIDEO, 'app.bsky.video.getUploadStatus', {
  token: await uploadToken(other),
  query: { jobId },
})
check(
  'another account cannot see the upload',
  otherStatus.data.error === 'UploadNotFound',
  otherStatus.data.error,
)

const finished = await xrpc(VIDEO, 'app.bsky.video.finishUpload', {
  token: await uploadToken(session),
  body: { jobId },
})
check(
  'finishUpload starts processing',
  finished.ok && finished.data.completedJobId === jobId,
  JSON.stringify(finished.data),
)
const again = await xrpc(VIDEO, 'app.bsky.video.finishUpload', {
  token,
  body: { jobId },
})
check('finishUpload is idempotent', again.data.completedJobId === jobId)

let job
for (let i = 0; i < 120; i++) {
  const res = await xrpc(VIDEO, 'app.bsky.video.getJobStatus', {
    query: { jobId },
  })
  job = res.data.jobStatus
  if (['JOB_STATE_COMPLETED', 'JOB_STATE_FAILED'].includes(job?.state)) break
  await sleep(1000)
}
check(
  'the job completes with a blob',
  job?.state === 'JOB_STATE_COMPLETED' && !!job.blob?.ref?.$link,
  job?.error ?? job?.state,
)
check(
  'the blob is an mp4',
  job?.blob?.mimeType === 'video/mp4',
  job?.blob?.mimeType,
)

const post = await createRecord(session, 'app.bsky.feed.post', {
  text: 'Krao video e2e',
  createdAt: new Date().toISOString(),
  embed: {
    $type: 'app.bsky.embed.video',
    video: job?.blob,
    aspectRatio: { width: 16, height: 9 },
  },
})
check('the post with the video is accepted', post.ok, post.data.message)

let view
for (let i = 0; i < 20 && post.ok; i++) {
  const res = await xrpc(APPVIEW, 'app.bsky.feed.getPosts', {
    query: { uris: post.data.uri },
  })
  view = res.data.posts?.[0]?.embed
  if (view) break
  await sleep(500)
}
const cid = job?.blob?.ref?.$link
// The AppView percent-encodes the DID in the URL
const watch = `${VIDEO}/watch/${encodeURIComponent(session.did)}/${cid}`
check(
  'the AppView points the player at the video service',
  view?.playlist === `${watch}/playlist.m3u8` &&
    view?.thumbnail === `${watch}/thumbnail.jpg`,
  view?.playlist,
)

if (view?.playlist) {
  const master = await fetch(view.playlist)
  const masterText = await master.text()
  check(
    'the HLS playlist is served',
    master.ok &&
      master.headers.get('content-type') === 'application/vnd.apple.mpegurl' &&
      masterText.startsWith('#EXTM3U') &&
      masterText.includes('360p/video.m3u8'),
    masterText.split('\n').slice(0, 3).join(' '),
  )
  const variant = await fetch(new URL('360p/video.m3u8', view.playlist))
  const segment = (await variant.text())
    .split('\n')
    .find((line) => line.endsWith('.ts'))
  const ts = segment
    ? await fetch(new URL(`360p/${segment}`, view.playlist))
    : undefined
  check(
    'video segments are served',
    ts?.ok && ts.headers.get('content-type') === 'video/mp2t',
    segment,
  )
  const thumb = await fetch(view.thumbnail)
  check(
    'the thumbnail is served',
    thumb.ok && thumb.headers.get('content-type') === 'image/jpeg',
  )
}
const traversal = await fetch(`${watch}/..%2F..%2Fuploads/video.m3u8`)
check('paths outside a video are refused', traversal.status === 400)

const aborted = await xrpc(VIDEO, 'app.bsky.video.startUpload', {
  token,
  body: { sizeBytes: 100, mimeType: 'video/mp4' },
})
const abort = await xrpc(VIDEO, 'app.bsky.video.abortUpload', {
  token,
  body: { jobId: aborted.data.jobId },
})
const afterAbort = await sendPart(
  token,
  aborted.data.jobId,
  1,
  new Uint8Array(100),
)
check(
  'an aborted upload takes no more parts',
  abort.data.state === 'aborted' && afterAbort.data.error === 'UploadAborted',
  `${abort.data.state} ${afterAbort.data.error}`,
)
done()
