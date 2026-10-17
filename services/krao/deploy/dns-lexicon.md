# DNS for Krao's lexicons (`net.krao.*`)

Atproto resolves a lexicon from its NSID: the NSID without its last segment,
reversed, is a domain; a TXT record at `_lexicon.<that domain>` names the DID
of the account that publishes it; the lexicon is the
`com.atproto.lexicon.schema` record with the NSID as record key in that
account's repo. OAuth needs this for Krao's permission sets
(`include:net.krao.authWeb3`, `include:net.krao.authMiniApp`); other apps
need it to read Krao's records and methods.

Status: **to do by David** once production DNS is set up (34.4b). The dev-env
does not use DNS: it publishes the permission sets in its lexicon authority
repo (`packages/dev-env/src/krao-dev.ts`).

## 1. Publish the lexicons

Use Krao's official account (the one in `KRAO_OFFICIAL_FEED_DIDS`), call it
`<DID>`. For each JSON file under `lexicons/net/krao/`, write it to that
repo with `com.atproto.repo.putRecord`:

- `repo`: `<DID>`
- `collection`: `com.atproto.lexicon.schema`
- `rkey`: the lexicon's `id` (eg `net.krao.authWeb3`)
- `record`: the file's JSON plus `"$type": "com.atproto.lexicon.schema"`

Publish again whenever a lexicon changes.

## 2. DNS records

One TXT record per NSID authority, all with the same value
`"did=<DID>"`:

```
_lexicon.krao.net                    TXT "did=<DID>"   ; net.krao.authWeb3, net.krao.authMiniApp
_lexicon.account.krao.net            TXT "did=<DID>"
_lexicon.actor.krao.net              TXT "did=<DID>"
_lexicon.analytics.krao.net          TXT "did=<DID>"
_lexicon.chain.krao.net              TXT "did=<DID>"
_lexicon.community.krao.net          TXT "did=<DID>"
_lexicon.creator.krao.net            TXT "did=<DID>"
_lexicon.embed.krao.net              TXT "did=<DID>"
_lexicon.feed.krao.net               TXT "did=<DID>"
_lexicon.gate.krao.net               TXT "did=<DID>"
_lexicon.moderation.gate.krao.net    TXT "did=<DID>"
_lexicon.admin.indexer.krao.net      TXT "did=<DID>"
_lexicon.kyc.krao.net                TXT "did=<DID>"
_lexicon.membership.krao.net         TXT "did=<DID>"
_lexicon.miniapp.krao.net            TXT "did=<DID>"
_lexicon.admin.miniapp.krao.net      TXT "did=<DID>"
_lexicon.nft.krao.net                TXT "did=<DID>"
_lexicon.admin.nft.krao.net          TXT "did=<DID>"
_lexicon.phone.krao.net              TXT "did=<DID>"
_lexicon.points.krao.net             TXT "did=<DID>"
_lexicon.poll.krao.net               TXT "did=<DID>"
_lexicon.push.krao.net               TXT "did=<DID>"
_lexicon.referral.krao.net           TXT "did=<DID>"
_lexicon.rewards.krao.net            TXT "did=<DID>"
_lexicon.admin.rewards.krao.net      TXT "did=<DID>"
_lexicon.safety.krao.net             TXT "did=<DID>"
_lexicon.admin.safety.krao.net       TXT "did=<DID>"
_lexicon.server.krao.net             TXT "did=<DID>"
_lexicon.token.krao.net              TXT "did=<DID>"
_lexicon.admin.token.krao.net        TXT "did=<DID>"
_lexicon.wallet.krao.net             TXT "did=<DID>"
```

Only `_lexicon.krao.net` is needed for OAuth; the others let any atproto
tool resolve the rest. A new namespace under `net.krao` needs its own record.

## 3. Check

```sh
dig +short TXT _lexicon.krao.net        # "did=<DID>"
```

Then start an OAuth sign-in from a client asking for
`include:net.krao.authMiniApp`: the consent screen lists "Krao Mini App".

Do not set `PDS_LEXICON_AUTHORITY_DID` on the production PDS for this: it
sends every NSID (including `app.bsky.*` permission sets) to one repo.
