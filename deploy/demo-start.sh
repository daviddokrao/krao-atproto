#!/usr/bin/env bash
# Starts the Krao sandbox: wipes Postgres/Redis (like dev-infra does), runs the
# dev-env, then seeds demo data once it is up. Exits when the dev-env exits so
# Docker restarts the whole thing from a clean state.
set -euo pipefail

until pg_isready -q -d "$DB_POSTGRES_URL"; do sleep 1; done
for schema in $(psql "$DB_POSTGRES_URL" -At -c \
  "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'"); do
  psql "$DB_POSTGRES_URL" -q -c "DROP SCHEMA \"$schema\" CASCADE"
done
psql "$DB_POSTGRES_URL" -q -c 'CREATE SCHEMA IF NOT EXISTS "public"'
redis-cli -u "redis://$REDIS_HOST" flushall >/dev/null

cd /app/packages/dev-env
node --enable-source-maps dist/bin.js &
devenv=$!

cd /app
node deploy/demo-setup.mjs || echo "⚠️  demo seed failed, the sandbox runs without demo data"

wait "$devenv"
