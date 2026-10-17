# PLC mirror (`plc-mirror`)

Krao's services resolve `did:plc` DIDs through their own copy of
plc.directory (`packages/krao-plc-mirror`), so an outage, rate limit or
block of plc.directory does not stop sign-in, feeds or handles.

- `plc-mirror` copies `KRAO_PLC_URL` (plc.directory) through its `/export`
  and **checks every operation** (genesis hash, rotation key signatures,
  order, recoveries) before taking it.
- The AppView, Ozone, the PDS and every Krao service use
  `KRAO_PLC_RESOLVE_URL` (default `http://plc-mirror:2596`).
- The PDS also **writes** through it: `POST /:did` is passed on to
  plc.directory and, once plc.directory accepts it, served by the mirror at
  once (a handle change shows right away). If plc.directory refuses, the PDS
  gets its answer unchanged.
- A DID the mirror does not have yet is fetched from plc.directory on first
  request (`/:did/log/audit`, checked the same way).

## First start: how much to copy

plc.directory holds every Bluesky DID: tens of millions of operations.

| Choice                                                             | First sync                        | Disk                 |
| ------------------------------------------------------------------ | --------------------------------- | -------------------- |
| `KRAO_PLC_MIRROR_START_AFTER=` (empty): everything                 | days (each operation is verified) | tens of GB in SQLite |
| `KRAO_PLC_MIRROR_START_AFTER=2026-10-17T00:00:00Z` (eg launch day) | minutes                           | small                |

With a start time, DIDs created earlier (eg Bluesky accounts someone
follows) are copied whole the first time anything asks for them; while
plc.directory is down, such DIDs not asked for before do not resolve. Krao's
own accounts, all created after the start, are always there. The start
time is used only while the mirror has no cursor: changing it later does
nothing (delete the volume to start over).

During a full first sync everything already works: DIDs not copied yet are
fetched on demand. `/_health` shows `lagSeconds: null` until the mirror
first catches up, and the monitor reports "first sync running".

```bash
docker compose up -d plc-mirror
docker compose exec plc-mirror node -e "fetch('http://localhost:2596/_health').then(r=>r.json()).then(console.log)"
# {ok, source, ops, cursor, lagSeconds, caughtUpAt, lastPollAt, lastError, rejected}
```

## Watching it

`monitor` checks `http://plc-mirror:2596/_health` every minute:

- **down**: no DID resolves (sign-in, sign-up, feeds, handle checks).
  Restart it (`docker compose up -d plc-mirror`); if it does not come back,
  bypass it (below).
- **`plc-mirror-lag`**: more than `KRAO_MONITOR_PLC_MIRROR_MAX_LAG_SEC`
  (600) behind. `lastError` says why (plc.directory down or rate limiting:
  wait, the mirror retries with backoff up to a minute; DIDs already copied
  keep resolving). New accounts and handle changes made through Krao's PDS
  are not affected (they go through the mirror).
- **`plc-mirror-rejected`**: plc.directory served operations that failed the
  checks (count since the last start, details in `docker compose logs
plc-mirror`). They were not taken. Report it: either a bug in the mirror's
  checks, or the directory served something forged.

## Bypassing it

Set `KRAO_PLC_RESOLVE_URL=https://plc.directory` (the value of
`KRAO_PLC_URL`) in `.env` and `docker compose up -d`: every service then
talks to plc.directory directly, as before the mirror. Remove the line to go
back.

## Data

The mirror's SQLite file (`plc-mirror` volume) is not in the backups: it is
a copy, rebuilt by deleting the volume and starting again (with
`KRAO_PLC_MIRROR_START_AFTER`, in minutes).
