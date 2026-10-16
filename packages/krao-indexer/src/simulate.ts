import {
  addressAt,
  decodeAbiString,
  decodeRevertData,
  eventTopic,
  selector,
  strip,
  topicAddress,
  uintArrayAt,
  uintAt,
} from './abi-decode.js'
import { EVM_ADDRESS_RE, checkAddresses } from './address-check.js'
import { type EvmRpc, RpcError } from './chain.js'
import { formatUsd, usdPricer } from './creator.js'
import type { Database } from './db.js'
import { BASE_CHAIN } from './token.js'

/*
 * Transaction previews (M34, net.krao.wallet.simulate): what a transaction
 * would take from and give to the signer, the approvals it grants, and
 * warnings, before the wallet signs it.
 *
 * The transaction is run with debug_traceCall and the callTracer (with logs)
 * on Krao's node ('trace'): native value moved by every call frame that did
 * not revert, and the token events (Transfer, TransferSingle/Batch, Approval,
 * ApprovalForAll, Permit2's Approval/Permit, WETH Deposit/Withdrawal) those
 * frames emitted. Nodes that do not trace (many hosted RPCs) get the
 * calldata decoded instead ('decode'): ERC-20/721/1155 transfers and
 * approvals, Permit2 approve and the native value, with eth_call telling
 * whether it reverts.
 */

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'
/** Approvals of at least this much are unlimited (MAX_UINT256 and the like) */
export const UNLIMITED_UINT256 = 1n << 255n
/** Permit2 amounts are uint160 */
export const UNLIMITED_UINT160 = 1n << 159n

