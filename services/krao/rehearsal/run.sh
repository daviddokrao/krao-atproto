#!/usr/bin/env bash
# Rehearses the production stack on this machine (Linux or WSL with Docker):
# builds the images, starts everything with services/krao/docker-compose.yml
# plus the rehearsal overrides, runs the smoke test, takes a backup, wipes
# the data, restores it and checks it is all back.
#
#   bash services/krao/rehearsal/run.sh          full run
#   bash services/krao/rehearsal/run.sh down     stop and delete everything
set -euo pipefail
cd "$(dirname "$0")/.."
DC=(docker compose -p krao-rehearsal -f docker-compose.yml -f rehearsal/docker-compose.rehearsal.yml --env-file rehearsal/.env)
DATA_VOLUMES=(pds indexer chat video rewards push postgres)

if [ "${1:-}" = down ]; then
  "${DC[@]}" down -v --remove-orphans
  exit 0
fi

step() { echo; echo "== $*"; }

step "Images"
docker build -f Dockerfile -t krao-backend:latest ../..
docker build -f Dockerfile --target tools -t krao-backend-tools:latest ../..

step "Environment"
docker run --rm krao-backend:latest node services/krao/rehearsal/gen-env.mjs > rehearsal/.env
mkdir -p rehearsal/backups secrets
"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true

step "Postgres, PLC, MinIO, Caddy"
# Ozone's DID is made below; a placeholder lets compose parse the file
echo "OZONE_SERVER_DID=did:plc:placeholder" >> rehearsal/.env
"${DC[@]}" up -d postgres plc minio caddy
until "${DC[@]}" exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt; do sleep 1; done
docker run --rm --network krao-rehearsal_internal --env-file rehearsal/.env \
  --entrypoint sh minio/mc:RELEASE.2025-04-16T18-13-26Z -c \
  'mc alias set m http://minio:9000 "$KRAO_S3_ACCESS_KEY_ID" "$KRAO_S3_SECRET_ACCESS_KEY" && mc mb -p m/$KRAO_GATE_MEDIA_S3_BUCKET'

step "Ozone DID on the local PLC"
OZONE_DID=$(docker run --rm --network krao-rehearsal_internal --env-file rehearsal/.env   krao-backend:latest node services/krao/create-ozone-did.mjs | tail -1)
sed -i "s#^OZONE_SERVER_DID=.*#OZONE_SERVER_DID=$OZONE_DID#" rehearsal/.env
echo "$OZONE_DID"

step "Everything else"
"${DC[@]}" up -d
for url in pds:3000/xrpc/_health appview:2584/xrpc/_health indexer:2589/_health chat:2590/_health rewards:2592/_health push:2593/_health; do
  until "${DC[@]}" exec -T push node -e "fetch('http://$url').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; do sleep 2; done
  echo "up: $url"
done

step "Smoke test"
"${DC[@]}" run --rm --no-deps -T backup node services/krao/rehearsal/smoke.mjs create

step "Backup"
"${DC[@]}" run --rm --no-deps -T backup node services/krao/backup.mjs
ARCHIVE=$(ls -1 rehearsal/backups/krao-backup-*.tar | tail -1)
echo "$ARCHIVE"

step "Wipe the data"
"${DC[@]}" stop
for v in "${DATA_VOLUMES[@]}"; do docker volume rm "krao-rehearsal_$v"; done

step "Restore"
"${DC[@]}" up -d postgres plc minio caddy
until "${DC[@]}" exec -T postgres pg_isready -U krao >/dev/null; do sleep 1; done
"${DC[@]}" run --rm --no-deps -T backup node services/krao/restore.mjs "/backups/$(basename "$ARCHIVE")"
"${DC[@]}" up -d
for url in pds:3000/xrpc/_health appview:2584/xrpc/_health indexer:2589/_health chat:2590/_health; do
  until "${DC[@]}" exec -T push node -e "fetch('http://$url').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; do sleep 2; done
done

step "Everything is back"
"${DC[@]}" run --rm --no-deps -T backup node services/krao/rehearsal/smoke.mjs verify
