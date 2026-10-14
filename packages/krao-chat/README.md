# @krao/chat

Krao's chat service, in place of Bluesky's (closed source) one. It serves the
`chat.bsky.*` API the app already uses: direct messages and group chats.

## How the app reaches it

- **Through the user's PDS.** The app calls the PDS with
  `atproto-proxy: <chat DID>#bsky_chat`. The PDS looks up the `#bsky_chat`
  endpoint in the DID document and forwards the call with a service auth
  token, addressed to that DID and the method. The service checks both.
- **The DID:**
  - production: `did:web:chat.krao.net`, served at `/.well-known/did.json`
    when `KRAO_CHAT_PUBLIC_URL` is set;
  - dev-env: a fixed `did:plc` with a `#bsky_chat` service, printed on start
    and returned by `/_health`.
- **App settings:** `EXPO_PUBLIC_CHAT_PROXY_DID`, plus
  `EXPO_PUBLIC_KRAO_CHAT_URL` for the few reads made while signed out (join
  link previews).

## What it covers

- **Direct convos** (`chat.bsky.convo.*`)
  - One convo per pair of accounts.
  - **Starting a convo is allowed** unless either side blocks the other, or
    the recipient's chat setting forbids it (`allowIncoming`: `all`,
    `following` (the default) or `none`).
  - **Requests:** a convo from someone the recipient does not follow arrives
    as a request. Replying accepts it.
  - **Leaving:** a convo one left comes back (as a request) when the other
    side writes.
  - Also: messages with replies, record embeds and facets; emoji reactions
    (up to 5 per account per message); read state and unread counts; mute;
    delete for self.
- **Groups** (`chat.bsky.group.*`, plus lock and unlock)
  - **Members:** owner and members; added members start as requests; the
    owner cannot leave.
  - **Adding people** follows the same block and settings checks, using
    `allowGroupInvites` and falling back to `allowIncoming`.
  - **System messages** announce member, name, lock and join link changes.
  - **Join links:** open or requiring approval, open to anyone or only to
    people the owner follows. Removed members cannot rejoin by link.
- **Real time:** events go to each member's log (`getLog`), which the app
  polls. Revs are fixed-width, base-36 timestamps, so they compare as strings
  and keep growing across restarts.
- **Hydration:** profiles, follows, blocks and posts come from Krao's
  AppView.
- **Not implemented:** `chat.bsky.moderation.*` (Ozone's chat tools).

## Configuration (`bin.ts`)

| Env                    | Default                 |
| ---------------------- | ----------------------- |
| `KRAO_CHAT_PORT`       | `2590`                  |
| `KRAO_CHAT_DID`        | `did:web:chat.krao.net` |
| `KRAO_CHAT_PUBLIC_URL` | – (did:web document)    |
| `KRAO_CHAT_DB`         | `krao-chat.sqlite`      |
| `KRAO_PLC_URL`         | `https://plc.directory` |
| `KRAO_APPVIEW_URL`     | `https://api.krao.net`  |

## Tests

`packages/krao-e2e/chat.mjs` (28 checks) runs against the dev-env through the
PDS proxy, like the app.
