import { exportCommunityData } from './community.js'
import type { Database } from './db.js'
import type { StoredGatedMedia } from './gate.js'
import { exportMembershipData } from './membership.js'
import { exportPollData } from './poll.js'

const MAX_ROWS = 10_000

const parse = (json: string | null) => {
  if (!json) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

/** Drops null and undefined values, which lexicon data leaves out */
export function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmpty)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, withoutEmpty(v)]),
    )
  }
  return value
}

/**
 * What the indexer holds about an account (its own records, as indexed and
 * checked, plus the gated content it gave this service): linked wallets
 * and their verified Basename/ENS name,
 * tips sent and received, gate rules and gated content, NFT avatar,
 * community records, polls, membership plans and payments, Mini Apps.
 * `mediaUrl` signs links to its gated media.
 */
export async function exportIndexerData(
  db: Database,
  did: string,
  mediaUrl: (id: string) => string,
) {
  const tipColumns = [
    'uri',
    'did',
    'recipient',
    'subject',
    'asset',
    'amount',
    'txHash',
    'message',
    'anonymous',
    'status',
    'createdAt',
  ] as const
  const [
    wallets,
    tipsSent,
    tipsReceived,
    rules,
    content,
    nftAvatar,
    primaryName,
    miniApps,
  ] = await Promise.all([
    db
      .selectFrom('wallet')
      .select([
        'uri',
        'accountRaw',
        'label',
        'status',
        'showPrimaryName',
        'createdAt',
      ])
      .where('did', '=', did)
      .execute(),
    db
      .selectFrom('tip')
      .select(tipColumns)
      .where('did', '=', did)
      .orderBy('createdAt', 'desc')
      .limit(MAX_ROWS)
      .execute(),
    db
      .selectFrom('tip')
      .select(tipColumns)
      .where('recipient', '=', did)
      .orderBy('createdAt', 'desc')
      .limit(MAX_ROWS)
      .execute(),
    db
      .selectFrom('gate_rule')
      .select(['uri', 'subject', 'conditions', 'match', 'createdAt'])
      .where('did', '=', did)
      .limit(MAX_ROWS)
      .execute(),
    db
      .selectFrom('gated_content')
      .select(['subject', 'text', 'facets', 'media', 'updatedAt'])
      .where('did', '=', did)
      .limit(MAX_ROWS)
      .execute(),
    db
      .selectFrom('nft_avatar')
      .select([
        'uri',
        'chain',
        'contract',
        'tokenId',
        'wallet',
        'status',
        'collectionName',
      ])
      .where('did', '=', did)
      .executeTakeFirst(),
    db
      .selectFrom('primary_name')
      .select(['name', 'source', 'address', 'checkedAt'])
      .where('did', '=', did)
      .where('name', 'is not', null)
      .executeTakeFirst(),
    // Mini Apps the account publishes, with Krao's review of them
    db
      .selectFrom('miniapp')
      .select([
        'uri',
        'cid',
        'name',
        'description',
        'url',
        'permissions',
        'chains',
        'invalidReason',
        'approvedCid',
        'approvedAt',
        'revokedAt',
        'revokedReason',
        'createdAt',
      ])
      .where('did', '=', did)
      .limit(MAX_ROWS)
      .execute(),
  ])
  const tipView = (t: (typeof tipsSent)[number]) => ({
    uri: t.uri,
    sender: t.did,
    recipient: t.recipient,
    subject: t.subject,
    asset: t.asset,
    amount: t.amount,
    txHash: t.txHash,
    message: t.message,
    anonymous: t.anonymous === 1,
    status: t.status,
    createdAt: t.createdAt,
  })
  return withoutEmpty({
    wallets: wallets.map((w) => ({
      uri: w.uri,
      account: w.accountRaw,
      label: w.label,
      status: w.status,
      showPrimaryName: w.showPrimaryName !== 0,
      createdAt: w.createdAt,
    })),
    primaryName: primaryName ?? null,
    tipsSent: tipsSent.map(tipView),
    tipsReceived: tipsReceived.map(tipView),
    gateRules: rules.map((r) => ({
      uri: r.uri,
      subject: r.subject,
      conditions: parse(r.conditions),
      match: r.match,
      createdAt: r.createdAt,
    })),
    gatedContent: content.map((c) => ({
      subject: c.subject,
      text: c.text,
      facets: parse(c.facets),
      media: ((parse(c.media) ?? []) as StoredGatedMedia[]).map((m) => ({
        url: mediaUrl(m.id),
        mimeType: m.mimeType,
        alt: m.alt,
      })),
      updatedAt: c.updatedAt,
    })),
    nftAvatar: nftAvatar ?? null,
    miniApps: miniApps.map((m) => ({
      ...m,
      permissions: parse(m.permissions),
      chains: parse(m.chains),
    })),
    ...(await exportCommunityData(db, did)),
    ...(await exportPollData(db, did)),
    ...(await exportMembershipData(db, did)),
  })
}