export const SELECTORS = {
  transfer: selector('transfer(address,uint256)'),
  transferFrom: selector('transferFrom(address,address,uint256)'),
  approve: selector('approve(address,uint256)'),
  increaseAllowance: selector('increaseAllowance(address,uint256)'),
  safeTransferFrom721: selector('safeTransferFrom(address,address,uint256)'),
  safeTransferFrom721Data: selector(
    'safeTransferFrom(address,address,uint256,bytes)',
  ),
  safeTransferFrom1155: selector(
    'safeTransferFrom(address,address,uint256,uint256,bytes)',
  ),
  safeBatchTransferFrom: selector(
    'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  ),
  setApprovalForAll: selector('setApprovalForAll(address,bool)'),
  permit2Approve: selector('approve(address,address,uint160,uint48)'),
}

export const TOPICS = {
  transfer: eventTopic('Transfer(address,address,uint256)'),
  approval: eventTopic('Approval(address,address,uint256)'),
  approvalForAll: eventTopic('ApprovalForAll(address,address,bool)'),
  transferSingle: eventTopic(
    'TransferSingle(address,address,address,uint256,uint256)',
  ),
  transferBatch: eventTopic(
    'TransferBatch(address,address,address,uint256[],uint256[])',
  ),
  permit2Approval: eventTopic(
    'Approval(address,address,address,uint160,uint48)',
  ),
  permit2Permit: eventTopic(
    'Permit(address,address,address,uint160,uint48,uint48)',
  ),
  wethDeposit: eventTopic('Deposit(address,uint256)'),
  wethWithdrawal: eventTopic('Withdrawal(address,uint256)'),
}

export type ChangeKind = 'native' | 'erc20' | 'erc721' | 'erc1155'

/** A balance change before its token is looked up */
export type DraftChange = {
  direction: 'out' | 'in'
  /** 'erc20or721': transferFrom, which both standards share */
  kind: ChangeKind | 'erc20or721'
  token?: string
  amount?: bigint
  tokenId?: bigint
  counterparty?: string
}

export type DraftApproval = {
  /** 'erc20or721': approve(address,uint256), which both standards share */
  kind: 'erc20' | 'approvalForAll' | 'permit' | 'erc20or721'
  token: string
  spender: string
  amount?: bigint
  /** Fixed by the call (eg setApprovalForAll); else judged by amount */
  unlimited?: boolean
  /** Bits of the amount (Permit2: 160) */
  bits?: 160 | 256
}

export type Decoded = { changes: DraftChange[]; approvals: DraftApproval[] }

const lower = (address: string) => address.toLowerCase()

/** What the calldata of a transaction says it does, as seen by `from` */
export function decodeCalldata(tx: {
  from: string
  to: string
  data?: string
  value?: bigint
}): Decoded {
  const from = lower(tx.from)
  const to = lower(tx.to)
  const changes: DraftChange[] = []
  const approvals: DraftApproval[] = []
  if (tx.value && tx.value > 0n) {
    changes.push({
      direction: 'out',
      kind: 'native',
      amount: tx.value,
      counterparty: to,
    })
  }
  const data = strip(tx.data ?? '')
  if (data.length < 8) return { changes, approvals }
  const sel = '0x' + data.slice(0, 8)
  const args = data.slice(8)
  /** A transfer between a and b: out when `from` sends, in when it gets */
  const move = (
    a: string | undefined,
    b: string | undefined,
    change: Omit<DraftChange, 'direction' | 'counterparty'>,
  ) => {
    if (!a || !b) return
    if (a === from && b !== from) {
      changes.push({ ...change, direction: 'out', counterparty: b })
    } else if (b === from && a !== from) {
      changes.push({ ...change, direction: 'in', counterparty: a })
    }
  }
  switch (sel) {
    case SELECTORS.transfer:
      move(from, addressAt(args, 0), {
        kind: 'erc20',
        token: to,
        amount: uintAt(args, 1),
      })
      break
    case SELECTORS.transferFrom:
      move(addressAt(args, 0), addressAt(args, 1), {
        kind: 'erc20or721',
        token: to,
        amount: uintAt(args, 2),
      })
      break
    case SELECTORS.safeTransferFrom721:
    case SELECTORS.safeTransferFrom721Data:
      move(addressAt(args, 0), addressAt(args, 1), {
        kind: 'erc721',
        token: to,
        tokenId: uintAt(args, 2),
      })
      break
    case SELECTORS.safeTransferFrom1155:
      move(addressAt(args, 0), addressAt(args, 1), {
        kind: 'erc1155',
        token: to,
        tokenId: uintAt(args, 2),
        amount: uintAt(args, 3),
      })
      break
    case SELECTORS.safeBatchTransferFrom: {
      const ids = uintArrayAt(args, 2)
      const amounts = uintArrayAt(args, 3)
      if (ids && amounts && ids.length === amounts.length) {
        ids.forEach((id, i) =>
          move(addressAt(args, 0), addressAt(args, 1), {
            kind: 'erc1155',
            token: to,
            tokenId: id,
            amount: amounts[i],
          }),
        )
      }
      break
    }
    case SELECTORS.approve: {
      const spender = addressAt(args, 0)
      const amount = uintAt(args, 1)
      if (spender && amount !== undefined && amount > 0n) {
        approvals.push({ kind: 'erc20or721', token: to, spender, amount })
      }
      break
    }
    case SELECTORS.increaseAllowance: {
      const spender = addressAt(args, 0)
      const amount = uintAt(args, 1)
      if (spender && amount !== undefined && amount > 0n) {
        approvals.push({ kind: 'erc20', token: to, spender, amount })
      }
      break
    }
    case SELECTORS.setApprovalForAll: {
      const operator = addressAt(args, 0)
      if (operator && uintAt(args, 1) === 1n) {
        approvals.push({
          kind: 'approvalForAll',
          token: to,
          spender: operator,
          unlimited: true,
        })
      }
      break
    }
    case SELECTORS.permit2Approve: {
      const token = addressAt(args, 0)
      const spender = addressAt(args, 1)
      const amount = uintAt(args, 2)
      if (to === PERMIT2 && token && spender && amount) {
        approvals.push({ kind: 'permit', token, spender, amount, bits: 160 })
      }
      break
    }
  }
  return { changes, approvals }
}

/** A call frame of geth's callTracer (withLog) */
export type CallFrame = {
  type?: string
  from?: string
  to?: string
  value?: string
  gasUsed?: string
  output?: string
  error?: string
  revertReason?: string
  calls?: CallFrame[]
  logs?: { address?: string; topics?: string[]; data?: string }[]
}

export type TraceResult = Decoded & {
  ok: boolean
  revertReason?: string
  gasUsed?: bigint
  /** Whether any frame came with logs (nodes may ignore withLog) */
  logsSeen: boolean
}

const VALUE_FRAMES = new Set(['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'])

const toBigInt = (hex: string | undefined): bigint | undefined => {
  if (!hex) return undefined
  try {
    return BigInt(hex)
  } catch {
    return undefined
  }
}

/**
 * What a traced transaction does to `from`: native value of the frames that
 * did not revert, and the token events they emitted
 */
export function parseTrace(root: CallFrame, fromAddress: string): TraceResult {
  const from = lower(fromAddress)
  const changes: DraftChange[] = []
  const approvals: DraftApproval[] = []
  let logsSeen = false
  const walk = (frame: CallFrame) => {
    // A reverted frame undoes its value, its logs and every call under it
    if (frame.error) return
    if (Array.isArray(frame.logs)) logsSeen = true
    const value = toBigInt(frame.value) ?? 0n
    if (value > 0n && VALUE_FRAMES.has((frame.type ?? 'CALL').toUpperCase())) {
      const a = frame.from ? lower(frame.from) : undefined
      const b = frame.to ? lower(frame.to) : undefined
      if (a === from && b !== from) {
        changes.push({
          direction: 'out',
          kind: 'native',
          amount: value,
          counterparty: b,
        })
      } else if (b === from && a !== from) {
        changes.push({
          direction: 'in',
          kind: 'native',
          amount: value,
          counterparty: a,
        })
      }
    }
    for (const log of frame.logs ?? []) readLog(log)
    for (const call of frame.calls ?? []) walk(call)
  }
  const readLog = (log: NonNullable<CallFrame['logs']>[number]) => {
    const address = log.address ? lower(log.address) : undefined
    const topics = (log.topics ?? []).map(lower)
    const data = strip(log.data ?? '')
    if (!address || !topics.length) return
    const push = (
      a: string | undefined,
      b: string | undefined,
      change: Omit<DraftChange, 'direction' | 'counterparty'>,
    ) => {
      if (a === from && b !== from) {
        changes.push({ ...change, direction: 'out', counterparty: b })
      } else if (b === from && a !== from) {
        changes.push({ ...change, direction: 'in', counterparty: a })
      }
    }
    switch (topics[0]) {
      case TOPICS.transfer:
        if (topics.length === 3) {
          push(topicAddress(topics[1]), topicAddress(topics[2]), {
            kind: 'erc20',
            token: address,
            amount: uintAt(data, 0),
          })
        } else if (topics.length === 4) {
          push(topicAddress(topics[1]), topicAddress(topics[2]), {
            kind: 'erc721',
            token: address,
            tokenId: toBigInt(topics[3]),
          })
        }
        break
      case TOPICS.transferSingle:
        push(topicAddress(topics[2]), topicAddress(topics[3]), {
          kind: 'erc1155',
          token: address,
          tokenId: uintAt(data, 0),
          amount: uintAt(data, 1),
        })
        break
      case TOPICS.transferBatch: {
        const ids = uintArrayAt(data, 0)
        const amounts = uintArrayAt(data, 1)
        if (ids && amounts && ids.length === amounts.length) {
          ids.forEach((id, i) =>
            push(topicAddress(topics[2]), topicAddress(topics[3]), {
              kind: 'erc1155',
              token: address,
              tokenId: id,
              amount: amounts[i],
            }),
          )
        }
        break
      }
      case TOPICS.approval: {
        const amount = uintAt(data, 0)
        const spender = topicAddress(topics[2])
        // ERC-721 approvals of one token have the token id as a 4th topic
        if (
          topics.length === 3 &&
          topicAddress(topics[1]) === from &&
          spender &&
          amount
        ) {
          approvals.push({ kind: 'erc20', token: address, spender, amount })
        }
        break
      }
      case TOPICS.approvalForAll: {
        const operator = topicAddress(topics[2])
        if (
          topicAddress(topics[1]) === from &&
          operator &&
          uintAt(data, 0) === 1n
        ) {
          approvals.push({
            kind: 'approvalForAll',
            token: address,
            spender: operator,
            unlimited: true,
          })
        }
        break
      }
      case TOPICS.permit2Approval:
      case TOPICS.permit2Permit: {
        const token = topicAddress(topics[2])
        const spender = topicAddress(topics[3])
        const amount = uintAt(data, 0)
        if (
          address === PERMIT2 &&
          topicAddress(topics[1]) === from &&
          token &&
          spender &&
          amount
        ) {
          approvals.push({ kind: 'permit', token, spender, amount, bits: 160 })
        }
        break
      }
      case TOPICS.wethDeposit:
        if (address === WETH_ADDRESS && topicAddress(topics[1]) === from) {
          changes.push({
            direction: 'in',
            kind: 'erc20',
            token: address,
            amount: uintAt(data, 0),
          })
        }
        break
      case TOPICS.wethWithdrawal:
        if (address === WETH_ADDRESS && topicAddress(topics[1]) === from) {
          changes.push({
            direction: 'out',
            kind: 'erc20',
            token: address,
            amount: uintAt(data, 0),
          })
        }
        break
    }
  }
  const gasUsed = toBigInt(root.gasUsed)
  if (root.error) {
    return {
      ok: false,
      revertReason:
        root.revertReason ?? decodeRevertData(root.output) ?? root.error,
      changes: [],
      approvals: [],
      gasUsed,
      logsSeen,
    }
  }
  walk(root)
  return {
    ok: true,
    changes: mergeChanges(changes),
    approvals,
    gasUsed,
    logsSeen,
  }
}

/** Adds up changes of the same asset, direction and counterparty */
export function mergeChanges(changes: DraftChange[]): DraftChange[] {
  const merged = new Map<string, DraftChange>()
  for (const change of changes) {
    if (change.kind === 'erc721') {
      merged.set(`${merged.size}`, change)
      continue
    }
    const key = [
      change.direction,
      change.kind,
      change.token ?? '',
      change.tokenId ?? '',
      change.counterparty ?? '',
    ].join('|')
    const seen = merged.get(key)
    if (seen) {
      seen.amount = (seen.amount ?? 0n) + (change.amount ?? 0n)
    } else {
      merged.set(key, { ...change })
    }
  }
  return [...merged.values()]
}

/*
 * The preview
 */

export type TokenInfo = {
  address: string
  symbol?: string
  name?: string
  decimals?: number
}
export type BalanceChange = {
  direction: 'out' | 'in'
  kind: ChangeKind
  token?: TokenInfo
  amount?: string
  tokenId?: string
  counterparty?: string
}
export type Approval = {
  kind: 'erc20' | 'approvalForAll' | 'permit'
  token: TokenInfo
  spender: string
  amount?: string
  unlimited: boolean
}
export type Severity = 'info' | 'warning' | 'danger'
export type PreviewWarning = {
  code: string
  severity: Severity
  message?: string
  address?: string
}
export type SimulateResult = {
  ok: boolean
  revertReason?: string
  method: 'trace' | 'decode'
  changes: BalanceChange[]
  approvals: Approval[]
  warnings: PreviewWarning[]
  gasEstimate?: string
  usdOut?: string
}

export class PreviewError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
  }
}

