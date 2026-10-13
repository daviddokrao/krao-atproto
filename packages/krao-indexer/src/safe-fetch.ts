import { lookup } from 'node:dns'
import { BlockList, isIP } from 'node:net'
import { Agent, type Dispatcher, fetch } from 'undici'

/**
 * Fetching URLs that users or on-chain metadata name, without letting them
 * reach the server's own network: every address a hostname resolves to is
 * checked when the connection is made (so DNS rebinding cannot swap it after
 * a check), and redirects are followed by hand so each hop is checked too.
 */

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export function isPublicIp(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1]
  if (mapped) return isPublicIp(mapped)
  const family = isIP(ip)
  if (!family) return false
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

const publicOnlyAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0)
        const list = addresses as { address: string; family: number }[]
        const bad = list.find((a) => !isPublicIp(a.address))
        if (bad || !list.length) {
          return callback(
            new Error(`Host ${hostname} is not a public address`),
            '',
            0,
          )
        }
        if (options.all) return callback(null, list as never, 0)
        callback(null, list[0].address, list[0].family)
      })
    },
  },
})

export type SafeFetchOptions = {
  /** Allow plain http as well as https (default false) */
  allowHttp?: boolean
  timeoutMs?: number
  maxRedirects?: number
  headers?: Record<string, string>
}

export class SafeFetchError extends Error {}

function assertAllowedUrl(url: URL, allowHttp: boolean) {
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new SafeFetchError(`Unsupported protocol ${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    (isIP(host) && !isPublicIp(host))
  ) {
    throw new SafeFetchError('Host is not allowed')
  }
}

/** Fetch a public URL; resolves with the response and its final URL */
export async function safeFetch(
  raw: string,
  opts: SafeFetchOptions = {},
): Promise<{ res: Awaited<ReturnType<typeof fetch>>; url: string }> {
  const { allowHttp = false, timeoutMs = 8000, maxRedirects = 3 } = opts
  const signal = AbortSignal.timeout(timeoutMs)
  let url = new URL(raw)
  for (let hop = 0; ; hop++) {
    assertAllowedUrl(url, allowHttp)
    const res = await fetch(url, {
      dispatcher: publicOnlyAgent as Dispatcher,
      redirect: 'manual',
      signal,
      headers: opts.headers,
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel()
      if (hop >= maxRedirects) throw new SafeFetchError('Too many redirects')
      url = new URL(location, url)
      continue
    }
    return { res, url: url.toString() }
  }
}

/*
 * Leaving a `for await` over a body (break or throw) cancels the stream, so
 * the rest of an oversized response is never downloaded.
 */

/** Read at most `maxBytes` of a body; rejects bodies that are larger */
export async function readLimited(
  res: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<Buffer> {
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new SafeFetchError('Response is too large')
  const chunks: Buffer[] = []
  let size = 0
  if (!res.body) return Buffer.alloc(0)
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > maxBytes) throw new SafeFetchError('Response is too large')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Read up to `maxBytes` of a body and stop there, for partial reads */
export async function readPrefix(
  res: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  if (!res.body) return Buffer.alloc(0)
  for await (const chunk of res.body) {
    chunks.push(Buffer.from(chunk))
    size += chunk.length
    if (size >= maxBytes) break
  }
  return Buffer.concat(chunks).subarray(0, maxBytes)
}
