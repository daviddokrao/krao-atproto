import type { EvmRpc } from './chain.js'
import type { Database, NftAvatarTable } from './db.js'
import { readLimited, safeFetch } from './safe-fetch.js'

export const NFT_AVATAR_COLLECTION = 'net.krao.actor.nftAvatar'

const MAX_METADATA_BYTES = 256 * 1024

/** Gateway used to turn ipfs:// links in token metadata into https URLs */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/'

const SELECTORS = {
  ownerOf: '0x6352211e', // ownerOf(uint256)
  balanceOf1155: '0x00fdd58e', // balanceOf(address,uint256)
  name: '0x06fdde03', // name()
  tokenURI: '0xc87b56dd', // tokenURI(uint256)
  uri1155: '0x0e89341c', // uri(uint256)
}

const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0')
const uint = (value: bigint) => word(value.toString(16))

export function parseTokenId(tokenId: string): bigint | null {
  return /^[0-9]{1,78}$/.test(tokenId) ? BigInt(tokenId) : null
}

/** Decode an ABI-encoded `string` return value */
export function decodeAbiString(hex: string | null): string | undefined {
  if (!hex || hex.length < 2 + 128) return undefined
  const data = hex.slice(2)
  const offset = Number(BigInt('0x' + data.slice(0, 64))) * 2
  const length = Number(BigInt('0x' + data.slice(offset, offset + 64)))
  const bytes = data.slice(offset + 64, offset + 64 + length * 2)
  return Buffer.from(bytes, 'hex').toString('utf8')
}

export async function erc721OwnerOf(
  rpc: EvmRpc,
  contract: string,
  tokenId: bigint,
): Promise<string | null> {
  const res = await rpc.ethCall(contract, SELECTORS.ownerOf + uint(tokenId))
  if (!res || res === '0x' || res.length < 66) return null
  return '0x' + res.slice(-40).toLowerCase()
}

export async function erc1155BalanceOf(
  rpc: EvmRpc,
  contract: string,
  owner: string,
  tokenId: bigint,
): Promise<bigint> {
  const res = await rpc.ethCall(
    contract,
    SELECTORS.balanceOf1155 + word(owner) + uint(tokenId),
  )
  return res && res !== '0x' ? BigInt(res) : 0n
}

export type NftMetadata = {
  collectionName?: string
  name?: string
  image?: string
}

/** Collection name and token metadata (name, image), best effort */
export async function getNftMetadata(
  rpc: EvmRpc,
  contract: string,
  tokenId: bigint,
  standard: 'erc721' | 'erc1155',
): Promise<NftMetadata> {
  const collectionName = decodeAbiString(
    await rpc.ethCall(contract, SELECTORS.name),
  )
  let uri = decodeAbiString(
    await rpc.ethCall(
      contract,
      (standard === 'erc721' ? SELECTORS.tokenURI : SELECTORS.uri1155) +
        uint(tokenId),
    ),
  )
  if (!uri) return { collectionName }
  // ERC-1155 metadata URIs may contain an {id} placeholder
  uri = uri.replace('{id}', tokenId.toString(16).padStart(64, '0'))
  const json = await fetchJson(uri)
  return {
    collectionName,
    name: typeof json?.name === 'string' ? json.name : undefined,
    image: typeof json?.image === 'string' ? toHttpUrl(json.image) : undefined,
  }
}

function toHttpUrl(uri: string): string | undefined {
  if (uri.startsWith('ipfs://')) {
    return IPFS_GATEWAY + uri.slice('ipfs://'.length).replace(/^ipfs\//, '')
  }
  if (uri.startsWith('https://') || uri.startsWith('data:image/')) return uri
  return undefined
}

async function fetchJson(
  uri: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    if (uri.startsWith('data:application/json;base64,')) {
      return JSON.parse(
        Buffer.from(uri.split(',', 2)[1], 'base64').toString('utf8'),
      )
    }
    if (uri.startsWith('data:application/json')) {
      return JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1)))
    }
    const url = toHttpUrl(uri)
    if (!url || url.startsWith('data:')) return undefined
    // Token URIs are chosen by whoever deployed the contract: block internal
    // hosts and cap the size
    const { res } = await safeFetch(url)
    if (!res.ok) return undefined
    const body = await readLimited(res, MAX_METADATA_BYTES)
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Turn an net.krao.actor.nftAvatar record into a pending row */
export function nftAvatarRowFromRecord(
  uri: string,
  did: string,
  record: unknown,
): NftAvatarTable {
  const now = new Date().toISOString()
  const value = (record ?? {}) as Record<string, unknown>
  const nft = (value.nft ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    did,
    uri,
    chain: str(nft.chain),
    contract: str(nft.contract).toLowerCase(),
    tokenId: str(nft.tokenId),
    standard: str(nft.standard) || null,
    wallet: str(value.wallet),
    status: 'pending',
    reason: null,
    collectionName: null,
    image: null,
    checkedAt: null,
    indexedAt: now,
  }
}