type PreviewRpc = Pick<EvmRpc, 'request' | 'tryCall'>

export type PreviewOptions = {
  db: Database
  rpcs: Map<string, PreviewRpc>
  /** Whether an origin's domain is on the unsafe domain list */
  isUnsafe?: (url: string) => boolean
  /** Contracts Krao knows besides its catalogs (lower case) */
  knownContracts?: string[]
  /** EIP-7702 delegate contracts Krao trusts (lower case); none by default */
  knownDelegates?: string[]
}

/** An address from input: lower case, or InvalidAddress */
export function inputAddress(value: string, field: string): string {
  const address = value.trim().toLowerCase()
  if (!EVM_ADDRESS_RE.test(address)) {
    throw new PreviewError(`${field} is not an EVM address`, 'InvalidAddress')
  }
  return address
}

/** Wei from a decimal or 0x hex string */
export function parseQuantity(value: string, field: string): bigint {
  const v = value.trim()
  if (/^[0-9]{1,78}$/.test(v) || /^0x[0-9a-fA-F]{1,64}$/.test(v)) {
    return BigInt(v)
  }
  throw new PreviewError(
    `${field} must be a decimal or 0x hex number`,
    'InvalidRequest',
  )
}

/** The RPC of a chain previews support (Base, with an RPC) */
export function previewRpc(
  rpcs: Map<string, PreviewRpc>,
  chain: string,
): PreviewRpc {
  const rpc = chain === BASE_CHAIN ? rpcs.get(chain) : undefined
  if (!rpc) {
    throw new PreviewError(`Unsupported chain: ${chain}`, 'UnsupportedChain')
  }
  return rpc
}

