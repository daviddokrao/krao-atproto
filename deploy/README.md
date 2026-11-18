# Demo deploy (krao.net)

The public sandbox at https://krao.net: the whole dev-env (PLC, PDS, AppView,
Ozone and the Krao services, in memory) in one container, a Base fork on
Anvil behind `rpc-guard.mjs`, and demo data from `demo-setup.mjs`. Every
deploy starts it empty again.

```bash
bash C:/PROJECTS/claude-config/platform/deploy-remote.sh <this repo> kraonet-backend
```

This is not production: see `services/krao/` for that.
