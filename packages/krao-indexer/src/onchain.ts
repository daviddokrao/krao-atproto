import { normalizeAccountId } from '@krao/wallet'
import { type EvmRpc, parseAssetId } from './chain.js'
import { formatUsd, usdPricer } from './creator.js'
import {
  type Database,
  type NftCollectionTable,
  type WalletTable,
  visibleDid,
} from './db.js'
import { type PrimaryName, getPrimaryNames, nameAddresses } from './names.js'
import { decodeAbiString } from './nft.js'
import { USDC } from './token.js'
import {
  getWalletOwners,
  getWalletsForDids,
  ownedEvmAddresses,
  uniqueWallets,
} from './wallets.js'

/*
 * The on-chain tab of a profile (M33): verified wallets the account owns,
 * its Basename/ENS name, NFTs its wallets hold, and its public support.
 *
 * NFTs come from Krao's approved collections only (admins, like the token
 * catalog: anything else could be spam or worse), read on chain through
 * Krao's RPCs and cached for minutes, plus the verified NFT avatar. Enumerable
 * ERC-721 collections list each token (at most MAX_NFT_ITEMS in all); other
 * ERC-721 collections one item with the balance. ERC-1155 balances cannot be
 * listed without token ids, so those collections only show as an avatar.
 * Images go through the indexer's own /nft-image proxy, never a third-party
 * URL.
 *
 * Support is verified tips and membership payments. Tips marked anonymous
 * are left out everywhere: the tab is public.
 */

export const MAX_NFT_ITEMS = 50
/** NFT holdings are read again after this long (at least 10 minutes) */
export const NFT_CACHE_MS = 10 * 60 * 1000

const SELECTORS = {
  supportsInterface: '0x01ffc9a7',
  balanceOf: '0x70a08231',
  tokenOfOwnerByIndex: '0x2f745c59',
  name: '0x06fdde03',
}
/** ERC-165 interface ids */
const INTERFACES = {
  erc721: '80ac58cd',
  enumerable: '780e9d63',
  erc1155: 'd9b67a26',
}

export type CollectionStandard = 'erc721-enumerable' | 'erc721' | 'erc1155'

type CallRpc = Pick<EvmRpc, 'tryCall' | 'ethCall'>

const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const uint = (res: string | null): bigint | null =>
  res && res.length >= 66 ? BigInt(res.slice(0, 66)) : null

export class OnchainError extends Error {
  constructor(
    public code: 'UnsupportedChain' | 'InvalidCollection',
    message: string,
  ) {
    super(message)
  }
}

/** Whether the contract says (ERC-165) it implements `iface` */
async function supports(rpc: CallRpc, contract: string, iface: string) {
  const res = await rpc.tryCall(
    contract,
    SELECTORS.supportsInterface + iface.padEnd(64, '0'),
  )
  return uint(res) === 1n
}

/** What kind of NFT contract it is; null when it is none (by ERC-165) */
export async function detectStandard(
  rpc: CallRpc,
  contract: string,
): Promise<CollectionStandard | null> {
  if (await supports(rpc, contract, INTERFACES.erc1155)) return 'erc1155'
  if (!(await supports(rpc, contract, INTERFACES.erc721))) return null
  return (await supports(rpc, contract, INTERFACES.enumerable))
    ? 'erc721-enumerable'
    : 'erc721'
}

const CONTRACT_RE = /^0x[0-9a-f]{40}$/

