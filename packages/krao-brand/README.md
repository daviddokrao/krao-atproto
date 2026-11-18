# @krao/brand

The product's brand, read from [`brand.json`](./brand.json) at runtime. A
rebrand goes through [`scripts/krao-rebrand.mjs`](../../scripts/krao-rebrand.mjs),
which writes this file and the app's identical copy, and rewrites what code
cannot read at runtime (lexicon NSIDs, the app id, the domain in config files
and docs):

```sh
node scripts/krao-rebrand.mjs --name Abc --domain abc.io --dry-run
```

It needs both clones side by side (`krao-atproto`, `krao-app`, or
`KRAO_APP_DIR`) and clean trees, and prints the codegen, format and manual
steps that follow (DNS, `_lexicon` records, logos, store listing). Rebrand
before launch: records already written keep their old NSID.

```ts
import { BRAND, brandHost, brandUrl, brandDid, webUrl } from '@krao/brand'

BRAND.name // 'Krao'
brandHost('api') // 'api.krao.net'
brandUrl('indexer') // 'https://idx.krao.net'
brandDid('chat') // 'did:web:chat.krao.net'
webUrl('/terms') // 'https://krao.net/terms'
```

## For agents: what goes through `@krao/brand`

- **Use it for anything users or other servers see:** the product name in
  SMS, push, email, label descriptions, OG/share cards, feed names, error
  messages and SIWE statements; the domain in link proofs and web URLs; and
  every _default_ hostname, service URL and `did:web`. Env vars still
  override the defaults.
- **Not for internal code names:** `@krao/*`, `packages/krao-*`, `KRAO_*`
  env names, `krao_*` tables, TS identifiers, log prefixes, dev-env
  `*.test` handles. They stay `krao`.
- **Not for lexicon NSIDs** (`net.krao.*`): `scripts/krao-rebrand.mjs` rewrites
  them at compile time.
- Plain scripts (`.mjs` outside a package) read `brand.json` with
  `readFileSync`; compose files and Caddy take `KRAO_DOMAIN`.
- Tests compare against `BRAND` values, not literal `krao.net`.
- A new field in `brand.json` goes in both repos' copies and in
  `DESIGN-brand.md`.
