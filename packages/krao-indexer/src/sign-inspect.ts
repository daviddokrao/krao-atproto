import { LINK_DOMAIN, LINK_STATEMENT, parseSignInMessage } from '@krao/wallet'
import { hasControlChars, utf8Prefix } from './abi-decode.js'
import { EVM_ADDRESS_RE } from './address-check.js'
import {
  type Approval,
  type DraftApproval,
  PERMIT2,
  PreviewError,
  type PreviewOptions,
  type PreviewWarning,
  TokenLookup,
  commonWarnings,
  finishApprovals,
  inputAddress,
  previewRpc,
} from './simulate.js'

/*
 * Signature previews (M34, net.krao.wallet.inspectSignature): what a
 * personal_sign message or EIP-712 typed data would let others do.
 *   permit    EIP-2612 or DAI permit: an allowance, without a transaction
 *   permit2   Uniswap Permit2 PermitSingle/Batch, PermitTransferFrom
 *   order     NFT marketplace orders (Seaport, Blur, LooksRare): signing
 *             one can sell the user's NFTs (always 'danger')
 *   eip7702Authorization  delegating the account to a contract
 *   loginProof  Krao's own wallet link or sign-in message; asked for by a
 *             Mini App (any origin that is not Krao's), it is phishing
 */

/** Statement of the PDS's wallet sign-in challenge (getWalletChallenge) */
const KRAO_SIGN_IN_STATEMENT = 'Sign in to Krao.'

const ORDER_DOMAINS = ['seaport', 'blur exchange', 'looksrareprotocol']
const ORDER_TYPES = ['OrderComponents', 'BulkOrder', 'Order', 'Root', 'Maker']

export type InspectResult = {
  kind:
    | 'message'
    | 'permit'
    | 'permit2'
    | 'order'
    | 'eip7702Authorization'
    | 'loginProof'
    | 'typedData'
  summary?: string
  domain?: { name?: string; chainId?: string; verifyingContract?: string }
  approvals: Approval[]
  warnings: PreviewWarning[]
}

type TypedData = {
  domain?: Record<string, unknown>
  primaryType?: unknown
  message?: Record<string, unknown>
}

const asAddress = (value: unknown): string | undefined => {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return EVM_ADDRESS_RE.test(v) ? v : undefined
}

const asBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value)
  }
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return /^[0-9]{1,78}$/.test(v) || /^0x[0-9a-fA-F]{1,64}$/.test(v)
    ? BigInt(v)
    : undefined
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** A personal_sign payload as text; undefined for bytes that are not text */
export function personalMessageText(payload: string): string | undefined {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(payload)) return payload
  const bytes = Buffer.from(payload.slice(2), 'hex')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  // Line breaks and tabs are fine in a message; other control bytes are not
  return text && !hasControlChars(text.replace(/[\n\r\t]/g, ' '))
    ? text
    : undefined
}

/** The host of an origin; undefined when it is not a URL */
const originHost = (origin: string) => {
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return undefined
  }
}

/** Approvals in Permit2 typed data */
function permit2Approvals(
  primaryType: string,
  message: Record<string, unknown>,
): DraftApproval[] {
  const spender = asAddress(message.spender)
  if (!spender) return []
  const approval = (token: unknown, amount: unknown): DraftApproval[] => {
    const t = asAddress(token)
    const a = asBigInt(amount)
    return t && a
      ? [{ kind: 'permit', token: t, spender, amount: a, bits: 160 }]
      : []
  }
  if (primaryType === 'PermitSingle') {
    const details = record(message.details)
    return approval(details.token, details.amount)
  }
  if (primaryType === 'PermitBatch' && Array.isArray(message.details)) {
    return message.details
      .slice(0, 20)
      .flatMap((d) => approval(record(d).token, record(d).amount))
  }
  if (/^Permit(Witness)?TransferFrom$/.test(primaryType)) {
    const permitted = record(message.permitted)
    return approval(permitted.token, permitted.amount)
  }
  if (
    /^PermitBatch(Witness)?TransferFrom$/.test(primaryType) &&
    Array.isArray(message.permitted)
  ) {
    return message.permitted
      .slice(0, 20)
      .flatMap((p) => approval(record(p).token, record(p).amount))
  }
  return []
}

