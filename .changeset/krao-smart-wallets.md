---
'@atproto/pds': patch
'@atproto/dev-env': patch
---

Krao: wallet sign-in (`net.krao.server.createWalletSession`) accepts smart contract wallets (ERC-1271, ERC-6492 before deployment, EIP-7702) on the chain of `PDS_KRAO_EVM_RPC_URL` (`PDS_KRAO_EVM_CHAIN_ID`, default Base 8453); the dev-env points it at its Anvil fork
