// Public JSON-RPC front for the demo's Anvil fork. Anvil also answers cheat
// methods (anvil_setBalance, anvil_impersonateAccount, evm_*...), which would
// let anyone fake balances or NFT ownership. Only standard methods go through.
import http from 'node:http'

const UPSTREAM = process.env.RPC_UPSTREAM ?? 'http://kraonet-backend-anvil:8545'
const PORT = Number(process.env.PORT ?? 8545)
const MAX_BODY = 256 * 1024
const MAX_BATCH = 20
// An explicit list: Anvil adds non-standard eth_* methods too (eg
// eth_sendUnsignedTransaction sends from any address without a signature).
// eth_sendTransaction only works for Anvil's unlocked dev accounts, which the
// shared demo wallet uses.
const ALLOWED = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_syncing',
  'net_version',
  'web3_clientVersion',
])

const allowed = (method) => typeof method === 'string' && ALLOWED.has(method)

const reject = (id, message) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code: -32601, message },
})

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

http
  .createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
    if (req.method !== 'POST') return res.writeHead(405, cors).end()
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > MAX_BODY) return res.writeHead(413, cors).end()
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      return send(res, reject(null, 'Parse error'))
    }
    const batch = Array.isArray(payload)
    const calls = batch ? payload : [payload]
    if (!calls.length || calls.length > MAX_BATCH) {
      return send(res, reject(null, 'Invalid batch size'))
    }
    const out = new Array(calls.length)
    const forward = []
    calls.forEach((call, i) => {
      if (allowed(call?.method)) forward.push(i)
      else out[i] = reject(call?.id, `Method not allowed: ${call?.method}`)
    })
    // One upstream call each, so results never depend on batch ordering
    await Promise.all(
      forward.map(async (i) => {
        try {
          const upstream = await fetch(UPSTREAM, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(calls[i]),
            signal: AbortSignal.timeout(15_000),
          })
          out[i] = await upstream.json()
        } catch {
          out[i] = rejectUpstream(calls[i]?.id)
        }
      }),
    )
    send(res, batch ? out : out[0])
  })
  .listen(PORT, () => console.log(`rpc-guard on :${PORT} -> ${UPSTREAM}`))

function rejectUpstream(id) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code: -32603, message: 'Upstream error' },
  }
}

function send(res, value) {
  res.writeHead(200, { ...cors, 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
