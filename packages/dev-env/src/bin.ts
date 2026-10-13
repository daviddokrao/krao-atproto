import { KraoIndexer } from '@krao/indexer'
import { generateMockSetup } from './mock/index.js'
import { TestNetwork } from './network.js'
import { mockMailer } from './util.js'

const KRAO_INDEXER_PORT = 2589

/*
 * Public hostname of the main PDS, for hosting the dev-env as a sandbox (eg
 * the krao.vssa.com demo): account DID documents then point at it instead of
 * localhost. The services still reach each other on localhost.
 */
const PDS_HOSTNAME = process.env.KRAO_DEV_PDS_HOSTNAME || 'localhost'

const run = async () => {
  console.log(`
██████╗
██╔═══██╗
██║██╗██║
██║██║██║
╚█║████╔╝
 ╚╝╚═══╝  protocol

[ created by Bluesky ]`)

  const network = await TestNetwork.create({
    pds: {
      port: 2583,
      hostname: PDS_HOSTNAME,
      /*
       * The dev-env maps the PDS public URL to localhost in its resolvers, so
       * a session's DID doc would send a remote browser to localhost. Without
       * it, clients keep using the URL they signed in with.
       */
      enableDidDocWithSession: PDS_HOSTNAME === 'localhost',
      kraoIndexerUrl: `http://localhost:${KRAO_INDEXER_PORT}`,
    },
    bsky: {
      dbPostgresSchema: 'bsky',
      port: 2584,
      publicUrl: 'http://localhost:2584',
    },
    plc: { port: 2582 },
    ozone: {
      port: 2587,
      chatUrl: 'http://localhost:2590', // must run separate chat service
      chatDid: 'did:example:chat',
      dbMaterializedViewRefreshIntervalMs: 30_000,
    },
    introspect: { port: 2581 },
  })
  mockMailer(network.pds)

  if (network.introspect) {
    console.log(
      `🔍 Dev-env introspection server http://localhost:${network.introspect.port}`,
    )
  }
  console.log(`👤 DID Placeholder server http://localhost:${network.plc.port}`)
  console.log(`🌞 Main PDS http://localhost:${network.pds.port}`)
  console.log(`🌞 Main PDS account DB`, network.pds.ctx.cfg.db.accountDbLoc)
  console.log(
    `🔨 Lexicon authority DID ${network.pds.ctx.cfg.lexicon.didAuthority}`,
  )
  console.log(`🗼 Ozone server http://localhost:${network.ozone.port}`)
  console.log(`🗼 Ozone service DID ${network.ozone.ctx.cfg.service.did}`)
  console.log(`🔄 Bsync server http://localhost:${network.bsync.port}`)
  console.log(`🌅 Bsky Appview http://localhost:${network.bsky.port}`)
  console.log(`🌅 Bsky Appview DID ${network.bsky.serverDid}`)
  for (const fg of network.feedGens) {
    console.log(`🤖 Feed Generator (${fg.did}) http://localhost:${fg.port}`)
  }

  // Krao indexer: follows the main PDS firehose, in memory like the rest of
  // the dev-env, so it starts empty on every run
  const kraoIndexer = await KraoIndexer.create({
    port: KRAO_INDEXER_PORT,
    dbLocation: ':memory:',
    firehoseUrl: network.pds.url.replace('http', 'ws'),
    plcUrl: network.plc.url,
    handleResolverUrl: network.pds.url,
    appviewUrl: network.bsky.url,
    nftRecheckMs: 15_000,
    gateDid: 'did:web:gate.krao.test',
    // Local Anvil chain (chain id 8453, forked from Base), see Krao README
    rpcUrls: {
      'eip155:8453': process.env.KRAO_DEV_RPC_URL ?? 'http://localhost:8545',
    },
    insecureFetch: true,
  })
  await kraoIndexer.start()
  console.log(`💎 Krao indexer ${kraoIndexer.url}`)

  console.time('✅ Dev environment is ready')
  await generateMockSetup(network)
  console.timeEnd('✅ Dev environment is ready')
}

run()
