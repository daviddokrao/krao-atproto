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
  from: string
  to: string | null
  logs: { address: string; topics: string[]; data: string }[]
}

type Transaction = {
  from: string
  to: string | null
  value: string
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
      error?: { message: string }
    }
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    return body.result as T
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
