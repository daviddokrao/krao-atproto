/**
 * An EVM JSON-RPC endpoint, as a function: `(method, params) => result`.
 * Errors the node answers with throw `RpcResponseError`; anything else (no
 * answer, HTTP 429 or 5xx, another HTTP error without a JSON-RPC error, bad
 * JSON) throws `RpcTransportError`.
 */
export type EvmJsonRpc = (method: string, params: unknown[]) => Promise<unknown>

/**
 * The JSON-RPC endpoint for a CAIP-2 chain id (eg `eip155:8453`), or
 * undefined when the caller has none for that chain.
 */
export type EvmRpcForChain = (chainId: string) => EvmJsonRpc | undefined

/** The node could not be reached or did not answer JSON-RPC */
export class RpcTransportError extends Error {}

/** The node answered with a JSON-RPC error */
export class RpcResponseError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message)
  }

  /**
   * Whether the call itself failed (revert, out of gas, invalid opcode...),
   * as opposed to the node: the contract's answer, so a "no".
   */
  get isExecutionError(): boolean {
    return (
      this.code === 3 ||
      this.code === -32015 ||
      /revert|out of gas|invalid opcode|execution|stack (underflow|overflow|limit)/i.test(
        this.message,
      )
    )
  }

  /** Whether the node is limited or broken (try again later) */
  get isNodeProblem(): boolean {
    return (
      !this.isExecutionError && (this.code === -32005 || this.code === -32603)
    )
  }
}

/** A JSON-RPC client over HTTP(S) */
export function httpJsonRpc(
  url: string,
  opts: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
): EvmJsonRpc {
  const fetchFn = opts.fetch ?? globalThis.fetch
  let id = 0
  return async (method, params) => {
    let body: {
      result?: unknown
      error?: { code?: number; message?: string }
    }
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      })
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`)
      }
      body = (await res.json()) as typeof body
      if (!body || typeof body !== 'object') throw new Error('Not JSON-RPC')
      if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      throw new RpcTransportError(
        `${method}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (body.error) {
      throw new RpcResponseError(
        `${method}: ${body.error.message ?? 'error'}`,
        body.error.code,
      )
    }
    return body.result
  }
}

/**
 * One endpoint per CAIP-2 chain id, eg `{ 'eip155:8453': 'https://...' }`.
 */
export function rpcForChains(
  urls: Record<string, string>,
  opts?: { timeoutMs?: number },
): EvmRpcForChain {
  const rpcs = new Map(
    Object.entries(urls).map(([chain, url]) => [chain, httpJsonRpc(url, opts)]),
  )
  return (chainId) => rpcs.get(chainId)
}
