#!/usr/bin/env node
/*
 * Adds Krao's own labels (labeler-labels.json, eg impersonation-suspect) to
 * the labeler record of Krao's moderation account (app.bsky.labeler.service,
 * rkey self), keeping the labels and settings already there. Run after
 * publishing the labeler record, and again when labeler-labels.json changes:
 *
 *   docker run --rm --env-file .env -e KRAO_LABELER_PASSWORD=... \
 *     krao-backend node services/krao/set-labeler-labels.mjs
 *
 * Env: KRAO_LABELER_PDS_URL (default https://pds.<KRAO_DOMAIN>),
 * KRAO_LABELER_IDENTIFIER (default mod.<KRAO_DOMAIN>), KRAO_LABELER_PASSWORD.
 */
import { readFile } from 'node:fs/promises'

export function mergeLabels(record, extra) {
  const policies = record.policies ?? { labelValues: [] }
  const values = new Set([
    ...(policies.labelValues ?? []),
    ...extra.labelValues,
  ])
  const definitions = (policies.labelValueDefinitions ?? []).filter(
    (d) =>
      !extra.labelValueDefinitions.some((e) => e.identifier === d.identifier),
  )
  return {
    ...record,
    $type: 'app.bsky.labeler.service',
    policies: {
      ...policies,
      labelValues: [...values],
      labelValueDefinitions: [...definitions, ...extra.labelValueDefinitions],
    },
    createdAt: record.createdAt ?? new Date().toISOString(),
  }
}

/** Logs in on `pdsUrl` and merges `extra` into the account's labeler record */
export async function setLabelerLabels({
  pdsUrl,
  identifier,
  password,
  extra,
}) {
  const call = async (method, { body, query, token } = {}) => {
    const url = new URL(`/xrpc/${method}`, pdsUrl)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data }
  }
  const session = await call('com.atproto.server.createSession', {
    body: { identifier, password },
  })
  if (!session.ok) throw new Error(`createSession: ${session.data.message}`)
  const { did, accessJwt } = session.data
  const current = await call('com.atproto.repo.getRecord', {
    query: { repo: did, collection: 'app.bsky.labeler.service', rkey: 'self' },
  })
  const record = mergeLabels(current.ok ? current.data.value : {}, extra)
  const put = await call('com.atproto.repo.putRecord', {
    token: accessJwt,
    body: {
      repo: did,
      collection: 'app.bsky.labeler.service',
      rkey: 'self',
      record,
    },
  })
  if (!put.ok) throw new Error(`putRecord: ${put.data.message}`)
  return { did, labelValues: record.policies.labelValues }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const domain = process.env.KRAO_DOMAIN
  const password = process.env.KRAO_LABELER_PASSWORD
  if (!password) throw new Error('KRAO_LABELER_PASSWORD is required')
  const extra = JSON.parse(
    await readFile(new URL('./labeler-labels.json', import.meta.url), 'utf8'),
  )
  const result = await setLabelerLabels({
    pdsUrl: process.env.KRAO_LABELER_PDS_URL || `https://pds.${domain}`,
    identifier: process.env.KRAO_LABELER_IDENTIFIER || `mod.${domain}`,
    password,
    extra,
  })
  console.log(`Labeler ${result.did}: ${result.labelValues.join(', ')}`)
}
