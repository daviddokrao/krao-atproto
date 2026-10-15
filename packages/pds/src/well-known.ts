import { Router } from 'express'
import type { HandleString } from '@atproto/syntax'
import type { AppContext } from './context.js'

export const createRouter = (ctx: AppContext): Router => {
  const router = Router()

  router.get('/.well-known/atproto-did', async function (req, res) {
    const handle = req.hostname as HandleString
    const supportedHandle =
      !ctx.cfg.entryway &&
      ctx.cfg.identity.serviceHandleDomains.some(
        (host) => handle.endsWith(host) || handle === host.slice(1),
      )
    if (!supportedHandle) {
      return res.status(404).send('User not found')
    }
    let did: string | undefined
    try {
      const user = await ctx.accountManager.getAccount(handle)
      did = user?.did
    } catch (err) {
      return res.status(500).send('Internal Server Error')
    }
    if (!did) {
      return res.status(404).send('User not found')
    }
    res.type('text/plain').send(did)
  })

  /*
   * Krao: for a TLS proxy issuing certificates on demand (Caddy's
   * on_demand_tls `ask`), so that `https://<handle>/.well-known/atproto-did`
   * works. Yes (200) only for this PDS's hostname and handles it hosts.
   */
  router.get('/tls-check', async function (req, res) {
    const domain = typeof req.query.domain === 'string' ? req.query.domain : ''
    if (domain && domain === ctx.cfg.service.hostname) {
      return res.send('ok')
    }
    const supported = ctx.cfg.identity.serviceHandleDomains.some((host) =>
      domain.endsWith(host),
    )
    if (!supported) return res.status(400).send('Unknown domain')
    const user = await ctx.accountManager
      .getAccount(domain as HandleString)
      .catch(() => null)
    if (!user) return res.status(404).send('Unknown handle')
    res.send('ok')
  })

  return router
}
