import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client as PlcClient } from '@did-plc/lib'
import { KraoChat } from '@krao/chat'
import { KraoIndexer } from '@krao/indexer'
import { KraoPush } from '@krao/push'
import { KraoRewards, LogSmsProvider } from '@krao/rewards'
import { KraoVideo } from '@krao/video'
import { Secp256k1Keypair } from '@atproto/crypto'
import { generateMockSetup } from './mock/index.js'
import { TestNetwork } from './network.js'
import { mockMailer } from './util.js'

const KRAO_INDEXER_PORT = 2589
const KRAO_VIDEO_PORT = 2591
const KRAO_CHAT_PORT = 2590
const KRAO_REWARDS_PORT = 2592
const KRAO_PUSH_PORT = 2593
/** The AppView's courier key and Krao services' push token; dev only */
const KRAO_PUSH_COURIER_KEY = 'krao-dev-push-courier-key'
const KRAO_PUSH_TOKEN = 'krao-dev-push-internal-token'
const KRAO_PUSH = {
  url: `http://localhost:${KRAO_PUSH_PORT}`,
  token: KRAO_PUSH_TOKEN,
}

/** Shared by the dev PDS and rewards service; dev only */
const KRAO_REWARDS_TOKEN = 'krao-dev-rewards-token'
/** Campaign code for the seed scripts and e2e tests to sign up with */
const KRAO_DEV_CODE = 'KRAO-DEV'
/** Keys for stored phone numbers; dev only */
const KRAO_DEV_PHONE_SECRETS = {
  hmacSecret: 'krao-dev-phone-hmac-secret-0123456789',
  encKey: '0123456789abcdef'.repeat(4),
}
/*
 * Posting and chat need a verified phone (Decree 147), as in production.
 * Codes go to the log and to /internal/dev/last-otp of the rewards service.
 * KRAO_DEV_PHONE_REQUIRED=false turns it off (eg a public demo).
 */
