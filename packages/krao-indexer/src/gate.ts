import { AtUri } from '@atproto/syntax'
import { type EvmRpc, parseAssetId } from './chain.js'
import { type Database, type GateRuleTable, visibleDid } from './db.js'
import { erc1155BalanceOf, erc721OwnerOf, parseTokenId } from './nft.js'
import { ownedEvmAddresses } from './wallets.js'

export const GATE_RULE_COLLECTION = 'net.krao.gate.rule'

/** balanceOf(address): ERC-20 balance or ERC-721 token count */
const BALANCE_OF = '0x70a08231'

export type TokenBalanceCondition = {
  $type: 'net.krao.gate.defs#tokenBalance'
  asset: string
  minAmount: string
}

export type NftHoldingCondition = {
  $type: 'net.krao.gate.defs#nftHolding'
  chain: string
  contract: string
  tokenId?: string
}

/** Members of a Krao community (see community.ts) */
export type CommunityMemberCondition = {
  $type: 'net.krao.gate.defs#communityMember'
  community: string
}

/** Active members of a creator (see membership.ts) */
export type MembershipCondition = {
  $type: 'net.krao.gate.defs#membership'
  creator: string
  plan?: string
}

/** Conditions checked on the viewer's wallets */
export type ChainCondition = TokenBalanceCondition | NftHoldingCondition

export type GateCondition =
  ChainCondition | CommunityMemberCondition | MembershipCondition

/** What isEligible needs beyond the chain */
export type EligibilityContext = {
  /** Whether `did` is a member in good standing of the community */
  isCommunityMember?: (community: string, did: string) => Promise<boolean>
  /** Whether `did` is an active member of the creator (of `plan`, if set) */
  isCreatorMember?: (
    creator: string,
    plan: string | undefined,
    did: string,
  ) => Promise<boolean>
}

/**
 * Turn an net.krao.gate.rule record into a row. Returns null when the rule
 * points at a post in someone else's repo, which would let anyone gate
 * other people's posts.
 */
export function gateRuleRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): GateRuleTable | null {
  const value = (record ?? {}) as Record<string, unknown>
  const subject = (value.subject ?? {}) as { uri?: unknown }
  if (typeof subject.uri !== 'string') return null
  let subjectUri: AtUri
  try {
    subjectUri = new AtUri(subject.uri)
  } catch {
    return null
  }
  if (subjectUri.host !== did) return null
  const conditions = Array.isArray(value.conditions)
    ? value.conditions.filter(isCondition).slice(0, 5)
    : []
  if (!conditions.length) return null
  const now = new Date().toISOString()
  return {
    uri,
    did,
    subject: subject.uri,
    conditions: JSON.stringify(conditions),
    match: value.match === 'any' ? 'any' : 'all',
    service: typeof value.service === 'string' ? value.service : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : now,
    indexedAt: now,
  }
}

function isCondition(c: unknown): c is GateCondition {
  const v = c as Record<string, unknown>
  if (v?.$type === 'net.krao.gate.defs#communityMember') {
    if (typeof v.community !== 'string') return false
    try {
      return new AtUri(v.community).collection === 'net.krao.community.profile'
    } catch {
      return false
    }
  }
  if (v?.$type === 'net.krao.gate.defs#membership') {
    if (typeof v.creator !== 'string' || !v.creator.startsWith('did:')) {
      return false
    }
    if (v.plan === undefined) return true
    if (typeof v.plan !== 'string') return false
    try {
      const plan = new AtUri(v.plan)
      return (
        plan.host === v.creator &&
        plan.collection === 'net.krao.membership.plan'
      )
    } catch {
      return false
    }
  }
  return isChainCondition(c)
}

/** A token balance or NFT condition (gates, community access) */
export function isChainCondition(c: unknown): c is ChainCondition {
  const v = c as Record<string, unknown>
  if (v?.$type === 'net.krao.gate.defs#tokenBalance') {
    return typeof v.asset === 'string' && typeof v.minAmount === 'string'
  }
  if (v?.$type === 'net.krao.gate.defs#nftHolding') {
    return typeof v.chain === 'string' && typeof v.contract === 'string'
  }
  return false
}

export async function upsertGateRule(db: Database, row: GateRuleTable) {
  await db
    .insertInto('gate_rule')
    .values(row)
    .onConflict((oc) => oc.column('uri').doUpdateSet(row))
    .execute()
}

