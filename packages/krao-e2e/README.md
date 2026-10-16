# @krao/e2e

End-to-end checks of the Krao features against a running local stack. They
are plain Node scripts (no test runner) that print `PASS`/`FAIL` per check and
exit non-zero on any failure.

| Script                | Milestone | Covers                                                                                                                                          |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `records.mjs`         | M2        | PDS validates `net.krao.*` records against their lexicons                                                                                       |
| `wallet.mjs`          | M3        | SIWE wallet links, copied proofs, sign in with wallet, replay                                                                                   |
| `tip.mjs`             | M4        | ETH/USDC tips verified on-chain, cheating tips rejected                                                                                         |
| `nft.mjs`             | M5        | `resolveNft`, verified NFT avatar, badges, re-check on sale                                                                                     |
| `gate.mjs`            | M6        | Token gating, service auth, gated text absent from the CAR                                                                                      |
| `feed.mjs`            | —         | Krao "latest" feed: generator, skeleton, AppView `getFeed`                                                                                      |
| `link-preview.mjs`    | —         | Link previews and image proxy, SSRF guards (needs internet)                                                                                     |
| `gifs.mjs`            | —         | GIF media relay and search (needs internet; search needs a Klipy key)                                                                           |
| `starter-packs.mjs`   | —         | Short links and starter pack share cards                                                                                                        |
| `video.mjs`           | —         | Multipart video upload, processing, PDS blob, HLS playback (ffmpeg)                                                                             |
| `handles.mjs`         | —         | Handles that clash with app pages (short profile URLs) are reserved                                                                             |
| `chat.mjs`            | —         | Direct and group chat through the PDS proxy (requests, joins, locks)                                                                            |
| `discovery.mjs`       | —         | Popular feed, suggested accounts/feeds/starter packs, trending topics                                                                           |
| `chat-moderation.mjs` | —         | `chat.bsky.moderation.*` for Ozone, chat lock                                                                                                   |
| `referral.mjs`        | —         | Mandatory referral codes, pending/approved points, manual KYC, codes, revocation                                                                |
| `push.mjs`            | M25       | Device tokens through the AppView, pushes for likes, replies, chat, KYC                                                                         |
| `compliance.mjs`      | M26       | Phone before posts/chat, one number per account, consent, exports, one-level referrals, gate moderation, deletion                               |
| `safety.mjs`          | M27       | Phishing link checks and admin list, unsafe posts out of Popular, address owners, verification badge, seed phrases refused in chat, human badge |
| `community.mjs`       | M29       | NFT-gated community, member-only posts, community feed, moderator hides, bans, approvals                                                        |
| `poll.mjs`            | M29       | One vote per account, verified-only polls, token polls weighted at a snapshot block, deadlines, hidden results                                  |
| `search.mjs`          | M30       | Accent-insensitive search: "tien ao" finds "tiền ảo", đ as d, phrase ranked first, accounts by display name                                     |
| `token.mjs`           | M30       | Token catalog, ETH price from a Uniswap v3 pool on the fork, price history, $ETH cashtag feed, NotFound, admin put/remove                       |
| `growth.mjs`          | M32       | First wallet and first post rewarded once, opt-in weekly leaderboard, verified Basename (forward + reverse on the fork), Tiếng Việt feed        |
| `membership.mjs`      | M31       | Plans, USDC payment on the fork, membership gate open/closed after 31 days (runs last), reused tx, top supporters, stats                        |

Posting and chat need a verified phone in the dev-env: `login()` (and the
groups' sign-up helpers) verify one through the real flow, reading the code
from the rewards service's `/internal/dev/last-otp`.

## Prerequisites

1. Dev-env running: `make run-dev-env` (PDS :2583, AppView :2584, Krao
   indexer/gate :2589, Krao video :2591, Krao chat :2590). The video service and `video.mjs`
   need `ffmpeg` and `ffprobe` on the PATH.
2. Seeded accounts: `node scripts/seed-local.mjs` from the Krao-Network root,
   after **every** dev-env start (it wipes data).
3. Anvil Base fork on :8545 (`docker start krao-anvil`, chain id 8453).
4. `@krao/wallet` built: `pnpm --filter @krao/wallet build`.

The scripts top up USDC with `anvil_dealERC20` and move `hello.base.eth` to the
dev wallet themselves, so they also work on a freshly restarted Anvil.

## Run

```bash
pnpm --filter @krao/e2e e2e             # all, in milestone order
node packages/krao-e2e/run-all.mjs gate # a subset
node packages/krao-e2e/tip.mjs          # a single script
```

Override endpoints with `KRAO_PDS_URL`, `KRAO_INDEXER_URL`, `KRAO_GATE_URL`,
`KRAO_GATE_DID`, `KRAO_VIDEO_URL`, `KRAO_VIDEO_DID` and `KRAO_RPC_URL`.

The scripts use Anvil's publicly known dev keys and write test records to the
dev accounts; never point them at a real chain or a production PDS.