/** Adds a collection to the approved list, or renames one */
export async function putCollection(
  db: Database,
  rpcs: Map<string, CallRpc>,
  admin: string,
  input: { chain: string; contract: string; name?: string },
): Promise<NftCollectionTable> {
  const rpc = rpcs.get(input.chain)
  if (!rpc) {
    throw new OnchainError(
      'UnsupportedChain',
      `Krao reads no chain ${input.chain}`,
    )
  }
  const contract = input.contract.trim().toLowerCase()
  if (!CONTRACT_RE.test(contract)) {
    throw new OnchainError('InvalidCollection', 'Malformed contract address')
  }
  const standard = await detectStandard(rpc, contract)
  if (!standard) {
    throw new OnchainError(
      'InvalidCollection',
      'Not an ERC-721 or ERC-1155 contract (ERC-165)',
    )
  }
  const name =
    input.name?.trim() ||
    decodeAbiString(await rpc.ethCall(contract, SELECTORS.name))?.trim() ||
    null
  const old = await db
    .selectFrom('nft_collection')
    .select('addedAt')
    .where('chain', '=', input.chain)
    .where('contract', '=', contract)
    .executeTakeFirst()
  const row: NftCollectionTable = {
    chain: input.chain,
    contract,
    name: name ? name.slice(0, 640) : null,
    standard,
    addedBy: admin,
    addedAt: old?.addedAt ?? new Date().toISOString(),
  }
  await db
    .insertInto('nft_collection')
    .values(row)
    .onConflict((oc) => oc.columns(['chain', 'contract']).doUpdateSet(row))
    .execute()
  return row
}

export async function removeCollection(
  db: Database,
  chain: string,
  contract: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('nft_collection')
    .where('chain', '=', chain)
    .where('contract', '=', contract.trim().toLowerCase())
    .executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}

export async function listCollections(db: Database) {
  return db
    .selectFrom('nft_collection')
    .selectAll()
    .orderBy('addedAt', 'desc')
    .orderBy('contract', 'asc')
    .execute()
}

export type NftItem = {
  chain: string
  contract: string
  tokenId?: string
  balance: string
  collectionName?: string
  name?: string
  image?: string
  isAvatar: boolean
}

/**
 * What `owners` hold of one collection: a token per item for enumerable
 * ERC-721 (at most `max`), else one item with the balance (none when 0).
 * Throws when the chain does not answer.
 */
export async function readHoldings(
  rpc: CallRpc,
  collection: Pick<NftCollectionTable, 'chain' | 'contract' | 'standard'>,
  owners: string[],
  max: number,
): Promise<{ tokenId?: bigint; balance: bigint }[]> {
  if (collection.standard === 'erc1155' || max <= 0) return []
  const balances: { owner: string; balance: bigint }[] = []
  for (const owner of owners) {
    const balance =
      uint(
        await rpc.tryCall(
          collection.contract,
          SELECTORS.balanceOf + word(owner),
        ),
      ) ?? 0n
    if (balance > 0n) balances.push({ owner, balance })
  }
  if (collection.standard !== 'erc721-enumerable') {
    const total = balances.reduce((sum, b) => sum + b.balance, 0n)
    return total > 0n ? [{ balance: total }] : []
  }
  const items: { tokenId: bigint; balance: bigint }[] = []
  for (const { owner, balance } of balances) {
    for (let i = 0n; i < balance && items.length < max; i++) {
      const tokenId = uint(
        await rpc.tryCall(
          collection.contract,
          SELECTORS.tokenOfOwnerByIndex + word(owner) + word(i.toString(16)),
        ),
      )
      if (tokenId !== null) items.push({ tokenId, balance: 1n })
    }
  }
  return items
}

export type OnchainOptions = {
  rpcs: Map<string, CallRpc>
  /** URL of this service, for NFT images through /nft-image */
  baseUrl: string
  /** How long holdings are reused (default NFT_CACHE_MS; 0: off) */
  cacheMs?: number
  /** Where holdings are cached between calls */
  cache?: Map<string, { at: number; items: NftItem[] }>
}

export const nftImageUrl = (
  baseUrl: string,
  nft: { chain: string; contract: string; tokenId: string },
) => {
  const url = new URL('/nft-image', baseUrl)
  url.searchParams.set('chain', nft.chain)
  url.searchParams.set('contract', nft.contract)
  url.searchParams.set('tokenId', nft.tokenId)
  return url.toString()
}

/** Whether the account is taken down, suspended or deactivated */
export async function isHidden(db: Database, did: string) {
  return !!(await db
    .selectFrom('hidden_actor')
    .select('did')
    .where('did', '=', did)
    .executeTakeFirst())
}