/**
 * A node error that means the transaction itself fails (revert, out of
 * gas, insufficient funds...), as opposed to a node that does not answer
 * (transport failures, rate limits, -32005/-32603: see M28)
 */
export function isExecutionError(err: unknown): err is RpcError {
  return (
    err instanceof RpcError &&
    err.code !== -32005 &&
    err.code !== -32603 &&
    err.code !== -32601 &&
    !/rate limit|too many requests|timeout/i.test(err.message)
  )
}

const TOKEN_CALLS = {
  symbol: selector('symbol()'),
  name: selector('name()'),
  decimals: selector('decimals()'),
  totalSupply: selector('totalSupply()'),
  supportsInterface: selector('supportsInterface(bytes4)'),
}
const ERC721_INTERFACE = '80ac58cd'

/** Reads tokens on chain and from Krao's catalogs, with a small cache */
export class TokenLookup {
  private onchain = new Map<string, { at: number; info: TokenInfo }>()
  private catalog?: Map<string, TokenInfo>
  private collections?: Map<string, { name?: string; standard: string }>

  constructor(
    private db: Database,
    private rpc?: PreviewRpc,
  ) {}

  private async load() {
    if (!this.catalog) {
      const rows = await this.db
        .selectFrom('token')
        .select(['address', 'symbol', 'name', 'decimals'])
        .where('chain', '=', BASE_CHAIN)
        .where('removed', '=', 0)
        .execute()
      this.catalog = new Map(
        rows.map((r) => [
          lower(r.address),
          {
            address: lower(r.address),
            symbol: r.symbol,
            name: r.name,
            decimals: r.decimals,
          },
        ]),
      )
      // ETH is listed under WETH's address; WETH itself is "WETH"
      const weth = this.catalog.get(WETH_ADDRESS)
      if (weth?.symbol === 'ETH') {
        this.catalog.set(WETH_ADDRESS, {
          ...weth,
          symbol: 'WETH',
          name: 'Wrapped Ether',
        })
      }
      const nfts = await this.db
        .selectFrom('nft_collection')
        .select(['contract', 'name', 'standard'])
        .where('chain', '=', BASE_CHAIN)
        .execute()
      this.collections = new Map(
        nfts.map((n) => [
          lower(n.contract),
          { name: n.name ?? undefined, standard: n.standard },
        ]),
      )
    }
    return { catalog: this.catalog, collections: this.collections! }
  }