/**
 * Delete a rule record's row. Once a post has no rule left, its gated content
 * goes too: removing the gate is how authors take the content down.
 */
export async function deleteGateRule(db: Database, uri: string) {
  const rule = await db
    .selectFrom('gate_rule')
    .select(['subject', 'indexedAt'])
    .where('uri', '=', uri)
    .executeTakeFirst()
  await db.deleteFrom('gate_rule').where('uri', '=', uri).execute()
  if (!rule) return
  const remaining = await db
    .selectFrom('gate_rule')
    .select('uri')
    .where('subject', '=', rule.subject)
    .executeTakeFirst()
  if (!remaining) {
    // Content stored after the rule was indexed belongs to a new gate whose
    // rule has not arrived yet (remove, then add again right away)
    await db
      .deleteFrom('gated_content')
      .where('subject', '=', rule.subject)
      .where('updatedAt', '<=', rule.indexedAt)
      .execute()
  }
}

/** A deleted post takes its gates and gated content with it */
export async function deleteGateDataForSubject(db: Database, subject: string) {
  await db.deleteFrom('gate_rule').where('subject', '=', subject).execute()
  await db.deleteFrom('gated_content').where('subject', '=', subject).execute()
}

/**
 * Gated content whose post never got a rule (the rule write failed after the
 * content was stored) is never served; drop it after a day.
 */
export async function deleteContentWithoutRule(
  db: Database,
  now = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const result = await db
    .deleteFrom('gated_content')
    .where('updatedAt', '<', cutoff)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('gate_rule')
            .select('gate_rule.uri')
            .whereRef('gate_rule.subject', '=', 'gated_content.subject'),
        ),
      ),
    )
    .executeTakeFirst()
  return Number(result.numDeletedRows)
}

export async function deleteGateDataForDid(db: Database, did: string) {
  await db.deleteFrom('gate_rule').where('did', '=', did).execute()
  await db.deleteFrom('gated_content').where('did', '=', did).execute()
  await db.deleteFrom('gated_media').where('did', '=', did).execute()
}

/** The most recent rule for each of the given posts */
export async function getRulesForSubjects(db: Database, subjects: string[]) {
  if (!subjects.length) return []
  const rows = await db
    .selectFrom('gate_rule')
    .selectAll()
    .where('subject', 'in', subjects)
    // A hidden (taken down) author's gated content is not served
    .where(visibleDid('did'))
    .orderBy('createdAt', 'desc')
    .execute()
  const latest = new Map<string, GateRuleTable>()
  for (const row of rows) {
    if (!latest.has(row.subject)) latest.set(row.subject, row)
  }
  return [...latest.values()]
}

export async function putGatedContent(
  db: Database,
  content: {
    subject: string
    did: string
    text: string
    facets: unknown
    media?: StoredGatedMedia[]
  },
) {
  const row = {
    subject: content.subject,
    did: content.did,
    text: content.text,
    facets: content.facets ? JSON.stringify(content.facets) : null,
    media: content.media?.length ? JSON.stringify(content.media) : null,
    updatedAt: new Date().toISOString(),
  }
  await db
    .insertInto('gated_content')
    .values(row)
    .onConflict((oc) => oc.column('subject').doUpdateSet(row))
    .execute()
}

/** How gated content refers to its media (the URL is signed per viewer) */
export type StoredGatedMedia = {
  id: string
  mimeType: string
  alt?: string
  aspectRatio?: { width: number; height: number }
}

export async function getGatedContent(db: Database, subject: string) {
  return db
    .selectFrom('gated_content')
    .selectAll()
    .where('subject', '=', subject)
    .executeTakeFirst()
}

export async function subjectsWithContent(db: Database, subjects: string[]) {
  if (!subjects.length) return new Set<string>()
  const rows = await db
    .selectFrom('gated_content')
    .select('subject')
    .where('subject', 'in', subjects)
    .execute()
  return new Set(rows.map((r) => r.subject))
}

/** EVM addresses an account owns (see ownedEvmAddresses), sorted */
async function linkedEvmAddresses(db: Database, did: string) {
  return [...(await ownedEvmAddresses(db, did))].sort()
}

/*
 * Eligibility is checked on-chain, which costs a few RPC calls per view. A yes
 * is cached per (rule, viewer, wallets) for a short while, so a viewer who
 * sold the token loses access within minutes. A no is never cached: a viewer
 * who just bought the token should get in on the next try.
 */
