/**
 * Minimal EVM JSON-RPC client for verifying tip transactions. Only the two
 * read calls the indexer needs, so no client library is pulled in.
 */

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export type ParsedAsset =
  | { kind: 'native'; chainId: string }
  | { kind: 'erc20'; chainId: string; contract: string }

/** Parse the CAIP-19 asset ids Krao supports for tips. */
export function parseAssetId(assetId: string): ParsedAsset | null {
  const match = /^(eip155:[0-9]+)\/(slip44:60|erc20:(0x[0-9a-fA-F]{40}))$/.exec(
    assetId,
  )
  if (!match) return null
  return match[3]
    ? { kind: 'erc20', chainId: match[1], contract: match[3].toLowerCase() }
    : { kind: 'native', chainId: match[1] }
}

export type TransferCheck =
  | { status: 'verified' }
  | { status: 'pending'; reason: string }
  | { status: 'invalid'; reason: string }

type Receipt = {
  status: string
  blockNumber: string
  from: string
  to: string | null
  logs: { address: string; topics: string[]; data: string }[]
}

type Transaction = {
  from: string
  to: string | null
  value: string
}

/** A JSON-RPC error the node answered with (not a transport failure) */
export class RpcError extends Error {
  constructor(
    message: string,
    public code?: number,
    public data?: unknown,
  ) {
    super(message)
  }
}