  /** Whether the address is a catalog token or approved NFT collection */
  async isKnown(address: string): Promise<boolean> {
    const { catalog, collections } = await this.load()
    return catalog.has(address) || collections.has(address)
  }

  private async call(to: string, data: string): Promise<string | null> {
    if (!this.rpc) return null
    try {
      return await this.rpc.tryCall(to, data)
    } catch {
      return null
    }
  }

  /** What Krao knows of a token: its catalog, else the contract */
  async info(address: string): Promise<TokenInfo> {
    const { catalog, collections } = await this.load()
    const known = catalog.get(address)
    if (known) return known
    const collection = collections.get(address)
    if (collection?.name) return { address, name: collection.name }
    const cached = this.onchain.get(address)
    if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.info
    const [symbol, name, decimals] = await Promise.all([
      this.call(address, TOKEN_CALLS.symbol),
      this.call(address, TOKEN_CALLS.name),
      this.call(address, TOKEN_CALLS.decimals),
    ])
    const d = decimals && strip(decimals).length === 64 ? BigInt(decimals) : -1n
    const info: TokenInfo = {
      address,
      ...(decodeAbiString(symbol)
        ? { symbol: decodeAbiString(symbol)!.slice(0, 64) }
        : {}),
      ...(decodeAbiString(name)
        ? { name: decodeAbiString(name)!.slice(0, 256) }
        : {}),
      ...(d >= 0n && d <= 255n ? { decimals: Number(d) } : {}),
    }
    if (this.onchain.size > 1000) this.onchain.clear()
    this.onchain.set(address, { at: Date.now(), info })
    return info
  }

