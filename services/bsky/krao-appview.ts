/*
 * Krao's AppView in one process: the Postgres data plane, the API, and the
 * subscriptions that fill the data plane from Krao's PDS firehose and from
 * bsync. Bluesky runs these as separate (partly closed) services; Krao indexes
 * only its own network, which one process handles.
 *
 * Env: everything ServerConfig.readEnv reads (BSKY_*), plus
 *   BSKY_SERVICE_SIGNING_KEY   hex secp256k1 key of the AppView DID (required)
 *   BSKY_DB_POSTGRES_URL       Postgres for the data plane (required)
 *   BSKY_DB_POSTGRES_SCHEMA    schema (default bsky)
 *   BSKY_DB_POOL_SIZE          connections (default 20)
 *   BSKY_REPO_PROVIDER         firehose to index, e.g. wss://pds.krao.net (required)
 *   BSKY_DATAPLANE_PORT        internal data plane port (default 2585)
 *   KRAO_TRUSTED_VERIFIER_DIDS comma-separated accounts whose
 *                              app.bsky.graph.verification records count
 *                              (blue check); when set, the only ones
 */
import assert from 'node:assert'
import {
  BskyAppView,
  BsyncSubscription,
  DataPlaneServer,
  Database,
  RepoSubscription,
  ServerConfig,
} from '@atproto/bsky'
import { Secp256k1Keypair } from '@atproto/crypto'

/** How often the firehose cursor is written, at most */
const CURSOR_SAVE_MS = 5_000

const main = async () => {
  const signingKeyHex = process.env.BSKY_SERVICE_SIGNING_KEY
  const dbUrl = process.env.BSKY_DB_POSTGRES_URL
  const repoProvider = process.env.BSKY_REPO_PROVIDER
  assert(signingKeyHex, 'must set BSKY_SERVICE_SIGNING_KEY')
  assert(dbUrl, 'must set BSKY_DB_POSTGRES_URL')
  assert(repoProvider, 'must set BSKY_REPO_PROVIDER')
  const schema = process.env.BSKY_DB_POSTGRES_SCHEMA || 'bsky'
  const dataplanePort = Number(process.env.BSKY_DATAPLANE_PORT || 2585)

  const migrationDb = new Database({ url: dbUrl, schema })
  await migrationDb.migrateToLatestOrThrow()
  await migrationDb.close()

  const db = new Database({
    url: dbUrl,
    schema,
    poolSize: Number(process.env.BSKY_DB_POOL_SIZE || 20),
  })
  // search_path is the schema, see Database
  await db.pool.query(
    'create table if not exists krao_subscription_cursor (service varchar primary key, cursor bigint not null)',
  )

  await applyTrustedVerifiers(db, process.env.KRAO_TRUSTED_VERIFIER_DIDS)

  const config = ServerConfig.readEnv({
    dataplaneUrls: [`http://localhost:${dataplanePort}`],
  })
  const dataplane = await DataPlaneServer.create(
    db,
    dataplanePort,
    config.didPlcUrl,
    // Rehearsals only: identity lookups to a private PLC
    config.disableSsrfProtection ? globalThis.fetch : undefined,
  )
  const signingKey = await Secp256k1Keypair.import(signingKeyHex)
  const server = BskyAppView.create({ config, signingKey })
  const bsyncSub = new BsyncSubscription({ config, db })

  let lastSaved = 0
  const sub = new RepoSubscription({
    service: repoProvider,
    db,
    idResolver: dataplane.idResolver,
    cursor: {
      get: async () => {
        const res = await db.pool.query(
          'select cursor from krao_subscription_cursor where service = $1',
          [repoProvider],
        )
        return res.rows.length ? Number(res.rows[0].cursor) : undefined
      },
      // Events are idempotent, so a cursor a few seconds old only repeats work
      set: async (cursor) => {
        const now = Date.now()
        if (now - lastSaved < CURSOR_SAVE_MS) return
        lastSaved = now
        await db.pool.query(
          'insert into krao_subscription_cursor (service, cursor) values ($1, $2) on conflict (service) do update set cursor = excluded.cursor',
          [repoProvider, cursor],
        )
      },
    },
  })

  await server.start()
  bsyncSub.start()
  void sub.start()
  console.log(`Krao AppView listening on ${config.port}`)

  const shutdown = async () => {
    await server.destroy()
    await bsyncSub.destroy()
    await sub.destroy()
    await dataplane.destroy()
    await db.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

/**
 * Bluesky marks trusted verifiers by hand in the data plane's actor table;
 * Krao sets them from the environment at start. An account the AppView has
 * not seen yet gets its row now (with an old indexedAt, so its handle is
 * still indexed when it shows up).
 */
async function applyTrustedVerifiers(db: Database, env: string | undefined) {
  if (!env?.trim()) return
  const dids = env
    .split(',')
    .map((did) => did.trim())
    .filter((did) => did.startsWith('did:'))
  await db.pool.query(
    'update actor set "trustedVerifier" = false where "trustedVerifier" and not (did = any($1::varchar[]))',
    [dids],
  )
  for (const did of dids) {
    await db.pool.query(
      'insert into actor (did, "indexedAt", "trustedVerifier") values ($1, $2, true) on conflict (did) do update set "trustedVerifier" = true',
      [did, new Date(0).toISOString()],
    )
  }
  if (dids.length) console.log(`Krao trusted verifiers: ${dids.join(', ')}`)
}

main()
