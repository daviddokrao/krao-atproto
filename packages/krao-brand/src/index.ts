import { readFileSync } from 'node:fs'

/**
 * The product's brand: what users and other servers see (name, domain,
 * hostnames, emails). Read from `brand.json` at the package root, the one
 * file a rebrand changes (see DESIGN-brand.md). Internal code names
 * (`@krao/*`, `KRAO_*`, `krao_*` tables) do not come from here.
 */
export type Brand = {
  /** Display name, eg "Krao" */
  name: string
  /** Web domain; user handles are `<name>.<domain>` */
  domain: string
  /** Subdomain of each public service: `<hosts.x>.<domain>` */
  hosts: Record<BrandHostKey, string>
  /** Lexicon namespace (changed by scripts/rebrand.mjs, not read at runtime) */
  nsid: string
  app: { id: string; scheme: string; slug: string }
  emails: { support: string; noreply: string }
  social: { officialHandle: string }
}

export type BrandHostKey =
  | 'pds'
  | 'api'
  | 'indexer'
  | 'video'
  | 'chat'
  | 'rewards'
  | 'rpc'
  | 'embed'
  | 'status'
  | 'plc'
  | 'gate'
  | 'mod'

/** Parses and checks brand.json's contents */
export function parseBrand(json: string): Brand {
  const brand = JSON.parse(json) as Brand
  for (const key of ['name', 'domain', 'nsid'] as const) {
    if (typeof brand[key] !== 'string' || !brand[key]) {
      throw new Error(`brand.json: "${key}" is missing`)
    }
  }
  if (typeof brand.hosts !== 'object' || brand.hosts === null) {
    throw new Error('brand.json: "hosts" is missing')
  }
  return brand
}

// dist/index.js and src/index.ts both sit one level under the package root
export const BRAND: Readonly<Brand> = Object.freeze(
  parseBrand(readFileSync(new URL('../brand.json', import.meta.url), 'utf8')),
)

/** Public hostname of a service, eg `api.krao.net` */
export function brandHost(key: BrandHostKey): string {
  const sub = BRAND.hosts[key]
  if (!sub) throw new Error(`brand.json: no host "${key}"`)
  return `${sub}.${BRAND.domain}`
}

/** Public URL of a service, eg `https://api.krao.net` */
export function brandUrl(key: BrandHostKey): string {
  return `https://${brandHost(key)}`
}

/** `did:web` of a service, eg `did:web:api.krao.net` */
export function brandDid(key: BrandHostKey): string {
  return `did:web:${brandHost(key)}`
}

/** The web app's URL, eg `https://krao.net` or `https://krao.net/terms` */
export function webUrl(path = ''): string {
  if (!path) return `https://${BRAND.domain}`
  return `https://${BRAND.domain}${path.startsWith('/') ? '' : '/'}${path}`
}
