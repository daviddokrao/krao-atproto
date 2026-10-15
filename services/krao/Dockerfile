# One image for Krao's whole backend: PDS, AppView, bsync, Ozone and the
# Krao services. docker-compose picks what each container runs. One build
# instead of eight, and every service always runs the same commit.
#
#   docker build -f services/krao/Dockerfile -t krao-backend .
FROM node:24.18-bookworm-slim AS build

# Native modules (better-sqlite3, sharp) fall back to building from source
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.11.0

WORKDIR /app
COPY . .

RUN PUPPETEER_SKIP_DOWNLOAD=true pnpm install --frozen-lockfile
# One package at a time: `tsc --build --force` rewrites shared dependencies,
# which breaks packages building in parallel
RUN pnpm run --recursive --stream --workspace-concurrency 1 \
  --filter 'pds-service...' --filter 'bsky-app-view-service...' \
  --filter 'bsync-service...' --filter 'ozone-service...' \
  --filter '@krao/indexer...' --filter '@krao/chat...' \
  --filter '@krao/video...' --filter '@krao/rewards...' \
  --filter '@krao/push...' \
  build -- --force

# With the dev dependencies, for one-off jobs such as the local PLC of a
# rehearsal (services/krao/rehearsal); never run in production
FROM build AS tools
ENV NODE_ENV=development

FROM build AS prune
# Only production dependencies in the final image
RUN pnpm install --prod --shamefully-hoist --frozen-lockfile --prefer-offline \
  --config.confirmModulesPurge=false

FROM node:24.18-bookworm-slim

# ffmpeg for krao-video; dumb-init forwards signals and reaps zombies;
# postgresql-client (15, like the postgres image) for backup.mjs
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg dumb-init ca-certificates \
    postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=prune /app /app
WORKDIR /app

RUN mkdir /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production
# potential perf issues w/ io_uring on this version of node
ENV UV_USE_IO_URING=0

USER node
ENTRYPOINT ["dumb-init", "--"]
# Overridden per service in docker-compose.yml
CMD ["node", "-e", "console.error('Pick a service, see services/krao/docker-compose.yml'); process.exit(1)"]

LABEL org.opencontainers.image.description="Krao backend (PDS, AppView, Ozone, Krao services)"
LABEL org.opencontainers.image.licenses=MIT
