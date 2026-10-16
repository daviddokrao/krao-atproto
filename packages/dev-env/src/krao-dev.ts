import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import type { TestNetwork } from './network.js'

/*
 * Krao dev-env helpers (M34): the sample Mini App, and Krao's OAuth
 * permission sets published where the dev PDS resolves lexicons.
 */

/** The repository root, from packages/dev-env/{src,dist} */
const repoFile = (relative: string) =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url))

/**
 * Serves services/krao/miniapp-sample/index.html at http://localhost:<port>/
 * (another origin than the web app, as Mini Apps must be). Read on every
 * request, so edits show without a restart.
 */
export async function serveMiniAppSample(port: number): Promise<http.Server> {
  const file = repoFile('services/krao/miniapp-sample/index.html')
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method !== 'GET' || !['/', '/index.html'].includes(pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    try {
      const html = await readFile(file)
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end(html)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('No sample')
    }
  })
  server.listen(port)
  await once(server, 'listening')
  return server
}

/** Krao's permission sets (lexicons/net/krao/auth*.json) */
export const KRAO_PERMISSION_SETS = [
  'net.krao.authWeb3',
  'net.krao.authMiniApp',
]

/**
 * Publishes Krao's permission sets in the dev-env's lexicon authority repo
 * (lex-authority.test, which the dev PDS resolves every NSID to), then
 * checks that the PDS's OAuth provider resolves `include:` scopes for them.
 * Production publishes them in Krao's own repo, found through DNS
 * (services/krao/deploy/dns-lexicon.md).
 */
export async function publishKraoPermissionSets(
  network: TestNetwork,
): Promise<{ published: string[]; resolved: string[] }> {
  const authority = network.pds.ctx.cfg.lexicon.didAuthority
  if (!authority) return { published: [], resolved: [] }
  const doc = (await (
    await fetch(`${network.plc.url}/${encodeURIComponent(authority)}`)
  ).json()) as { service?: { id: string; serviceEndpoint: string }[] }
  const pds = doc.service?.find((s) => s.id === '#atproto_pds')?.serviceEndpoint
  if (!pds) return { published: [], resolved: [] }
  const call = async (method: string, body: unknown, token?: string) => {
    const res = await fetch(`${pds}/xrpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, string>
    if (!res.ok) throw new Error(`${method}: ${data.message ?? res.status}`)
    return data
  }
  // The account LexiconAuthorityProfile creates (service-profile-lexicon.ts)
  const session = await call('com.atproto.server.createSession', {
    identifier: 'lex-authority.test',
    password: 'hunter2',
  })
  const published: string[] = []
  for (const nsid of KRAO_PERMISSION_SETS) {
    const lexicon = JSON.parse(
      await readFile(
        repoFile(`lexicons/${nsid.split('.').join('/')}.json`),
        'utf8',
      ),
    )
    await call(
      'com.atproto.repo.putRecord',
      {
        repo: session.did,
        collection: 'com.atproto.lexicon.schema',
        rkey: nsid,
        record: { $type: 'com.atproto.lexicon.schema', ...lexicon },
      },
      session.accessJwt,
    )
    published.push(nsid)
  }
  const resolved: string[] = []
  const manager = network.pds.ctx.oauthProvider?.lexiconManager
  for (const nsid of published) {
    const sets = await manager
      ?.getPermissionSetsFromScope(`include:${nsid}`)
      .catch(() => undefined)
    if (sets?.get(nsid as never)?.type === 'permission-set') resolved.push(nsid)
  }
  return { published, resolved }
}

/**
 * Adds Krao's own labels (services/krao/labeler-labels.json, eg
 * impersonation-suspect) to the dev-env labeler record (Ozone's account,
 * mod-authority.test), as services/krao/set-labeler-labels.mjs does in
 * production. Returns the label values the record lists.
 */
export async function addKraoLabels(network: TestNetwork): Promise<string[]> {
  const extra = JSON.parse(
    await readFile(repoFile('services/krao/labeler-labels.json'), 'utf8'),
  ) as {
    labelValues: string[]
    labelValueDefinitions: { identifier: string }[]
  }
  const call = async (
    method: string,
    opts: { body?: unknown; query?: Record<string, string>; token?: string },
  ) => {
    const url = new URL(`/xrpc/${method}`, network.pds.url)
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      url.searchParams.set(k, v)
    }
    const res = await fetch(url, {
      method: opts.body ? 'POST' : 'GET',
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, any>
    if (!res.ok) throw new Error(`${method}: ${data.message ?? res.status}`)
    return data
  }
  // The account OzoneServiceProfile creates (service-profile-ozone.ts)
  const session = await call('com.atproto.server.createSession', {
    body: { identifier: 'mod-authority.test', password: 'hunter2' },
  })
  const current = await call('com.atproto.repo.getRecord', {
    query: {
      repo: session.did,
      collection: 'app.bsky.labeler.service',
      rkey: 'self',
    },
  })
  const record = current.value as {
    policies: {
      labelValues: string[]
      labelValueDefinitions?: { identifier: string }[]
    }
  }
  const labelValues = [
    ...new Set([...record.policies.labelValues, ...extra.labelValues]),
  ]
  await call('com.atproto.repo.putRecord', {
    token: session.accessJwt,
    body: {
      repo: session.did,
      collection: 'app.bsky.labeler.service',
      rkey: 'self',
      record: {
        ...record,
        policies: {
          ...record.policies,
          labelValues,
          labelValueDefinitions: [
            ...(record.policies.labelValueDefinitions ?? []).filter(
              (d) =>
                !extra.labelValueDefinitions.some(
                  (e) => e.identifier === d.identifier,
                ),
            ),
            ...extra.labelValueDefinitions,
          ],
        },
      },
    },
  })
  return labelValues
}
