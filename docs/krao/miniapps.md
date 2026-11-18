# Krao Mini Apps

A Mini App is a web app that runs inside Krao: in a sandboxed frame on the web,
in a WebView in the iOS and Android apps. It can ask Krao who the user is, for
one of their linked wallets, for a signature or a transaction, and Krao asks
the user every time it matters. Krao previews every signature and transaction
before the wallet signs it.

The lexicons are listed in [lexicons.md](./lexicons.md) (generated from
`lexicons/net/krao`).

## Publishing a Mini App

A Mini App is a `net.krao.miniapp.app` record in its developer's repo (any
record key):

| Field         | Rules                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `name`        | Required, at most 64 characters                                                                        |
| `description` | At most 300 characters                                                                                 |
| `url`         | Required. https, on an origin that is not Krao's web app (the dev-env also takes `http://localhost:*`) |
| `icon`        | PNG, JPEG or WebP blob, at most 1 MB; Krao shows it through its own proxy                              |
| `permissions` | Distinct values of `identity`, `wallet`, `sign`, `transaction`; the app may only ask for what it lists |
| `chains`      | Only `eip155:8453` (Base) for now                                                                      |
| `createdAt`   | Required                                                                                               |

Write it like any record (`com.atproto.repo.putRecord`). Krao's indexer picks
it up from the firehose:

- `net.krao.miniapp.getApp {uri}` returns the app and its `status`.
- `net.krao.miniapp.listApproved {limit, cursor}` lists approved apps, the
  ones Krao's discovery screen shows.

### Review

Krao's safety team reviews each **version** of the record (its CID):

