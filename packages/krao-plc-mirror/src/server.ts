import express, { type Express } from 'express'
import { sql } from 'kysely'
import { PlcMirror } from './mirror.js'

/*
 * The read side of a PLC directory (GET /:did, /:did/data, /:did/log,
 * /:did/log/last, /:did/log/audit) from the mirror, POST /:did passed to the
 * source, and /_health with how far behind the source the mirror may be.
 */

const notFound = (res: express.Response, did: string) =>
  res.status(404).json({ message: `DID not registered: ${did}` })

const gone = (res: express.Response, did: string) =>
  res.status(404).json({ message: `DID not available: ${did}` })

export function createApp(mirror: PlcMirror): Express {
  const app = express()
  app.set('trust proxy', 'loopback, linklocal, uniquelocal')
  app.disable('x-powered-by')

  app.get('/', (_req, res) => {
    res.type('text/plain').send('Krao PLC mirror. Health: /_health')
  })

  app.get('/_health', async (_req, res) => {
    try {
      await sql`select 1`.execute(mirror.db)
    } catch {
      res.status(503).json({ ok: false, error: 'Database' })
      return
    }
    const count = await mirror.db
      .selectFrom('op')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst()
    res.json({
      ok: true,
      source: mirror.source,
      ops: Number(count?.n ?? 0),
      cursor: (await mirror.getState('cursor')) ?? null,
      lagSeconds: mirror.lagSeconds(),
      caughtUpAt: mirror.stats.caughtUpAt,
      lastPollAt: mirror.stats.lastPollAt,
      lastError: mirror.stats.lastError,
      rejected: mirror.stats.rejected,
    })
  })

  const didParam = (req: express.Request) => {
    const did = String(req.params.did ?? '')
    return did.startsWith('did:plc:') ? did : null
  }

  app.get('/:did', async (req, res, next) => {
    const did = didParam(req)
    if (!did) return notFound(res, String(req.params.did))
    try {
      const doc = await mirror.didDoc(did)
      if (doc === undefined) return notFound(res, did)
      if (doc === null) return gone(res, did)
      res.type('application/did+ld+json').send(JSON.stringify(doc))
    } catch (err) {
      next(err)
    }
  })

  app.get('/:did/data', async (req, res, next) => {
    const did = didParam(req)
    if (!did) return notFound(res, String(req.params.did))
    try {
      const data = await mirror.data(did)
      if (data === undefined) return notFound(res, did)
      if (data === null) return gone(res, did)
      res.json(data)
    } catch (err) {
      next(err)
    }
  })

  app.get('/:did/log', async (req, res, next) => {
    const did = didParam(req)
    if (!did) return notFound(res, String(req.params.did))
    try {
      const ops = await mirror.opsOrFetch(did)
      if (!ops.length) return notFound(res, did)
      res.json(PlcMirror.log(ops))
    } catch (err) {
      next(err)
    }
  })

  app.get('/:did/log/audit', async (req, res, next) => {
    const did = didParam(req)
    if (!did) return notFound(res, String(req.params.did))
    try {
      const ops = await mirror.opsOrFetch(did, true)
      if (!ops.length) return notFound(res, did)
      res.json(
        ops.map((o) => ({
          did: o.did,
          operation: o.operation,
          cid: o.cid,
          nullified: o.nullified,
          createdAt: o.createdAt,
        })),
      )
    } catch (err) {
      next(err)
    }
  })

  app.get('/:did/log/last', async (req, res, next) => {
    const did = didParam(req)
    if (!did) return notFound(res, String(req.params.did))
    try {
      const ops = await mirror.opsOrFetch(did)
      const last = ops[ops.length - 1]
      if (!last) return notFound(res, did)
      res.json(last.operation)
    } catch (err) {
      next(err)
    }
  })

  // Writes go to the source; the mirror takes what it accepts
  app.post(
    '/:did',
    express.json({ limit: '100kb' }),
    async (req, res, next) => {
      const did = didParam(req)
      if (!did) {
        res.status(400).json({ message: 'Not a did:plc' })
        return
      }
      try {
        const answer = await mirror.forward(did, req.body)
        res.status(answer.status).type(answer.contentType).send(answer.body)
      } catch (err) {
        console.error('Krao PLC mirror: forwarding failed', err)
        res.status(502).json({ message: 'The PLC directory did not answer' })
        void next
      }
    },
  )

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if ((err as { type?: string })?.type === 'entity.parse.failed') {
        res.status(400).json({ message: 'Invalid JSON' })
        return
      }
      console.error('Krao PLC mirror: request failed', err)
      res.status(500).json({ message: 'Internal error' })
    },
  )
  return app
}