  /** The token's total supply, when it has one */
  async totalSupply(address: string): Promise<bigint | undefined> {
    const res = await this.call(address, TOKEN_CALLS.totalSupply)
    return res && strip(res).length === 64 ? BigInt(res) : undefined
  }

  /** ERC-721 or ERC-20, for calls both standards share */
  async isErc721(address: string): Promise<boolean> {
    const { catalog, collections } = await this.load()
    if (catalog.has(address)) return false
    const collection = collections.get(address)
    if (collection) return collection.standard.startsWith('erc721')
    const res = await this.call(
      address,
      TOKEN_CALLS.supportsInterface + ERC721_INTERFACE.padEnd(64, '0'),
    )
    return !!res && strip(res).length === 64 && BigInt(res) === 1n
  }
}

/** Whether an approval amount is unlimited (or covers the whole supply) */
export function isUnlimited(
  amount: bigint,
  bits: 160 | 256 = 256,
  totalSupply?: bigint,
): boolean {
  if (amount >= (bits === 160 ? UNLIMITED_UINT160 : UNLIMITED_UINT256)) {
    return true
  }
  return totalSupply !== undefined && totalSupply > 0n && amount >= totalSupply
}

/** Resolves draft approvals: standards, token info, unlimited */
export async function finishApprovals(
  drafts: DraftApproval[],
  tokens: TokenLookup,
): Promise<Approval[]> {
  const out: Approval[] = []
  for (const draft of drafts.slice(0, 20)) {
    let kind = draft.kind
    if (kind === 'erc20or721') {
      // approve() of a single NFT: not an allowance over the user's balance
      if (await tokens.isErc721(draft.token)) continue
      kind = 'erc20'
    }
    const unlimited =
      draft.unlimited ??
      (draft.amount !== undefined &&
        isUnlimited(
          draft.amount,
          draft.bits,
          draft.bits === 160 || draft.amount >= UNLIMITED_UINT256
            ? undefined
            : await tokens.totalSupply(draft.token),
        ))
    out.push({
      kind,
      token: await tokens.info(draft.token),
      spender: draft.spender,
      ...(draft.amount !== undefined && kind !== 'approvalForAll'
        ? { amount: draft.amount.toString() }
        : {}),
      unlimited,
    })
  }
  return out
}

async function finishChanges(
  drafts: DraftChange[],
  tokens: TokenLookup,
): Promise<BalanceChange[]> {
  const out: BalanceChange[] = []
  for (const draft of drafts.slice(0, 50)) {
    let kind = draft.kind
    if (kind === 'erc20or721') {
      kind =
        draft.token && (await tokens.isErc721(draft.token)) ? 'erc721' : 'erc20'
    }
    const tokenId =
      kind === 'erc721' && draft.kind === 'erc20or721'
        ? draft.amount
        : draft.tokenId
    const amount = kind === 'erc721' ? undefined : draft.amount
    out.push({
      direction: draft.direction,
      kind,
      ...(draft.token ? { token: await tokens.info(draft.token) } : {}),
      ...(amount !== undefined ? { amount: amount.toString() } : {}),
      ...(tokenId !== undefined ? { tokenId: tokenId.toString() } : {}),
      ...(draft.counterparty ? { counterparty: draft.counterparty } : {}),
    })
  }
  return out
}

