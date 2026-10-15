# Krao production backend

Everything Krao runs, on one host, from one image:

| Container               | What                                                                                 | Public at                            |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------ |
| `pds`                   | accounts, repos, blobs (SQLite + disk in the `pds` volume)                           | `pds.<domain>`, handles `*.<domain>` |
| `appview`               | `app.bsky.*` reads: data plane + API + firehose indexing (`../bsky/krao-appview.ts`) | `api.<domain>`                       |
| `bsync`                 | mutes and private data for the AppView                                               | –                                    |
| `ozone`, `ozone-daemon` | moderation                                                                           | `mod.<domain>`                       |
| `indexer`               | wallets, tips, gates, NFTs, feeds, discovery, short links                            | `idx.<domain>`                       |
| `chat`                  | DMs and groups (`chat.bsky.*`)                                                       | `chat.<domain>`                      |
| `video`                 | video uploads and HLS                                                                | `video.<domain>`                     |
| `rewards`               | referral codes, points, KYC                                                          | `rewards.<domain>`                   |
| `push`                  | device tokens and push notifications (in place of Bluesky's courier)                 | –                                    |
| `backup`                | daily backups                                                                        | –                                    |
| `postgres`              | AppView, bsync and Ozone data                                                        | –                                    |
| `caddy`                 | TLS and routing (`Caddyfile`)                                                        | ports 80/443                         |

Krao is its own network: the AppView indexes only this PDS, and nothing
talks to Bluesky's services.

## Before the first start

1. **A host.** 4 vCPU, 8 GB RAM, 160 GB disk is plenty to start; Docker
   with the compose plugin.
2. **DNS** for `<domain>`: A records for `pds`, `api`, `mod`, `idx`,
   `chat`, `video`, `rewards` and a wildcard `*` (user handles), all to the
   host. No proxying (Caddy needs to answer the ACME challenges itself).
3. **S3** (any compatible store): a _private_ bucket for gated media, and
   one for backups (preferably at another provider). If the gated media
   bucket keeps versions, add a lifecycle rule expiring noncurrent versions
   (e.g. after 30 days): deleted gated media must not live on in old
   versions.
4. **`.env`**: `cp .env.example .env` and fill it in. Keep a copy of the
   keys offline: the PLC rotation keys control everyone's DIDs.
5. **Ozone's DID**, once, on the PLC directory:

   ```bash
   docker compose build push
   docker run --rm --env-file .env krao-backend node services/krao/create-ozone-did.mjs
   ```

   Put the printed DID in `OZONE_SERVER_DID`.

## Start, update, check

```bash
docker compose up -d --build        # start, or update to the checked-out commit
docker compose ps                   # all "running"
docker compose logs -f appview      # one service's logs
curl https://idx.<domain>/_health   # firehose freshness, backlogs
```

SQLite schemas migrate themselves on start (`krao_migration` table);
Postgres ones too. Updates are `git pull` then `up -d --build`.

## After the first start

1. **Admins.** Sign up in the app with `KRAO_REWARDS_BOOTSTRAP_CODE`. Put the
   admins' DIDs in `KRAO_REWARDS_ADMIN_DIDS` / `OZONE_ADMIN_DIDS`, then
   remove the bootstrap code from `.env`, disable it in the referral admin
   screen and `docker compose up -d`.
2. **Feeds.** From a Krao account, create the `app.bsky.feed.generator`
   records `latest` and `popular` with `did: did:web:idx.<domain>` (as
   `deploy/seed-local.mjs` does for the demo).
3. **Moderation.** Publish the labeler record for Ozone's DID and add the
   moderators, following Ozone's own setup guide.
4. **The app** builds against these settings (`krao-app/.env`):

   ```
   EXPO_PUBLIC_DEFAULT_SERVICE=https://pds.<domain>
   EXPO_PUBLIC_PUBLIC_API=https://api.<domain>
   EXPO_PUBLIC_BLUESKY_PROXY_DID=did:web:api.<domain>
   EXPO_PUBLIC_CHAT_PROXY_DID=did:web:chat.<domain>
   EXPO_PUBLIC_KRAO_INDEXER_URL=https://idx.<domain>
   EXPO_PUBLIC_KRAO_GATE_DID=did:web:idx.<domain>
   EXPO_PUBLIC_KRAO_CHAT_URL=https://chat.<domain>
   EXPO_PUBLIC_KRAO_VIDEO_URL=https://video.<domain>
   EXPO_PUBLIC_KRAO_VIDEO_DID=did:web:video.<domain>
   EXPO_PUBLIC_KRAO_REWARDS_URL=https://rewards.<domain>
   EXPO_PUBLIC_KRAO_REWARDS_DID=did:web:rewards.<domain>
   EXPO_PUBLIC_KRAO_HANDLE_DOMAIN=.<domain>
   EXPO_PUBLIC_KRAO_DISCOVER_FEED=at://<feed account>/app.bsky.feed.generator/popular
   EXPO_PUBLIC_KRAO_LABELER=<Ozone handle or DID>
   ```

   and never `EXPO_PUBLIC_KRAO_DEV_WALLET`.

## Push notifications

Without keys, `push` only logs what it would send. For real pushes put in
`./secrets`:

- Android: a Firebase service account JSON for the `io.krao.app` project
  (`KRAO_PUSH_FCM_SERVICE_ACCOUNT_FILE=/secrets/fcm.json`); the app also
  needs that project's `google-services.json` at build time.
- iOS: an APNs auth key (`KRAO_PUSH_APNS_KEY_FILE=/secrets/apns.p8`, with
  `KRAO_PUSH_APNS_KEY_ID` and `KRAO_PUSH_APNS_TEAM_ID`).

The AppView hands device tokens to `push` as its courier; `push` reads the
AppView's notifications (likes, replies, follows, ...) and Krao's own events
(chat messages, tips, points, KYC), applies each person's push settings,
blocks and mutes, and sends. Pushes are in English for now.

## Backups

`backup` runs every `KRAO_BACKUP_EVERY_HOURS` and keeps `KRAO_BACKUP_KEEP`
archives in `KRAO_BACKUP_DIR` (and in `KRAO_BACKUP_S3_BUCKET` if set). Each
archive holds every SQLite database (copied with `VACUUM INTO`, then
`integrity_check`), a `pg_dump`, and the PDS blobs and videos. A backup that
fails a check is thrown away and the older ones kept. Gated media in S3 is
not in it: use the bucket's versioning, with the expiry rule above.

One now: `docker compose run --rm backup node services/krao/backup.mjs`

**Restore** into empty volumes:

```bash
docker compose down
docker volume rm krao_pds krao_indexer krao_chat krao_video krao_rewards krao_push krao_postgres
docker compose up -d postgres
docker compose run --rm backup node services/krao/restore.mjs /backups/krao-backup-<time>.tar
docker compose up -d
```

## Rehearsal

`bash services/krao/rehearsal/run.sh` runs this whole stack on one machine
(Linux or WSL with Docker) under `krao.test`: a local PLC instead of
plc.directory, SeaweedFS for S3, Caddy's own CA for TLS. It signs people up,
posts, follows, likes, chats, uploads gated media and checks the pushes,
then backs up, wipes every volume, restores, and checks it is all back.
`run.sh down` removes it. Run it before changing this directory.

## Limits

One host with SQLite suits up to roughly ten thousand active people. Past
that: Postgres for the PDS account data, more AppView processes, and the
chat service moved off SQLite.
