---
'@atproto/dev-env': patch
---

Krao safety: the dev-env creates `krao-verify.test` as a trusted verifier (and any account in `KRAO_TRUSTED_VERIFIER_DIDS`), and makes `rewards-admin.test` a safety admin of the indexer's unsafe domain list
