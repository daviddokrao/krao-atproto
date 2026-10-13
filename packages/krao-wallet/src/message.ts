/**
 * Sign-in messages in the EIP-4361 (Sign-In With Ethereum) text format.
 * Sign-In With Solana uses the same layout with "Solana" in the header.
 */
export type SignInMessage = {
  domain: string
  /** 'Ethereum' for SIWE, 'Solana' for SIWS. */
  chain: 'Ethereum' | 'Solana'
  address: string
  statement?: string
  uri: string
  version: string
  /** Chain reference, eg '1' (EVM chain ID) or a Solana genesis hash prefix. */
  chainId?: string
  nonce: string
  issuedAt: string
  expirationTime?: string
  notBefore?: string
  requestId?: string
  resources: string[]
}

export class InvalidMessageError extends Error {}

const HEADER =
  /^(\S+) wants you to sign in with your (Ethereum|Solana) account:$/

const FIELDS: [string, keyof SignInMessage][] = [
  ['URI', 'uri'],
  ['Version', 'version'],
  ['Chain ID', 'chainId'],
  ['Nonce', 'nonce'],
  ['Issued At', 'issuedAt'],
  ['Expiration Time', 'expirationTime'],
  ['Not Before', 'notBefore'],
  ['Request ID', 'requestId'],
]

export function formatSignInMessage(msg: SignInMessage): string {
  const lines = [
    `${msg.domain} wants you to sign in with your ${msg.chain} account:`,
    msg.address,
    '',
  ]
  if (msg.statement) {
    lines.push(msg.statement, '')
  }
  for (const [label, key] of FIELDS) {
    const value = msg[key]
    if (typeof value === 'string' && value) {
      lines.push(`${label}: ${value}`)
    }
  }
  if (msg.resources.length) {
    lines.push('Resources:', ...msg.resources.map((r) => `- ${r}`))
  }
  return lines.join('\n')
}

export function parseSignInMessage(text: string): SignInMessage {
  const lines = text.split('\n')
  const header = HEADER.exec(lines[0] ?? '')
  if (!header) {
    throw new InvalidMessageError('Missing sign-in message header')
  }
  const address = lines[1]?.trim()
  if (!address) {
    throw new InvalidMessageError('Missing address')
  }

  let i = 2
  const statementLines: string[] = []
  while (i < lines.length && !lines[i].startsWith('URI: ')) {
    statementLines.push(lines[i])
    i++
  }
  const statement = statementLines.join('\n').trim() || undefined

  const fields: Partial<Record<keyof SignInMessage, string>> = {}
  const resources: string[] = []
  let inResources = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (inResources) {
      if (!line.startsWith('- ')) {
        throw new InvalidMessageError(`Unexpected line: ${line}`)
      }
      resources.push(line.slice(2))
      continue
    }
    if (line === 'Resources:') {
      inResources = true
      continue
    }
    const field = FIELDS.find(([label]) => line.startsWith(`${label}: `))
    if (!field) {
      throw new InvalidMessageError(`Unexpected line: ${line}`)
    }
    fields[field[1]] = line.slice(field[0].length + 2)
  }

  if (!fields.uri || !fields.version || !fields.nonce || !fields.issuedAt) {
    throw new InvalidMessageError('Missing URI, Version, Nonce or Issued At')
  }
  return {
    domain: header[1],
    chain: header[2] as SignInMessage['chain'],
    address,
    statement,
    uri: fields.uri,
    version: fields.version,
    chainId: fields.chainId,
    nonce: fields.nonce,
    issuedAt: fields.issuedAt,
    expirationTime: fields.expirationTime,
    notBefore: fields.notBefore,
    requestId: fields.requestId,
    resources,
  }
}
