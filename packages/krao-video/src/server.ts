import path from 'node:path'
import cors from 'cors'
import express, { type Express } from 'express'
import type { DatetimeString } from '@atproto/syntax'
import {
  InvalidRequestError,
  type MethodAuthContext,
  createServer,
} from '@atproto/xrpc-server'
import type { Uploader, VideoAuth } from './auth.js'
import { type JobQueue, hlsDir } from './jobs.js'
import * as lex from './lexicons/index.js'
import {
  PART_SIZE_BYTES,
  type Quotas,
  type UploadLimits,
  type UploadSession,
  type UploadStore,
} from './uploads.js'

const DID_RE = /^did:(plc|web):[a-zA-Z0-9._:%-]{1,2048}$/
const CID_RE = /^b[a-z2-7]{20,100}$/
const RENDITION_RE = /^[0-9]{3,4}p$/
const SEGMENT_RE = /^seg[0-9]{4}\.ts$/

export function createApp(opts: {
  auth: VideoAuth
  uploads: UploadStore
  quotas: Quotas
  jobs: JobQueue
  limits: UploadLimits
  dataDir: string
  serviceDid: string
  publicUrl?: string
}): Express {
  const { auth, uploads, quotas, jobs, limits, dataDir, serviceDid } = opts
  const server = createServer([], {})

  const uploaderAuth = async ({ req }: MethodAuthContext) => ({
    credentials: await auth.uploader(req),
  })

  function statusView(session: UploadSession) {
    const completed = session.state === 'completed'
    const jobStatus = completed ? jobs.get(session.jobId) : undefined
    return {
      jobId: session.jobId,
      partSizeBytes: session.partSizeBytes,
      partCount: session.partCount,
      receivedParts: [...session.received].sort((a, b) => a - b),
      expiresAt: session.expiresAt.toISOString() as DatetimeString,
      state: session.state,
      ...(completed && jobStatus
        ? { completedJobId: session.jobId, jobStatus }
        : {}),
      ...(session.state === 'failed'
        ? { failureReason: session.failureReason }
        : {}),
    }
  }

  server.add(lex.app.bsky.video.getUploadLimits, {
    auth: async ({ req }: MethodAuthContext) => ({
      credentials: await auth.limitsReader(req),
    }),
    handler: async ({ auth: { credentials } }) => {
      const left = quotas.remaining(credentials.did)
      const canUpload = left.videos > 0 && left.bytes > 0
      return {
        encoding: 'application/json' as const,
        body: {
          canUpload,
          remainingDailyVideos: left.videos,
          remainingDailyBytes: left.bytes,
          ...(canUpload
            ? {}
            : {
                message:
                  'You have reached the daily video upload limit. Please try again tomorrow.',
              }),
        },
      }
    },
  })

  server.add(lex.app.bsky.video.startUpload, {
    auth: uploaderAuth,
    handler: async ({ auth: { credentials }, input }) => {
      const session = await uploads.start(credentials.did, input.body)
      return {
        encoding: 'application/json' as const,
        body: {
          jobId: session.jobId,
          partSizeBytes: session.partSizeBytes,
          partCount: session.partCount,
          expiresAt: session.expiresAt.toISOString() as DatetimeString,
        },
      }
    },
  })

  server.add(lex.app.bsky.video.uploadPart, {
    auth: uploaderAuth,
    opts: { blobLimit: PART_SIZE_BYTES },
    handler: async ({ auth: { credentials }, params, input, req }) => {
      const session = uploads.get(credentials.did, params.jobId)
      const contentLength = Number(req.headers['content-length'])
      const body = await uploads.writePart(
        session,
        params.partNumber,
        contentLength,
        input.body as NodeJS.ReadableStream,
      )
      return { encoding: 'application/json' as const, body }
    },
  })

  /*
   * Finishing joins the parts and queues the video for processing. The token
   * on this call (clients refresh it right before finishing) is the one the
   * video is stored on the PDS with.
   */
  const finishing = new Map<string, Promise<void>>()
  async function finish(session: UploadSession, uploader: Uploader) {
    const source = await uploads.assemble(session)
    jobs.add({
      jobId: session.jobId,
      did: session.did,
      source,
      workDir: session.dir,
      pdsUrl: uploader.pdsUrl,
      token: uploader.token,
      onFailed: () => quotas.release(session.did, session.sizeBytes),
    })
    uploads.complete(session)
  }

  server.add(lex.app.bsky.video.finishUpload, {
    auth: uploaderAuth,
    handler: async ({ auth: { credentials }, input }) => {
      const session = uploads.get(credentials.did, input.body.jobId)
      if (session.state === 'created' && !finishing.has(session.jobId)) {
        const done = finish(session, credentials).finally(() =>
          finishing.delete(session.jobId),
        )
        finishing.set(session.jobId, done)
        await done
      } else if (finishing.has(session.jobId)) {
        throw new InvalidRequestError(
          'The upload is being finished',
          'UploadNotReady',
        )
      }
      const jobStatus = jobs.get(session.jobId)
      if (session.state !== 'completed' || !jobStatus) {
        const view = statusView(session)
        throw new InvalidRequestError(
          view.failureReason ?? `The upload is ${session.state}`,
          session.state === 'failed'
            ? 'UploadFailed'
            : session.state === 'aborted'
              ? 'UploadAborted'
              : 'UploadExpired',
        )
      }
      return {
        encoding: 'application/json' as const,
        body: { completedJobId: session.jobId, jobStatus },
      }
    },
  })

  server.add(lex.app.bsky.video.getUploadStatus, {
    auth: uploaderAuth,
    handler: async ({ auth: { credentials }, params }) => {
      const session = uploads.get(credentials.did, params.jobId)
      return {
        encoding: 'application/json' as const,
        body: statusView(session),
      }
    },
  })

  server.add(lex.app.bsky.video.abortUpload, {
    auth: uploaderAuth,
    handler: async ({ auth: { credentials }, input }) => {
      const session = uploads.get(credentials.did, input.body.jobId)
      await uploads.abort(session)
      const view = statusView(session)
      return {
        encoding: 'application/json' as const,
        body: {
          state: view.state as 'aborted' | 'completed' | 'failed' | 'expired',
          ...(view.completedJobId
            ? { completedJobId: view.completedJobId }
            : {}),
          ...(view.failureReason ? { failureReason: view.failureReason } : {}),
        },
      }
    },
  })

  server.add(lex.app.bsky.video.getJobStatus, async ({ params }) => {
    const jobStatus = jobs.get(params.jobId)
    if (!jobStatus) {
      throw new InvalidRequestError('Unknown job', 'JobNotFound')
    }
    return { encoding: 'application/json' as const, body: { jobStatus } }
  })

  const app = express()
  app.set('trust proxy', true)
  app.use(cors())
  // Plain landing text so uptime checks on the bare host get a 200
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Krao video service. Health: /_health')
  })
  app.get('/_health', (_req, res) => {
    res.json({ ok: true, maxBytes: limits.maxBytes })
  })

  if (opts.publicUrl && serviceDid.startsWith('did:web:')) {
    app.get('/.well-known/did.json', (_req, res) => {
      res.json({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: serviceDid,
        service: [
          {
            id: '#bsky_video',
            type: 'BskyVideoService',
            serviceEndpoint: opts.publicUrl,
          },
        ],
      })
    })
  }

  /*
   * HLS playback, at the URLs the AppView hands out
   * (BSKY_VIDEO_PLAYLIST_URL_PATTERN / BSKY_VIDEO_THUMBNAIL_URL_PATTERN). The
   * files are content addressed (did + blob cid), so they are cached for good.
   */
  const sendVideoFile =
    (file: (p: Record<string, string>) => string | null, type: string) =>
    (req: express.Request, res: express.Response) => {
      const { did, cid } = req.params
      const name =
        DID_RE.test(did) && CID_RE.test(cid) ? file(req.params) : null
      if (!name) {
        res.status(400).json({ error: 'InvalidRequest' })
        return
      }
      res.sendFile(
        path.join(hlsDir(dataDir, did, cid), name),
        {
          headers: {
            'content-type': type,
            'cache-control': 'public, max-age=31536000, immutable',
          },
          dotfiles: 'deny',
        },
        (err) => {
          if (err && !res.headersSent) {
            res.status(404).json({ error: 'NotFound' })
          }
        },
      )
    }
  app.get(
    '/watch/:did/:cid/playlist.m3u8',
    sendVideoFile(() => 'playlist.m3u8', 'application/vnd.apple.mpegurl'),
  )
  app.get(
    '/watch/:did/:cid/thumbnail.jpg',
    sendVideoFile(() => 'thumbnail.jpg', 'image/jpeg'),
  )
  app.get(
    '/watch/:did/:cid/:rendition/video.m3u8',
    sendVideoFile(
      ({ rendition }) =>
        RENDITION_RE.test(rendition)
          ? path.join(rendition, 'video.m3u8')
          : null,
      'application/vnd.apple.mpegurl',
    ),
  )
  app.get(
    '/watch/:did/:cid/:rendition/:segment',
    sendVideoFile(
      ({ rendition, segment }) =>
        RENDITION_RE.test(rendition) && SEGMENT_RE.test(segment)
          ? path.join(rendition, segment)
          : null,
      'video/mp2t',
    ),
  )

  app.use(server.router)
  return app
}