/** The account's verified wallets that no other account linked first */
async function ownedWallets(
  db: Database,
  did: string,
): Promise<{
  rows: WalletTable[]
  owned: Set<string>
  wallets: WalletTable[]
}> {
  const rows = await getWalletsForDids(db, [did])
  const owned = await ownedEvmAddresses(db, did)
  const wallets: WalletTable[] = []
  for (const row of uniqueWallets(rows)) {
    if (row.status !== 'verified') continue
    if (row.evmAddress) {
      if (owned.has(row.evmAddress)) wallets.push(row)
    } else if ((await getWalletOwners(db, row.account)).includes(did)) {
      wallets.push(row)
    }
  }
  return { rows, owned, wallets }
}

/** `eip155:8453:0xabc…` as its chain and address */
function splitAccount(account: string) {
  let id = account
  try {
    id = normalizeAccountId(account)
  } catch {
    // stored as written
  }
  const i = id.lastIndexOf(':')
  return { chain: id.slice(0, i), address: id.slice(i + 1) }
}

/** NFTs the wallets hold, of the approved collections, and the NFT avatar */
async function nftItems(
  db: Database,
  did: string,
  addresses: string[],
  opts: OnchainOptions,
): Promise<NftItem[]> {
  const [collections, avatar] = await Promise.all([
    listCollections(db),
    db
      .selectFrom('nft_avatar')
      .selectAll()
      .where('did', '=', did)
      .where('status', '=', 'verified')
      .executeTakeFirst(),
  ])
  const cacheMs = opts.cacheMs ?? NFT_CACHE_MS
  const key = [
    did,
    ...addresses,
    ...collections.map((c) => `${c.chain}/${c.contract}/${c.standard}`),
  ].join('|')
  const now = Date.now()
  const cached = opts.cache?.get(key)
  let held: NftItem[]
  if (cached && cacheMs > 0 && now - cached.at < cacheMs) {
    held = cached.items
  } else {
    held = []
    for (const collection of collections) {
      const rpc = opts.rpcs.get(collection.chain)
      if (!rpc || !addresses.length) continue
      try {
        const holdings = await readHoldings(
          rpc,
          collection,
          addresses,
          MAX_NFT_ITEMS - held.length,
        )
        for (const h of holdings) {
          held.push({
            chain: collection.chain,
            contract: collection.contract,
            ...(h.tokenId !== undefined
              ? { tokenId: h.tokenId.toString() }
              : {}),
            balance: h.balance.toString(),
            ...(collection.name ? { collectionName: collection.name } : {}),
            isAvatar: false,
          })
        }
      } catch (err) {
        console.error(
          'Krao indexer: NFT holdings read failed',
          collection.contract,
          err,
        )
      }
    }
    if (opts.cache && cacheMs > 0) {
      if (opts.cache.size > 5_000) opts.cache.clear()
      opts.cache.set(key, { at: now, items: held })
    }
  }
  const items = held.map((item) => ({ ...item }))
  if (avatar) {
    const same = (item: NftItem) =>
      item.chain === avatar.chain && item.contract === avatar.contract
    const token = items.find((i) => same(i) && i.tokenId === avatar.tokenId)
    if (token) {
      token.isAvatar = true
    } else {
      // A collection counted as a whole holds the avatar: count it apart
      const whole = items.findIndex((i) => same(i) && i.tokenId === undefined)
      if (whole >= 0 && avatar.standard !== 'erc1155') {
        const rest = BigInt(items[whole].balance) - 1n
        if (rest > 0n) items[whole].balance = rest.toString()
        else items.splice(whole, 1)
      }
      items.unshift({
        chain: avatar.chain,
        contract: avatar.contract,
        tokenId: avatar.tokenId,
        balance: '1',
        ...(avatar.collectionName
          ? { collectionName: avatar.collectionName }
          : {}),
        isAvatar: true,
      })
    }
  }
  return items.slice(0, MAX_NFT_ITEMS).map((item) =>
    item.tokenId !== undefined
      ? {
          ...item,
          image: nftImageUrl(opts.baseUrl, {
            chain: item.chain,
            contract: item.contract,
            tokenId: item.tokenId,
          }),
        }
      : item,
  )
}

export type SupportSummary = {
  tipsSentUsd: string
  tipsReceivedUsd: string
  tipsSent: number
  tipsReceived: number
  membershipsActive: number
  membersActive: number
}