const ELIGIBLE_TTL_MS = 2 * 60 * 1000
const ELIGIBILITY_CACHE_MAX = 10_000
const eligibilityCache = new Map<string, number>()

/**
 * Whether `viewer` meets the gate. The author always does. Balances are summed
 * across all of the viewer's verified wallets; community and membership
 * conditions ask `ctx` (without one they are never met).
 */
export async function isEligible(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  rule: GateRuleTable,
  viewer: string,
  ctx: EligibilityContext = {},
): Promise<boolean> {
  if (viewer === rule.did) return true
  const conditions = JSON.parse(rule.conditions) as GateCondition[]
  const chainOnly = conditions.every(isChainCondition)
  const addresses = await linkedEvmAddresses(db, viewer)
  if (!addresses.length && chainOnly) return false
  // A ban must close the gate right away: only chain checks are cached
  const key = chainOnly
    ? [rule.uri, rule.match, rule.conditions, viewer, ...addresses].join('|')
    : undefined
  const now = Date.now()
  if (key && (eligibilityCache.get(key) ?? 0) > now) return true

  const check = async (condition: GateCondition) => {
    if (condition.$type === 'net.krao.gate.defs#communityMember') {
      return ctx.isCommunityMember
        ? ctx.isCommunityMember(condition.community, viewer).catch(() => false)
        : false
    }
    if (condition.$type === 'net.krao.gate.defs#membership') {
      // Never cached (not a chain condition): expiry closes the gate at once
      return ctx.isCreatorMember
        ? ctx
            .isCreatorMember(condition.creator, condition.plan, viewer)
            .catch(() => false)
        : false
    }
    if (!addresses.length) return false
    return meetsCondition(rpcs, condition, addresses).catch(() => false)
  }
  const eligible = await matchConditions(conditions, rule.match, check)
  if (eligible && key) {
    if (eligibilityCache.size >= ELIGIBILITY_CACHE_MAX) eligibilityCache.clear()
    eligibilityCache.set(key, now + ELIGIBLE_TTL_MS)
  }
  return eligible
}

/** All (or with match 'any', any one) of the conditions pass `check` */
export async function matchConditions<T>(
  conditions: T[],
  match: string,
  check: (condition: T) => Promise<boolean>,
): Promise<boolean> {
  if (match === 'any') {
    for (const condition of conditions) {
      if (await check(condition)) return true
    }
    return false
  }
  for (const condition of conditions) {
    if (!(await check(condition))) return false
  }
  return true
}

/**
 * Whether the wallets at `addresses` together meet a chain condition. RPC
 * failures of balance calls throw; failed contract calls count as no.
 */
export async function meetsCondition(
  rpcs: Map<string, EvmRpc>,
  condition: ChainCondition,
  addresses: string[],
): Promise<boolean> {
  if (condition.$type === 'net.krao.gate.defs#tokenBalance') {
    const asset = parseAssetId(condition.asset)
    const rpc = asset && rpcs.get(asset.chainId)
    if (!asset || !rpc || !/^[0-9]{1,78}$/.test(condition.minAmount)) {
      return false
    }
    let total = 0n
    for (const address of addresses) {
      total +=
        asset.kind === 'native'
          ? await rpc.getBalance(address)
          : await tokenBalance(rpc, asset.contract, address)
    }
    return total >= BigInt(condition.minAmount)
  }

  const rpc = rpcs.get(condition.chain)
  const contract = condition.contract.toLowerCase()
  if (!rpc || !/^0x[0-9a-f]{40}$/.test(contract)) return false
  if (condition.tokenId) {
    const tokenId = parseTokenId(condition.tokenId)
    if (tokenId === null) return false
    const owner = await erc721OwnerOf(rpc, contract, tokenId)
    if (owner) return addresses.includes(owner)
    for (const address of addresses) {
      if ((await erc1155BalanceOf(rpc, contract, address, tokenId)) > 0n) {
        return true
      }
    }
    return false
  }
  // Any token of an ERC-721 collection
  for (const address of addresses) {
    if ((await tokenBalance(rpc, contract, address)) > 0n) return true
  }
  return false
}

async function tokenBalance(
  rpc: EvmRpc,
  contract: string,
  address: string,
): Promise<bigint> {
  const res = await rpc.ethCall(
    contract,
    BALANCE_OF + address.replace(/^0x/, '').padStart(64, '0'),
  )
  return res && res !== '0x' ? BigInt(res) : 0n
}
