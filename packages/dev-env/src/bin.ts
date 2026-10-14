import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client as PlcClient } from '@did-plc/lib'
import { KraoChat } from '@krao/chat'
import { KraoIndexer } from '@krao/indexer'
import { KraoVideo } from '@krao/video'
import { Secp256k1Keypair } from '@atproto/crypto'
import { generateMockSetup } from './mock/index.js'
import { TestNetwork } from './network.js'
import { mockMailer } from './util.js'

const KRAO_INDEXER_PORT = 2589
const KRAO_VIDEO_PORT = 2591
const KRAO_CHAT_PORT = 2590

/*
 * Public hostname of the main PDS, for hosting the dev-env as a sandbox (eg
 * the krao.vssa.com demo): account DID documents then point at it instead of
 * localhost. The services still reach each other on localhost.
 */
const PDS_HOSTNAME = process.env.KRAO_DEV_PDS_HOSTNAME || 'localhost'

/** Public URL of the Krao video service, where the AppView points players */
const VIDEO_URL =
  process.env.KRAO_DEV_VIDEO_URL || `http://localhost:${KRAO_VIDEO_PORT}`

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
      // Videos are stored as blobs, up to the video service's limit
      blobUploadLimit: 100 * 1024 * 1024,
      // Shown on the sign-up screen (describeServer)
      homeUrl: 'https://krao.net/',
      termsOfServiceUrl: 'https://krao.net/terms',
      privacyPolicyUrl: 'https://krao.net/privacy',
      supportUrl: 'https://krao.net/support',
    },
    bsky: {
      dbPostgresSchema: 'bsky',
      port: 2584,
      // Image and other public URLs the AppView hands out (see PDS_HOSTNAME)
      publicUrl: process.env.KRAO_DEV_APPVIEW_URL || 'http://localhost:2584',
      videoPlaylistUrlPattern: `${VIDEO_URL}/watch/%s/%s/playlist.m3u8`,
      videoThumbnailUrlPattern: `${VIDEO_URL}/watch/%s/%s/thumbnail.jpg`,
      // Suggestions, suggested feeds and trending topics come from the indexer
      suggestionsUrl: `http://localhost:${KRAO_INDEXER_PORT}`,
      topicsUrl: `http://localhost:${KRAO_INDEXER_PORT}`,
      irisUrl: `http://localhost:${KRAO_INDEXER_PORT}`,
    },
    plc: { port: 2582 },
    ozone: {
      port: 2587,
      chatUrl: 'http://localhost:2590', // must run separate chat service
      // The Krao chat service's DID, fixed by its key (created below)
      chatDid: 'did:plc:gpiadqebr3yazrys6dw4gvfi',
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

  const feedGenDid = await createServiceDid(network.plc.url, {
    key: '0894dfe194b02e2cb6b89104555be95d1b361f59c4389ab92c3967e057817ef2',
    handle: 'feed.krao.test',
    endpoint: `http://localhost:${KRAO_INDEXER_PORT}`,
    serviceId: 'bsky_fg',
    serviceType: 'BskyFeedGenerator',
  })
  console.log(`📰 Krao feed generator DID ${feedGenDid}`)

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
    feedGenDid,
    // Where short links lead: the web app in front of this dev-env
    webUrl: process.env.KRAO_DEV_WEB_URL || 'http://localhost:8081',
  })
  await kraoIndexer.start()
  console.log(`💎 Krao indexer ${kraoIndexer.url}`)

  // Krao video service: needs ffmpeg and ffprobe on the PATH
  const kraoVideo = KraoVideo.create({
    port: KRAO_VIDEO_PORT,
    serviceDid: 'did:web:video.krao.test',
    dataDir: await mkdtemp(path.join(os.tmpdir(), 'krao-video-')),
    plcUrl: network.plc.url,
    pdsUrls: [
      network.pds.url,
      ...(PDS_HOSTNAME === 'localhost'
        ? []
        : [`https://${PDS_HOSTNAME}=${network.pds.url}`]),
    ],
    insecureFetch: true,
  })
  await kraoVideo.start()
  console.log(`🎬 Krao video service ${kraoVideo.url}`)

  // Krao chat service, reached through the PDS (atproto-proxy) at its DID
  const chatDid = await createServiceDid(network.plc.url, {
    key: 'fed1834dfe994df0369545ad3218d7ceaa499f162548a8ce689f7d9ec1a1b9ea',
    handle: 'chat.krao.test',
    endpoint: `http://localhost:${KRAO_CHAT_PORT}`,
    serviceId: 'bsky_chat',
    serviceType: 'BskyChatService',
  })
  const kraoChat = await KraoChat.create({
    port: KRAO_CHAT_PORT,
    serviceDid: chatDid,
    dbLocation: ':memory:',
    plcUrl: network.plc.url,
    appviewUrl: network.bsky.url,
    insecureFetch: true,
  })
  await kraoChat.start()
  console.log(`💬 Krao chat service (${chatDid}) ${kraoChat.url}`)

  console.time('✅ Dev environment is ready')
  await generateMockSetup(network)
  console.timeEnd('✅ Dev environment is ready')
}

/**
 * Registers a did:plc for a Krao service (the indexer as feed generator, the
 * chat service) with a fixed dev-only key, so the DID stays the same across
 * runs (like the dev-env AppView's) and clients can be configured with it.
 */
async function createServiceDid(
  plcUrl: string,
  opts: {
    key: string
    handle: string
    endpoint: string
    serviceId: string
    serviceType: string
  },
): Promise<string> {
  const keypair = await Secp256k1Keypair.import(opts.key)
  const plcClient = new PlcClient(plcUrl)
  const did = await plcClient.createDid({
    signingKey: keypair.did(),
    rotationKeys: [keypair.did()],
    handle: opts.handle,
    pds: opts.endpoint,
    signer: keypair,
  })
  await plcClient.updateData(did, keypair, (data) => {
    data.services[opts.serviceId] = {
      type: opts.serviceType,
      endpoint: opts.endpoint,
    }
    return data
  })
  return did
}

run()