/** Warnings shared by transactions and signatures */
export async function commonWarnings(
  db: Database,
  opts: {
    origin?: string
    isUnsafe?: (url: string) => boolean
    approvals: Approval[]
    /** Addresses the signer deals with (recipients, spenders) */
    addresses: string[]
  },
): Promise<PreviewWarning[]> {
  const warnings: PreviewWarning[] = []
  for (const approval of opts.approvals) {
    if (approval.kind === 'approvalForAll') {
      warnings.push({
        code: 'approvalForAll',
        severity: 'danger',
        message:
          'Gives this address every NFT of the collection you hold, now and later',
        address: approval.spender,
      })
    } else if (approval.unlimited) {
      warnings.push({
        code: 'unlimitedApproval',
        severity: 'danger',
        message: `Lets this address spend all of your ${approval.token.symbol ?? 'tokens'}, with no limit`,
        address: approval.spender,
      })
    }
  }
  if (opts.origin && opts.isUnsafe?.(opts.origin)) {
    warnings.push({
      code: 'unsafeOrigin',
      severity: 'danger',
      message: "The site asking is on Krao's list of unsafe domains",
    })
  }
  const addresses = [...new Set(opts.addresses.map(lower))]
    .filter((a) => EVM_ADDRESS_RE.test(a))
    .slice(0, 20)
  if (addresses.length) {
    for (const result of await checkAddresses(db, addresses)) {
      if (result.lookalikes.length) {
        warnings.push({
          code: 'lookalikeAddress',
          severity: 'danger',
          message:
            "This address looks like another Krao account's verified wallet: check every character",
          address: result.address,
        })
      }
    }
  }
  return warnings
}