/**
 * Check that the NFT is held by a wallet the account has verifiably linked,
 * and refresh its metadata. Stores and returns the new status.
 */
export async function verifyNftAvatar(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  row: NftAvatarTable,
): Promise<NftAvatarTable['status']> {
  const result = await checkNftAvatar(db, rpcs, row)
  await db
    .updateTable('nft_avatar')
    .set({
      status: result.status,
      reason: result.reason ?? null,
      standard: result.standard ?? row.standard,
      collectionName: result.metadata?.collectionName ?? row.collectionName,
      image: result.metadata?.image ?? row.image,
      checkedAt: new Date().toISOString(),
    })
    .where('did', '=', row.did)
    .execute()
  return result.status
}

async function checkNftAvatar(
  db: Database,
  rpcs: Map<string, EvmRpc>,
  row: NftAvatarTable,
): Promise<{
  status: NftAvatarTable['status']
  reason?: string
  standard?: string
  metadata?: NftMetadata
}> {
  const tokenId = parseTokenId(row.tokenId)
  if (tokenId === null) {
    return { status: 'invalid', reason: 'Invalid token id' }
  }
  if (!/^0x[0-9a-f]{40}$/.test(row.contract)) {
    return { status: 'invalid', reason: 'Invalid contract address' }
  }
  const walletParts = row.wallet.split(':')
  const walletAddress = walletParts[2]?.toLowerCase()
  if (walletParts[0] !== 'eip155' || !walletAddress) {
    return { status: 'invalid', reason: 'Wallet must be an EVM account' }
  }

  const linked = await db
    .selectFrom('wallet')
    .select('account')
    .where('did', '=', row.did)
    .where('status', '=', 'verified')
    .execute()
  if (!linked.some((w) => w.account.split(':')[2] === walletAddress)) {
    return { status: 'invalid', reason: 'Wallet is not linked to the account' }
  }

  const rpc = rpcs.get(row.chain)
  if (!rpc) return { status: 'pending', reason: `No RPC for ${row.chain}` }

  let standard = row.standard
  let owns = false
  if (standard !== 'erc1155') {
    const owner = await erc721OwnerOf(rpc, row.contract, tokenId)
    if (owner) {
      standard = 'erc721'
      owns = owner === walletAddress
    }
  }
  if (standard !== 'erc721') {
    const balance = await erc1155BalanceOf(
      rpc,
      row.contract,
      walletAddress,
      tokenId,
    )
    if (balance > 0n) {
      standard = 'erc1155'
      owns = true
    }
  }
  if (!owns) {
    return {
      status: 'invalid',
      reason: 'The linked wallet does not hold this NFT',
      standard: standard ?? undefined,
    }
  }
  const metadata = await getNftMetadata(
    rpc,
    row.contract,
    tokenId,
    standard === 'erc1155' ? 'erc1155' : 'erc721',
  )
  return { status: 'verified', standard: standard ?? undefined, metadata }
}

export async function upsertNftAvatar(db: Database, row: NftAvatarTable) {
  await db
    .insertInto('nft_avatar')
    .values(row)
    .onConflict((oc) => oc.column('did').doUpdateSet(row))
    .execute()
}

export async function deleteNftAvatar(db: Database, did: string) {
  await db.deleteFrom('nft_avatar').where('did', '=', did).execute()
}

/**
 * NFT avatars due for a re-check (ownership can change at any time): never
 * checked, checked before `olderThan`, or invalid and checked before
 * `invalidOlderThan`.
 */
export async function getNftAvatarsToRecheck(
  db: Database,
  olderThan: string,
  invalidOlderThan = olderThan,
) {
  return db
    .selectFrom('nft_avatar')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb('checkedAt', 'is', null),
        eb.and([
          eb('status', '!=', 'invalid'),
          eb('checkedAt', '<', olderThan),
        ]),
        eb.and([
          eb('status', '=', 'invalid'),
          eb('checkedAt', '<', invalidOlderThan),
        ]),
      ]),
    )
    .orderBy('checkedAt', 'asc')
    .limit(100)
    .execute()
}

export async function getNftAvatarsForDids(db: Database, dids: string[]) {
  if (!dids.length) return []
  return db
    .selectFrom('nft_avatar')
    .selectAll()
    .where('did', 'in', dids)
    .execute()
}

/** Re-check an account's NFT avatar on the next tick, eg after its wallets change */
export async function markNftAvatarStale(db: Database, did: string) {
  await db
    .updateTable('nft_avatar')
    .set({ checkedAt: null })
    .where('did', '=', did)
    .execute()
}