/**
 * Verified public tips sent and received (anonymous ones left out, and
 * those with hidden accounts), in USD at current prices, and active
 * memberships both ways at `now` (the membership clock)
 */
export async function supportSummary(
  db: Database,
  did: string,
  now: number,
): Promise<SupportSummary> {
  const nowIso = new Date(now).toISOString()
  const [sent, received, memberships, members, usd] = await Promise.all([
    db
      .selectFrom('tip')
      .select(['asset', 'amount'])
      .where('did', '=', did)
      .where('status', '=', 'verified')
      .where('anonymous', '=', 0)
      .where(visibleDid('recipient'))
      .execute(),
    db
      .selectFrom('tip')
      .select(['asset', 'amount'])
      .where('recipient', '=', did)
      .where('status', '=', 'verified')
      .where('anonymous', '=', 0)
      .where(visibleDid('did'))
      .execute(),
    db
      .selectFrom('creator_member')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('member', '=', did)
      .where('expiresAt', '>', nowIso)
      .where(visibleDid('creator'))
      .executeTakeFirst(),
    db
      .selectFrom('creator_member')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('creator', '=', did)
      .where('expiresAt', '>', nowIso)
      .where(visibleDid('member'))
      .executeTakeFirst(),
    usdPricer(db),
  ])
  const total = (tips: { asset: string; amount: string }[]) =>
    formatUsd(tips.reduce((sum, t) => sum + usd(t.asset, t.amount), 0n))
  return {
    tipsSentUsd: total(sent),
    tipsReceivedUsd: total(received),
    tipsSent: sent.length,
    tipsReceived: received.length,
    membershipsActive: Number(memberships?.count ?? 0),
    membersActive: Number(members?.count ?? 0),
  }
}

export type OnchainProfile = {
  did: string
  primaryName?: PrimaryName
  wallets: { chain: string; address: string; label?: string }[]
  nfts: NftItem[]
  support: SupportSummary
}

/** The on-chain tab of `did`; undefined when the account is hidden */
export async function getOnchainProfile(
  db: Database,
  did: string,
  opts: OnchainOptions & { now: number },
): Promise<OnchainProfile | undefined> {
  if (await isHidden(db, did)) return undefined
  const { rows, owned, wallets } = await ownedWallets(db, did)
  const names = await getPrimaryNames(db, [did])
  // As last checked, while its wallet is still linked, owned and shown
  const name = names.get(did)
  const primaryName =
    name && nameAddresses(rows, owned).includes(name.address) ? name : undefined
  const addresses = [
    ...new Set(wallets.flatMap((w) => (w.evmAddress ? [w.evmAddress] : []))),
  ].sort()
  const [nfts, support] = await Promise.all([
    nftItems(db, did, addresses, opts),
    supportSummary(db, did, opts.now),
  ])
  return {
    did,
    ...(primaryName ? { primaryName } : {}),
    wallets: wallets.map((w) => {
      const { chain, address } = splitAccount(w.account)
      return {
        chain,
        address: w.evmAddress ?? address,
        ...(w.label ? { label: w.label } : {}),
      }
    }),
    nfts,
    support,
  }
}

export type SupportAsset = {
  symbol: string
  decimals: number
  chain: string
  address?: string
}

export type SupportItem = {
  kind: 'tip' | 'membership'
  uri: string
  from: string
  to: string
  amount: string
  asset: SupportAsset
  usd?: string
  txHash: string
  createdAt: string
}

const splitCursor = (cursor: string) => {
  const i = cursor.lastIndexOf('::')
  if (i < 0) throw new Error('Malformed cursor')
  return [cursor.slice(0, i), cursor.slice(i + 2)] as const
}

/**
 * Verified tips (not anonymous) and membership payments `did` sent or
 * received, the newest first (record createdAt; never ahead of now). The
 * cursor is `<createdAt>::<uri>`. Tips in tokens outside the catalog are
 * left out (no symbol or decimals to show them with).
 */