/** Simulates a transaction (see net.krao.wallet.simulate) */
export async function simulateTransaction(
  opts: PreviewOptions,
  input: {
    chain: string
    from: string
    to: string
    data?: string
    value?: string
    authorizationList?: { address: string; chainId?: string; nonce?: string }[]
    origin?: string
  },
): Promise<SimulateResult> {
  const rpc = previewRpc(opts.rpcs, input.chain)
  const from = inputAddress(input.from, 'from')
  const to = inputAddress(input.to, 'to')
  const data = input.data?.trim() || '0x'
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new PreviewError('data must be 0x hex', 'InvalidRequest')
  }
  const value = input.value ? parseQuantity(input.value, 'value') : 0n
  const authorizations = (input.authorizationList ?? []).map((a) =>
    inputAddress(a.address, 'authorizationList.address'),
  )
  const call = {
    from,
    to,
    data,
    ...(value ? { value: '0x' + value.toString(16) } : {}),
  }

  let method: SimulateResult['method'] = 'decode'
  let ok = true
  let unavailable = false
  let revertReason: string | undefined
  let gas: bigint | undefined
  let drafts = decodeCalldata({ from, to, data, value })
  try {
    const trace = await rpc.request<CallFrame>('debug_traceCall', [
      call,
      'latest',
      { tracer: 'callTracer', tracerConfig: { withLog: true } },
    ])
    if (!trace || typeof trace !== 'object') throw new Error('No trace')
    const traced = parseTrace(trace, from)
    method = 'trace'
    ok = traced.ok
    revertReason = traced.revertReason
    gas = traced.gasUsed
    // A reverted transaction moves nothing: show what it tried to do.
    // Without any logs (none emitted, or a node ignoring withLog), token
    // movements come from the calldata, native value from the trace.
    if (traced.ok) {
      drafts = traced.logsSeen
        ? traced
        : {
            changes: mergeChanges([
              ...traced.changes,
              ...drafts.changes.filter((c) => c.kind !== 'native'),
            ]),
            approvals: drafts.approvals,
          }
    }
  } catch {
    // No tracing on this node: does it run at all?
    try {
      await rpc.request<string>('eth_call', [call, 'latest'])
      gas = await rpc
        .request<string>('eth_estimateGas', [call])
        .then((hex) => BigInt(hex))
        .catch(() => undefined)
    } catch (err) {
      ok = false
      if (isExecutionError(err)) {
        revertReason =
          decodeRevertData(err.data) ??
          err.message.replace(/^eth_call: /, '').slice(0, 1000)
      } else {
        unavailable = true
      }
    }
  }

  const tokens = new TokenLookup(opts.db, unavailable ? undefined : rpc)
  const approvals = await finishApprovals(drafts.approvals, tokens)
  const changes = await finishChanges(drafts.changes, tokens)
  const warnings: PreviewWarning[] = []
  if (unavailable) {
    warnings.push({
      code: 'simulationUnavailable',
      severity: 'warning',
      message: 'Krao could not run this transaction to check it',
    })
  } else if (!ok) {
    warnings.push({
      code: 'reverts',
      severity: 'danger',
      message: revertReason
        ? `The transaction would fail: ${revertReason}`
        : 'The transaction would fail',
    })
  }
  const knownDelegates = new Set(opts.knownDelegates ?? [])
  for (const delegate of new Set(authorizations)) {
    const known = knownDelegates.has(delegate)
    warnings.push({
      code: 'eip7702Delegation',
      severity: known ? 'warning' : 'danger',
      message: known
        ? 'Turns your account into a smart account run by this contract'
        : 'Hands control of your account to a contract Krao does not know',
      address: delegate,
    })
  }
  warnings.push(
    ...(await commonWarnings(opts.db, {
      origin: input.origin,
      isUnsafe: opts.isUnsafe,
      approvals,
      addresses: [
        to,
        ...approvals.map((a) => a.spender),
        ...changes.flatMap((c) => (c.counterparty ? [c.counterparty] : [])),
      ],
    })),
  )
  if (!unavailable && !(await isKnownContract(opts, tokens, to))) {
    const code = await rpc
      .request<string>('eth_getCode', [to, 'latest'])
      .catch(() => '0x')
    // An EIP-7702 account (0xef0100 + delegate) is a wallet, not a contract
    if (code && code !== '0x' && !strip(code).startsWith('ef0100')) {
      warnings.push({
        code: 'unknownContract',
        severity: 'info',
        message: 'Krao does not know this contract',
        address: to,
      })
    }
  }
  const usdOut = await usdOf(opts.db, changes)
  return {
    ok,
    ...(revertReason ? { revertReason: revertReason.slice(0, 1000) } : {}),
    method,
    changes,
    approvals,
    warnings,
    ...(gas !== undefined ? { gasEstimate: gas.toString() } : {}),
    ...(usdOut ? { usdOut } : {}),
  }
}

async function isKnownContract(
  opts: PreviewOptions,
  tokens: TokenLookup,
  address: string,
): Promise<boolean> {
  return (
    address === PERMIT2 ||
    (opts.knownContracts ?? []).includes(address) ||
    (await tokens.isKnown(address))
  )
}

/** The dollar value of what goes out, at the catalog's prices */
async function usdOf(
  db: Database,
  changes: BalanceChange[],
): Promise<string | undefined> {
  const price = await usdPricer(db)
  let micro = 0n
  for (const change of changes) {
    if (change.direction !== 'out' || !change.amount) continue
    if (change.kind === 'native') {
      micro += price(`${BASE_CHAIN}/slip44:60`, change.amount)
    } else if (change.kind === 'erc20' && change.token) {
      micro += price(
        `${BASE_CHAIN}/erc20:${change.token.address}`,
        change.amount,
      )
    }
  }
  return micro > 0n ? formatUsd(micro) : undefined
}