| Status     | Meaning                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pending`  | New, or changed since it was approved. Changing any field (a new CID) needs a new review                                                                                                         |
| `approved` | This CID was approved. Only approved apps run                                                                                                                                                    |
| `revoked`  | Taken down by Krao (until approved again, whatever the record holds), or the developer's account is taken down, or the app's domain is on Krao's unsafe domain list (`revokedReason` says which) |
| `invalid`  | The record breaks the rules above (`invalidReason` says how). Fix the record                                                                                                                     |

Reviewers use `net.krao.miniapp.admin.listPending`,
`net.krao.miniapp.admin.approve {uri, cid}` (the CID must be the current one,
so a change made during review is never approved by mistake) and
`net.krao.miniapp.admin.revoke {uri, reason}`. Every decision is logged.

### In posts

A post shows a Mini App card when its embed is a `net.krao.embed.miniapp`
`{app: strongRef}` pointing at the app record. Clients that do not know it
ignore it. The card opens the app only while it is approved.

## Running inside Krao

- Web: `<iframe sandbox="allow-scripts allow-same-origin allow-forms">`, no
  top navigation and no pop-ups. Native: a WebView limited to the app's
  origin; navigating elsewhere is blocked.
- Krao checks `getApp` when the app opens and runs it only when it is
  `approved`.
- The first time a user opens an app (that URI and CID), Krao asks whether to
  allow what `permissions` lists. Users can report an app from its menu
  (`com.atproto.moderation.createReport` on the record).

## The SDK protocol

JSON messages over `postMessage`. In a frame, post to `window.parent`; in the
native apps, send JSON text with `window.ReactNativeWebView.postMessage`
(Android delivers answers on `document`, iOS on `window`). Krao only accepts
messages from the app's frame and its manifest origin, and answers to that
origin only. Messages over 64 KB are dropped.

Mini App to Krao:

```json
{ "krao": 1, "id": "r1", "method": "getContext", "params": {} }
{ "krao": 1, "event": "ready" }
```

Krao to Mini App:

```json
{ "krao": 1, "id": "r1", "result": { "...": "..." } }
{ "krao": 1, "id": "r1", "error": { "code": "PermissionDenied", "message": "..." } }
```

Error codes: `PermissionDenied`, `UserRejected`, `Unsupported`, `NotApproved`,
`InvalidParams`, `Failed`.

| Method            | Permission    | Params                | Result                                                                                       |
| ----------------- | ------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `getContext`      | `identity`    |                       | `{user: {did, handle, displayName?}, app: {uri}, platform: 'web'\|'ios'\|'android', locale}` |
| `requestWallet`   | `wallet`      |                       | `{address, chain: 'eip155:8453'}`, a wallet the user linked and picked                       |
| `signMessage`     | `sign`        | `{message}`           | `{signature}` (personal_sign), after the signature preview                                   |
| `sendTransaction` | `transaction` | `{to, data?, value?}` | `{hash}`, after the transaction preview; never signed silently                               |
| `close`           |               |                       | Closes the app                                                                               |

At most one signature or transaction request waits at a time.

## Previews

Before a wallet signs anything, Krao's app calls the indexer (service auth,
30 a minute per account):

- `net.krao.wallet.simulate {chain, from, to, data?, value?, authorizationList?, origin?}`
  runs the transaction on Krao's Base node with `debug_traceCall` (method
  `trace`): what the user would lose and receive, the approvals it grants,
  gas. Nodes that cannot trace get the calldata decoded instead (method
  `decode`: ERC-20/721/1155 transfers and approvals, Permit2 `approve`, the
  native value), with `eth_call` telling whether it reverts.
- `net.krao.wallet.inspectSignature {chain, from, method, payload, origin?}`
  explains a `personal_sign` message or EIP-712 typed data: EIP-2612, DAI and
  Permit2 permits, marketplace orders, EIP-7702 authorizations, Krao's own
  wallet proofs.

Warnings (`code`, `severity`):

| Code                    | Severity | When                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `reverts`               | danger   | The transaction would fail                                                                             |
| `unlimitedApproval`     | danger   | An allowance of at least 2^255 (Permit2: 2^159) or the token's whole supply                            |
| `approvalForAll`        | danger   | `setApprovalForAll(operator, true)`: every NFT of the collection                                       |
| `eip7702Delegation`     | danger   | The account would delegate to a contract Krao does not trust (`warning` for trusted ones)              |
| `lookalikeAddress`      | danger   | An address that starts and ends like another Krao account's verified wallet                            |
| `unsafeOrigin`          | danger   | The Mini App's domain is on Krao's unsafe domain list                                                  |
| `walletProofPhishing`   | danger   | A Krao wallet link or sign-in message asked for by a Mini App, or a sign-in message for another domain |
| `marketplaceOrder`      | danger   | A Seaport, Blur or LooksRare order: it can sell the user's NFTs                                        |
| `simulationUnavailable` | warning  | Krao's node could not run the transaction                                                              |
| `chainMismatch`         | warning  | The typed data or message names another chain                                                          |
| `blindSignature`        | warning  | `personal_sign` of bytes that are not text                                                             |
| `unknownContract`       | info     | `to` is a contract outside Krao's token and NFT catalogs                                               |

A `danger` warning makes Cancel the main button, and the user must tick "I
understand the risk" to sign. `ok: false` blocks signing, unless the only
problem is `simulationUnavailable`.

## Security rules for Mini App developers

- Serve the app over https from your own origin. Krao's origins are refused.
- Ask only for the permissions you need; each request is confirmed by the
  user and can be refused.
- Never ask users to sign Krao's wallet link or sign-in messages: Krao flags
  them as phishing.
- Keep transactions readable: plain transfers and approvals of what you need,
  not unlimited ones.
- Any change to the record needs a new review before users can open the app
  again.

## OAuth permission sets

Apps that sign users in with OAuth can ask for Krao's permission sets:

- `include:net.krao.authWeb3` (with `?aud=` the Krao service DID for its RPC
  part): the user's wallets, NFT avatar, tips, memberships, polls, gated
  posts, communities and Mini App records, and Krao's wallet and rewards
  methods. Not the account's phone number, identity verification (KYC),
  consents or data export: those stay with Krao's own app.
- `include:net.krao.authMiniApp`: only creating poll votes and tips.

The PDS resolves `net.krao.*` lexicons through DNS (`_lexicon.krao.net`, see
`services/krao/deploy/dns-lexicon.md`); the dev-env publishes both sets in its
lexicon authority repo.

## Trying it locally

The dev-env serves a sample Mini App at `http://localhost:2595/`
(`services/krao/miniapp-sample/index.html`, one file, no dependencies). The
seed script registers it in krao.test's repo as "Bỏ phiếu nhanh", approves
it and posts it.
