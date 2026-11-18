# @krao/plc-mirror

A read-only copy of a `did:plc` directory (by default plc.directory) that
Krao's services resolve DIDs through, so an outage or block of the
directory does not take Krao down.

- **Sync:** `GET <source>/export?after=<cursor>&count=1000`, page after
  page; the cursor (time, or `seq:<n>` from directories that number their
  operations) is kept in SQLite. Polls every `KRAO_PLC_MIRROR_POLL_MS` once
  caught up, backs off up to `KRAO_PLC_MIRROR_MAX_BACKOFF_MS` on errors.
- **Every operation is checked** with `@did-plc/lib` before it is taken:
  genesis hash, signature by a current rotation key, order (`prev`), and
  recoveries (a higher key within 72 hours of the operation undone,
  measured from the source's times). A forged operation is refused and
  counted (`rejected` in `/_health`).
- **Reads** like a directory: `GET /:did`, `/:did/data`, `/:did/log`,
  `/:did/log/last`, `/:did/log/audit`. A DID the mirror does not have is
  copied from the source's audit log on first request
  (`KRAO_PLC_MIRROR_FALLBACK`, default on), else 404.
- **Writes:** `POST /:did` is passed to the source; when the source takes
  the operation, so does the mirror, before answering. Krao's PDS writes
  through the mirror, so a handle change is served at once.
- **`GET /_health`:** `{ok, source, ops, cursor, lagSeconds, caughtUpAt,
lastPollAt, lastError, rejected}`. `lagSeconds` is the time since the
  mirror last read a page shorter than a full one (caught up); `null`
  until the first time.

| Variable                         | Default                  |
| -------------------------------- | ------------------------ |
| `KRAO_PLC_MIRROR_PORT`           | `2596`                   |
| `KRAO_PLC_MIRROR_DB`             | `krao-plc-mirror.sqlite` |
| `KRAO_PLC_MIRROR_SOURCE`         | `https://plc.directory`  |
| `KRAO_PLC_MIRROR_POLL_MS`        | `5000`                   |
| `KRAO_PLC_MIRROR_MAX_BACKOFF_MS` | `60000`                  |
| `KRAO_PLC_MIRROR_FALLBACK`       | `true`                   |
| `KRAO_PLC_MIRROR_START_AFTER`    | (whole history)          |

Production: `services/krao/deploy/plc-mirror.md`. The dev-env runs it at
`http://localhost:2596` in front of its PLC (2582).