/** Explains a signature request (see net.krao.wallet.inspectSignature) */
export async function inspectSignature(
  opts: PreviewOptions & {
    /** Krao's own web app origins: wallet proofs may only be asked by them */
    webOrigins: string[]
  },
  input: {
    chain: string
    from: string
    method: string
    payload: string
    origin?: string
  },
): Promise<InspectResult> {
  const rpc = previewRpc(opts.rpcs, input.chain)
  inputAddress(input.from, 'from')
  const chainId = BigInt(input.chain.split(':')[1])
  const warnings: PreviewWarning[] = []
  let kind: InspectResult['kind']
  let summary: string | undefined
  let domain: InspectResult['domain']
  let drafts: DraftApproval[] = []
  const fromKrao =
    !input.origin ||
    opts.webOrigins.some((o) => originHost(o) === originHost(input.origin!))

  if (input.method === 'personal_sign') {
    const text = personalMessageText(input.payload)
    kind = 'message'
    if (text === undefined) {
      warnings.push({
        code: 'blindSignature',
        severity: 'warning',
        message:
          'This is not readable text: it could be a hash that authorizes anything',
      })
    } else {
      // Output limits are UTF-8 bytes (a Vietnamese message is ~3 per letter)
      summary = utf8Prefix(text, 1000)
      let siwe: ReturnType<typeof parseSignInMessage> | undefined
      try {
        siwe = parseSignInMessage(text)
      } catch {
        siwe = undefined
      }
      if (siwe) {
        const kraoProof =
          siwe.domain === LINK_DOMAIN ||
          siwe.statement === LINK_STATEMENT ||
          siwe.statement === KRAO_SIGN_IN_STATEMENT
        if (kraoProof) kind = 'loginProof'
        if (kraoProof && !fromKrao) {
          warnings.push({
            code: 'walletProofPhishing',
            severity: 'danger',
            message:
              'This message links or signs in your wallet to a Krao account. Only Krao itself asks for it',
          })
        } else if (
          input.origin &&
          originHost(input.origin) !== siwe.domain.toLowerCase()
        ) {
          warnings.push({
            code: 'walletProofPhishing',
            severity: 'danger',
            message: utf8Prefix(
              `This sign-in message is for ${siwe.domain}, not the site asking`,
              1000,
            ),
          })
        }
        if (
          siwe.chain === 'Ethereum' &&
          siwe.chainId &&
          /^[0-9]{1,20}$/.test(siwe.chainId) &&
          BigInt(siwe.chainId) !== chainId
        ) {
          warnings.push({ code: 'chainMismatch', severity: 'warning' })
        }
      }
    }
  } else if (input.method === 'eth_signTypedData_v4') {
    let typed: TypedData
    try {
      typed = record(JSON.parse(input.payload)) as TypedData
    } catch {
      throw new PreviewError('payload is not JSON typed data', 'InvalidPayload')
    }
    const d = record(typed.domain)
    const message = record(typed.message)
    const primaryType =
      typeof typed.primaryType === 'string' ? typed.primaryType : ''
    const verifyingContract = asAddress(d.verifyingContract)
    const domainChain = asBigInt(d.chainId)
    domain = {
      ...(typeof d.name === 'string' ? { name: utf8Prefix(d.name, 256) } : {}),
      ...(domainChain !== undefined ? { chainId: domainChain.toString() } : {}),
      ...(verifyingContract ? { verifyingContract } : {}),
    }
    if (domainChain !== undefined && domainChain !== chainId) {
      warnings.push({
        code: 'chainMismatch',
        severity: 'warning',
        message: `Signed for chain ${domainChain}, not ${chainId}`,
      })
    }
    const domainName = typeof d.name === 'string' ? d.name.toLowerCase() : ''
    if (verifyingContract === PERMIT2 || domainName === 'permit2') {
      kind = 'permit2'
      drafts = permit2Approvals(primaryType, message)
    } else if (primaryType === 'Permit' && verifyingContract) {
      kind = 'permit'
      const spender = asAddress(message.spender)
      if (spender && 'allowed' in message) {
        // DAI's permit: all or nothing
        if (message.allowed === true || message.allowed === 'true') {
          drafts = [
            {
              kind: 'permit',
              token: verifyingContract,
              spender,
              unlimited: true,
            },
          ]
        }
      } else if (spender) {
        const amount = asBigInt(message.value)
        if (amount) {
          drafts = [
            { kind: 'permit', token: verifyingContract, spender, amount },
          ]
        }
      }
    } else if (
      ORDER_DOMAINS.includes(domainName) ||
      (ORDER_TYPES.includes(primaryType) && 'offer' in message) ||
      primaryType === 'OrderComponents' ||
      primaryType === 'BulkOrder'
    ) {
      kind = 'order'
      warnings.push({
        code: 'marketplaceOrder',
        severity: 'danger',
        message:
          'An NFT marketplace order: signing it can sell your NFTs or tokens at the price it names',
      })
    } else if (
      /^authorization$/i.test(primaryType) &&
      asAddress(message.address)
    ) {
      kind = 'eip7702Authorization'
      const delegate = asAddress(message.address)!
      const known = (opts.knownDelegates ?? []).includes(delegate)
      warnings.push({
        code: 'eip7702Delegation',
        severity: known ? 'warning' : 'danger',
        message: known
          ? 'Turns your account into a smart account run by this contract'
          : 'Hands control of your account to a contract Krao does not know',
        address: delegate,
      })
    } else {
      kind = 'typedData'
    }
    summary = primaryType
      ? `${typeof d.name === 'string' ? `${utf8Prefix(d.name, 300)}: ` : ''}${utf8Prefix(primaryType, 300)}`
      : undefined
  } else {
    throw new PreviewError(
      'method must be personal_sign or eth_signTypedData_v4',
      'InvalidRequest',
    )
  }

  const tokens = new TokenLookup(opts.db, rpc)
  const approvals = await finishApprovals(drafts, tokens)
  warnings.push(
    ...(await commonWarnings(opts.db, {
      origin: input.origin,
      isUnsafe: opts.isUnsafe,
      approvals,
      addresses: approvals.map((a) => a.spender),
    })),
  )
  return {
    kind,
    ...(summary ? { summary } : {}),
    ...(domain && Object.keys(domain).length ? { domain } : {}),
    approvals,
    warnings,
  }
}
