# @krao/e2e

End-to-end checks of the Krao features against a running local stack. They
are plain Node scripts (no test runner) that print `PASS`/`FAIL` per check and
exit non-zero on any failure.

| Script        | Milestone | Covers                                                        |
| ------------- | --------- | ------------------------------------------------------------- |
| `records.mjs` | M2        | PDS validates `io.krao.*` records against their lexicons      |
| `wallet.mjs`  | M3        | SIWE wallet links, copied proofs, sign in with wallet, replay |
| `tip.mjs`     | M4        | ETH/USDC tips verified on-chain, cheating tips rejected       |
| `nft.mjs`     | M5        | `resolveNft`, verified NFT avatar, badges, re-check on sale   |
| `gate.mjs`    | M6        | Token gating, service auth, gated text absent from the CAR    |

## Prerequisites

1. Dev-env running: `make run-dev-env` (PDS :2583, AppView :2584, Krao
   indexer/gate :2589).
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
`KRAO_GATE_DID` and `KRAO_RPC_URL`.

The scripts use Anvil's publicly known dev keys and write test records to the
dev accounts; never point them at a real chain or a production PDS.