export async function getSupportHistory(
  db: Database,
  did: string,
  opts: {
    direction: 'sent' | 'received'
    limit: number
    cursor?: string
    now?: number
  },
): Promise<{ items: SupportItem[]; cursor?: string }> {
  const nowIso = new Date(opts.now ?? Date.now()).toISOString()
  const sent = opts.direction === 'sent'
  const after = opts.cursor ? splitCursor(opts.cursor) : undefined
  let tipQuery = db
    .selectFrom('tip')
    .select([
      'uri',
      'did',
      'recipient',
      'asset',
      'amount',
      'txHash',
      'createdAt',
    ])
    .where(sent ? 'did' : 'recipient', '=', did)
    .where('status', '=', 'verified')
    .where('anonymous', '=', 0)
    .where('createdAt', '<=', nowIso)
    .where(visibleDid(sent ? 'recipient' : 'did'))
    .orderBy('createdAt', 'desc')
    .orderBy('uri', 'desc')
    .limit(opts.limit)
  let paymentQuery = db
    .selectFrom('membership_payment')
    .select(['uri', 'did', 'creator', 'chain', 'amount', 'txHash', 'createdAt'])
    .where(sent ? 'did' : 'creator', '=', did)
    .where('status', '=', 'verified')
    .where('createdAt', '<=', nowIso)
    .where(visibleDid(sent ? 'creator' : 'did'))
    .orderBy('createdAt', 'desc')
    .orderBy('uri', 'desc')
    .limit(opts.limit)
  if (after) {
    const [createdAt, uri] = after
    tipQuery = tipQuery.where((eb) =>
      eb.or([
        eb('createdAt', '<', createdAt),
        eb.and([eb('createdAt', '=', createdAt), eb('uri', '<', uri)]),
      ]),
    )
    paymentQuery = paymentQuery.where((eb) =>
      eb.or([
        eb('createdAt', '<', createdAt),
        eb.and([eb('createdAt', '=', createdAt), eb('uri', '<', uri)]),
      ]),
    )
  }
  const [tips, payments, tokens, usd] = await Promise.all([
    tipQuery.execute(),
    paymentQuery.execute(),
    db
      .selectFrom('token')
      .select(['symbol', 'chain', 'address', 'decimals'])
      .where('removed', '=', 0)
      .execute(),
    usdPricer(db),
  ])
  const catalog = new Map(
    tokens.map((t) => [`${t.chain}/${t.address.toLowerCase()}`, t]),
  )
  const assetOf = (assetId: string): SupportAsset | undefined => {
    const asset = parseAssetId(assetId)
    if (!asset) return undefined
    if (asset.kind === 'native') {
      return { symbol: 'ETH', decimals: 18, chain: asset.chainId }
    }
    const token = catalog.get(`${asset.chainId}/${asset.contract}`)
    return token
      ? {
          symbol: token.symbol,
          decimals: token.decimals,
          chain: asset.chainId,
          address: asset.contract,
        }
      : undefined
  }
  type Row = { createdAt: string; uri: string; item?: SupportItem }
  const rows: Row[] = [
    ...tips.map((t): Row => {
      const asset = assetOf(t.asset)
      return {
        createdAt: t.createdAt,
        uri: t.uri,
        item: asset && {
          kind: 'tip',
          uri: t.uri,
          from: t.did,
          to: t.recipient,
          amount: t.amount,
          asset,
          usd: formatUsd(usd(t.asset, t.amount)),
          txHash: t.txHash,
          createdAt: t.createdAt,
        },
      }
    }),
    ...payments.map((p): Row => ({
      createdAt: p.createdAt,
      uri: p.uri,
      item: {
        kind: 'membership',
        uri: p.uri,
        from: p.did,
        to: p.creator,
        amount: p.amount ?? '0',
        asset: {
          symbol: 'USDC',
          decimals: 6,
          chain: p.chain,
          address: USDC.toLowerCase(),
        },
        usd: formatUsd(BigInt(p.amount ?? '0')),
        txHash: p.txHash,
        createdAt: p.createdAt,
      },
    })),
  ]
    .sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.uri < b.uri
          ? 1
          : a.uri > b.uri
            ? -1
            : 0,
    )
    .slice(0, opts.limit)
  const last = rows.at(-1)
  return {
    items: rows.flatMap((r) => (r.item ? [r.item] : [])),
    cursor:
      rows.length === opts.limit && last
        ? `${last.createdAt}::${last.uri}`
        : undefined,
  }
}