const PHONE_REQUIRED = process.env.KRAO_DEV_PHONE_REQUIRED !== 'false'

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
      // Smart wallets sign in against the local Anvil fork of Base (8453)
      kraoEvmRpcUrl: process.env.KRAO_DEV_RPC_URL ?? 'http://localhost:8545',
      // Every seed and e2e sign-in comes from this machine
      kraoContractChecksPerIp: 10_000,
      // Invite codes are Krao referral codes (required once set up, below)
      kraoRewardsUrl: `http://localhost:${KRAO_REWARDS_PORT}`,
      kraoRewardsToken: KRAO_REWARDS_TOKEN,
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
      // Push notifications through Krao's push service (logged, not sent)
      courierUrl: KRAO_PUSH.url,
      courierApiKey: KRAO_PUSH_COURIER_KEY,
      courierHttpVersion: '1.1',
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
    // Tests and demos check feeds and suggestions right after writing
    discoveryCacheMs: 0,
    gateDid: 'did:web:gate.krao.test',
    // Local Anvil chain (chain id 8453, forked from Base), see Krao README
    rpcUrls: {
      'eip155:8453': process.env.KRAO_DEV_RPC_URL ?? 'http://localhost:8545',
    },
    insecureFetch: true,
    feedGenDid,
    // Where short links lead: the web app in front of this dev-env
    webUrl: process.env.KRAO_DEV_WEB_URL || 'http://localhost:8081',
    push: KRAO_PUSH,
    // Ozone, and rewards-admin.test (added below), may read gated content
    gateModeratorDids: [network.ozone.ctx.cfg.service.did],
    // Verified communities and polls (the rewards service starts below)
    rewards: {
      url: `http://localhost:${KRAO_REWARDS_PORT}`,
      token: KRAO_REWARDS_TOKEN,
    },
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
    // Ozone reviews reported messages through chat.bsky.moderation.*
    moderatorDids: [network.ozone.ctx.cfg.service.did],
    push: KRAO_PUSH,
    // Turned on below, once the dev-env's own accounts exist
    phone: {
      rewardsUrl: `http://localhost:${KRAO_REWARDS_PORT}`,
      token: KRAO_REWARDS_TOKEN,
      required: false,
    },
    firehoseUrl: network.pds.url.replace('http', 'ws'),
  })
  await kraoChat.start()
  console.log(`💬 Krao chat service (${chatDid}) ${kraoChat.url}`)

  // Krao rewards service: referral codes, points and KYC (no KYC provider
  // here; admins review by hand)
  const kraoRewards = await KraoRewards.create({
    port: KRAO_REWARDS_PORT,
    serviceDid: 'did:web:rewards.krao.test',
    dbLocation: ':memory:',
    plcUrl: network.plc.url,
    internalToken: KRAO_REWARDS_TOKEN,
    insecureFetch: true,
    // Tests review KYC by hand on every run
    manualReview: { dailyLimit: 1000 },
    push: KRAO_PUSH,
    // SMS codes are logged, and readable at /internal/dev/last-otp
    phone: {
      sms: new LogSmsProvider(),
      secrets: KRAO_DEV_PHONE_SECRETS,
      // Every seed and e2e request comes from this machine
      limits: { ipHourlyCap: 100_000, globalHourlyCap: 100_000 },
    },
    devMode: true,
  })
  await kraoRewards.start()
  await kraoRewards.service.createCode('system', {
    code: KRAO_DEV_CODE,
    kind: 'campaign',
    note: 'Dev-env sign-ups',
  })
  console.log(`🎁 Krao rewards service ${kraoRewards.url}`)

  // Krao push service: no FCM/APNs here, so pushes are only logged (and
  // listed at /internal/recent for the e2e tests)
  const kraoPush = await KraoPush.create({
    port: KRAO_PUSH_PORT,
    dbLocation: ':memory:',
    courierKey: KRAO_PUSH_COURIER_KEY,
    internalToken: KRAO_PUSH_TOKEN,
    appviewUrl: network.bsky.url,
    appviewDb: {
      url: network.bsky.db.opts.url,
      schema: network.bsky.db.opts.schema,
    },
    pollMs: 500,
    firehoseUrl: network.pds.url.replace('http', 'ws'),
    plcUrl: network.plc.url,
  })
  await kraoPush.start()
  console.log(`🔔 Krao push service ${kraoPush.url}`)

  console.time('✅ Dev environment is ready')
  await generateMockSetup(network)

  /*
   * Sign-up needs a referral code from here on. The dev-env's own accounts
   * (service profiles, mock users) are created by then, without codes. OAuth
   * sign-up keeps the setting it started with.
   */
  Object.assign(network.pds.ctx.cfg, {
    invites: { required: true, interval: null, epoch: 0 },
  })
  const admin = await createKraoAccount(network.pds.url, 'rewards-admin')
  kraoRewards.addAdmin(admin)
  kraoIndexer.addGateModerator(admin)
  kraoIndexer.addSafetyAdmin(admin)
  console.log(
    `🎁 Sign-up code ${KRAO_DEV_CODE}; rewards admin, gate moderator and safety admin rewards-admin.test (${admin})`,
  )
  /*
   * Krao's verifier: its app.bsky.graph.verification records give the blue
   * check (the seed script verifies krao.test with it). Production sets
   * verifiers with KRAO_TRUSTED_VERIFIER_DIDS, which works here too.
   */
  const verifier = await createKraoAccount(network.pds.url, 'krao-verify')
  for (const did of [
    verifier,
    ...(process.env.KRAO_TRUSTED_VERIFIER_DIDS ?? '').split(','),
  ]) {
    if (!did.trim().startsWith('did:')) continue
    await network.bsky.db.db
      .insertInto('actor')
      .values({
        did: did.trim(),
        // Old, so the AppView still indexes the handle when it sees one
        indexedAt: new Date(0).toISOString(),
        trustedVerifier: true,
      })
      .onConflict((oc) =>
        oc.column('did').doUpdateSet({ trustedVerifier: true }),
      )
      .execute()
  }
  console.log(`☑️ Trusted verifier krao-verify.test (${verifier})`)
  // Like sign-up codes: the mock accounts above posted without a phone
  if (PHONE_REQUIRED) {
    network.pds.ctx.cfg.kraoRewards!.phoneRequired = true
    kraoChat.phone!.cfg.required = true
    console.log('📱 Posting and chat need a verified phone (codes in the log)')
  }
  console.timeEnd('✅ Dev environment is ready')
}

/** Signs up an account with the dev code; returns its DID */
async function createKraoAccount(pdsUrl: string, name: string) {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: `${name}.test`,
      email: `${name}@krao.test`,
      password: 'krao-dev-pass',
      inviteCode: KRAO_DEV_CODE,
    }),
  })
  const body = (await res.json()) as {
    did?: string
    accessJwt?: string
    message?: string
  }
  if (!body.did) throw new Error(`Could not create ${name}: ${body.message}`)
  // A birth date, or the app asks for one before anything else
  await fetch(`${pdsUrl}/xrpc/app.bsky.actor.putPreferences`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${body.accessJwt}`,
    },
    body: JSON.stringify({
      preferences: [
        {
          $type: 'app.bsky.actor.defs#personalDetailsPref',
          birthDate: '1990-01-01T00:00:00.000Z',
        },
      ],
    }),
  })
  return body.did
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