export class EvmRpc {
  constructor(private url: string) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json()) as {
      result?: T
      error?: { message: string; code?: number; data?: unknown }
    }
    if (body.error) {
      throw new RpcError(
        `${method}: ${body.error.message}`,
        body.error.code,
        body.error.data,
      )
    }
    return body.result as T
  }

  /**
   * Any JSON-RPC method (eg debug_traceCall); node errors throw RpcError,
   * transport failures other errors
   */
  request<T>(method: string, params: unknown[]): Promise<T> {
    return this.call<T>(method, params)
  }

  /** Native coin balance at the latest block */
  async getBalance(address: string): Promise<bigint> {
    return BigInt(
      await this.call<string>('eth_getBalance', [address, 'latest']),
    )
  }

  /** eth_call against the latest block; null when the call reverts */
  async ethCall(to: string, data: string): Promise<string | null> {
    try {
      return await this.call<string>('eth_call', [{ to, data }, 'latest'])
    } catch {
      return null
    }
  }

  /**
   * eth_call against the latest block: null when the call reverts, throws
   * when the node cannot answer (so callers keep what they knew)
   */
  async tryCall(to: string, data: string): Promise<string | null> {
    try {
      return await this.call<string>('eth_call', [{ to, data }, 'latest'])
    } catch (err) {
      if (/revert|invalid opcode|out of gas/i.test(String(err))) return null
      throw err
    }
  }

  /** The latest block number */
  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>('eth_blockNumber', []))
  }

  /**
   * The asset balance of `address` at `block` (eg a poll's snapshot). Node
   * failures throw; a token contract that reverts counts as no balance.
   */
  async balanceAt(
    asset: ParsedAsset,
    address: string,
    block: bigint,
  ): Promise<bigint> {
    const tag = '0x' + block.toString(16)
    if (asset.kind === 'native') {
      return BigInt(await this.call<string>('eth_getBalance', [address, tag]))
    }
    let res: string
    try {
      res = await this.call<string>('eth_call', [
        {
          to: asset.contract,
          data: '0x70a08231' + address.replace(/^0x/, '').padStart(64, '0'),
        },
        tag,
      ])
    } catch (err) {
      if (/revert/i.test(String((err as Error)?.message))) return 0n
      throw err
    }
    return res && res !== '0x' ? BigInt(res.slice(0, 66)) : 0n
  }

  /** Unix time (seconds) of a block, or of the latest one */
  async blockTime(block = 'latest'): Promise<number> {
    const res = await this.call<{ timestamp: string } | null>(
      'eth_getBlockByNumber',
      [block, false],
    )
    if (!res) throw new Error('eth_getBlockByNumber: block not found')
    return Number(BigInt(res.timestamp))
  }

  /**
   * The ERC-20 `contract` amount `txHash` moved from any of `from` to any of
   * `to` (lowercase addresses), summed, with the transaction's block time
   * (unix seconds). Pending while not mined; invalid when it reverted or
   * moved nothing between them.
   */
  async tokenTransfers(params: {
    contract: string
    txHash: string
    from: Set<string>
    to: Set<string>
  }): Promise<
    | { status: 'found'; amount: bigint; blockTime: number }
    | { status: 'pending' | 'invalid'; reason: string }
  > {
    const { txHash } = params
    const contract = params.contract.toLowerCase()
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { status: 'invalid', reason: 'Malformed transaction hash' }
    }
    const receipt = await this.call<Receipt | null>(
      'eth_getTransactionReceipt',
      [txHash],
    )
    if (!receipt) {
      return { status: 'pending', reason: 'Transaction not mined yet' }
    }
    if (receipt.status !== '0x1') {
      return { status: 'invalid', reason: 'Transaction reverted' }
    }
    let amount = 0n
    for (const log of receipt.logs) {
      const from = topicAddress(log.topics[1])
      const to = topicAddress(log.topics[2])
      if (
        log.address.toLowerCase() === contract &&
        log.topics[0] === TRANSFER_TOPIC &&
        from &&
        to &&
        params.from.has(from) &&
        params.to.has(to)
      ) {
        amount += BigInt(log.data)
      }
    }
    if (amount === 0n) {
      return {
        status: 'invalid',
        reason: 'No matching token transfer in transaction',
      }
    }
    return {
      status: 'found',
      amount,
      blockTime: await this.blockTime(receipt.blockNumber),
    }
  }

  /**
   * Check that `txHash` moved exactly `amount` of the asset from `from` (when
   * given) to `to`, in a transaction that succeeded.
   */
  async checkTransfer(params: {
    asset: ParsedAsset
    txHash: string
    from?: string
    to: string
    amount: bigint
  }): Promise<TransferCheck> {
    const { asset, txHash, amount } = params
    const to = params.to.toLowerCase()
    const from = params.from?.toLowerCase()
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { status: 'invalid', reason: 'Malformed transaction hash' }
    }

    const receipt = await this.call<Receipt | null>(
      'eth_getTransactionReceipt',
      [txHash],
    )
    if (!receipt) {
      return { status: 'pending', reason: 'Transaction not mined yet' }
    }
    if (receipt.status !== '0x1') {
      return { status: 'invalid', reason: 'Transaction reverted' }
    }

    if (asset.kind === 'native') {
      const tx = await this.call<Transaction | null>(
        'eth_getTransactionByHash',
        [txHash],
      )
      if (!tx) return { status: 'pending', reason: 'Transaction not found' }
      if (tx.to?.toLowerCase() !== to) {
        return { status: 'invalid', reason: 'Transaction recipient mismatch' }
      }
      if (from && tx.from.toLowerCase() !== from) {
        return { status: 'invalid', reason: 'Transaction sender mismatch' }
      }
      if (BigInt(tx.value) !== amount) {
        return { status: 'invalid', reason: 'Transaction amount mismatch' }
      }
      return { status: 'verified' }
    }

    const transfer = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === asset.contract &&
        log.topics[0] === TRANSFER_TOPIC &&
        topicAddress(log.topics[2]) === to &&
        (!from || topicAddress(log.topics[1]) === from) &&
        BigInt(log.data) === amount,
    )
    return transfer
      ? { status: 'verified' }
      : {
          status: 'invalid',
          reason: 'No matching token transfer in transaction',
        }
  }
}

function topicAddress(topic: string | undefined): string | undefined {
  return topic ? '0x' + topic.slice(-40).toLowerCase() : undefined
}
