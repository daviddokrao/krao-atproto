// M28: smart contract wallets. A Coinbase Smart Wallet on the Anvil Base fork
// links to an account and signs in, before it is deployed (ERC-6492, checked
// by simulating the deployment) and after (ERC-1271). The indexer and the PDS
// check these signatures through their Base RPC (the dev-env's Anvil).
import {
  COINBASE_SMART_WALLET_FACTORY,
  coinbaseCreateAccountCalldata,
  coinbaseGetAddressCalldata,
  coinbaseReplaySafeHash,
  coinbaseSignature,
  coinbaseUndeployedSignature,
  hashEvmMessage,
  hexToBytes,
  readAddress,
} from '@krao/wallet'
import { secp256k1 } from '@noble/curves/secp256k1'
import * as ui8 from 'uint8arrays'
import {
  INDEXER,
  PDS,
  SIGNUP_CODE,
  checker,
  createRecord,
  rpc,
  sameAccount,
  sleep,
  wallet,
  walletRecord,
  xrpc,
} from './lib.mjs'

const CHAIN_ID = 8453
/** Anvil #0, unlocked on the dev chain: pays for deployments */
const FUNDER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const { check, done } = checker()
const stamp = Date.now().toString(36).slice(-6)

/**
 * A Coinbase Smart Wallet owned by a fresh key. `sign` signs a message the
 * way the wallet app would: the owner signs the wallet's replay-safe hash,
 * wrapped for ERC-6492 while the wallet is not deployed.
 */
async function smartWallet() {
  const key = secp256k1.utils.randomPrivateKey()
  const owner = wallet(ui8.toString(key, 'base16'))
  const result = await rpc('eth_call', [
    {
      to: COINBASE_SMART_WALLET_FACTORY,
      data: coinbaseGetAddressCalldata([owner.address], 0),
    },
    'latest',
  ])
  const address = readAddress(hexToBytes(result), 0)
  const ownerSign = (message, signer = key) => {
    const hash = coinbaseReplaySafeHash({
      hash: hashEvmMessage(message),
      wallet: address,
      chainId: CHAIN_ID,
    })
    const s = secp256k1.sign(hash, signer)
    return ui8.concat([
      s.toCompactRawBytes(),
      new Uint8Array([s.recovery + 27]),
    ])
  }
  const w = {
    address,
    account: `eip155:${CHAIN_ID}:${address}`,
    owner,
    deployed: false,
    sign: (message) =>
      w.deployed
        ? coinbaseSignature({ ownerSignature: ownerSign(message) })
        : coinbaseUndeployedSignature({
            owners: [owner.address],
            ownerSignature: ownerSign(message),
          }),
    /** Wrapped for ERC-6492 even when deployed (wallets may keep doing so) */
    signWrapped: (message) =>
      coinbaseUndeployedSignature({
        owners: [owner.address],
        ownerSignature: ownerSign(message),
      }),
    /** Signed by a key that does not own the wallet */
    signForged: (message) =>
      coinbaseSignature({
        ownerSignature: ownerSign(message, secp256k1.utils.randomPrivateKey()),
      }),
  }
  return w
}

async function deploy(w) {
  const tx = await rpc('eth_sendTransaction', [
    {
      from: FUNDER,
      to: COINBASE_SMART_WALLET_FACTORY,
      data: coinbaseCreateAccountCalldata([w.owner.address], 0),
    },
  ])
  for (let i = 0; i < 50; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [tx])
    if (receipt) break
    await sleep(200)
  }
  w.deployed = (await rpc('eth_getCode', [w.address, 'latest'])) !== '0x'
  return w.deployed
}

async function signUp(name) {
  const handle = `${name}${stamp}.test`
  const res = await xrpc(PDS, 'com.atproto.server.createAccount', {
    body: {
      handle,
      email: `${handle}@example.com`,
      password: 'krao-dev-pass',
      inviteCode: SIGNUP_CODE,
    },
  })
  if (!res.ok) throw new Error(`createAccount: ${res.data.message}`)
  return res.data
}

async function walletLogin(w, sign = w.sign) {
  const ch = await xrpc(PDS, 'net.krao.server.getWalletChallenge', {
    query: { account: w.account },
  })
  if (!ch.ok) return ch
  return xrpc(PDS, 'net.krao.server.createWalletSession', {
    body: {
      account: w.account,
      message: ch.data.message,
      signature: sign(ch.data.message),
    },
  })
}

async function linkStatus(did, w) {
  for (let i = 0; i < 20; i++) {
    const prof = await xrpc(INDEXER, 'net.krao.actor.getChainProfiles', {
      query: { actors: [did] },
    })
    const link = prof.data.profiles?.[0]?.wallets?.find((x) =>
      sameAccount(x.account, w.account),
    )
    if (link) return link
    await sleep(500)
  }
  return undefined
}

const ann = await signUp('sw')

// 1. A wallet that does not exist yet links and signs in (ERC-6492)
const a = await smartWallet()
check(
  'the smart wallet is not deployed yet',
  (await rpc('eth_getCode', [a.address, 'latest'])) === '0x',
)
const linkA = await createRecord(
  ann,
  'net.krao.actor.wallet',
  walletRecord(ann.did, a),
)
check('link record accepted by the PDS', linkA.ok, JSON.stringify(linkA.data))
const statusA = await linkStatus(ann.did, a)
check(
  'indexer verifies the undeployed wallet link (ERC-6492)',
  statusA?.status === 'verified',
  JSON.stringify(statusA),
)
const loginA = await walletLogin(a)
check(
  'undeployed wallet signs in (ERC-6492)',
  loginA.ok && loginA.data.did === ann.did,
  loginA.data.error ?? loginA.data.handle,
)

// 2. Once deployed, plain ERC-1271 signatures (and still wrapped ones) work
check('the wallet deploys through the factory', await deploy(a))
const login1271 = await walletLogin(a)
check(
  'deployed wallet signs in (ERC-1271)',
  login1271.ok && login1271.data.did === ann.did,
  login1271.data.error ?? login1271.data.handle,
)
const loginWrapped = await walletLogin(a, a.signWrapped)
check(
  'a wrapped signature from the deployed wallet still signs in',
  loginWrapped.ok && loginWrapped.data.did === ann.did,
  loginWrapped.data.error,
)
const forged = await walletLogin(a, a.signForged)
check(
  'a signature by a key that does not own the wallet is rejected',
  !forged.ok && forged.data.error === 'InvalidSignature',
  forged.data.error,
)

// 3. A deployed wallet links with ERC-1271
const b = await smartWallet()
await deploy(b)
const linkB = await createRecord(
  ann,
  'net.krao.actor.wallet',
  walletRecord(ann.did, b),
)
check('second link accepted by the PDS', linkB.ok, JSON.stringify(linkB.data))
const statusB = await linkStatus(ann.did, b)
check(
  'indexer verifies the deployed wallet link (ERC-1271)',
  statusB?.status === 'verified',
  JSON.stringify(statusB),
)
// A link signed by someone else's key stays invalid
const c = await smartWallet()
await createRecord(
  ann,
  'net.krao.actor.wallet',
  walletRecord(ann.did, c, { sign: c.signForged }),
)
const statusC = await linkStatus(ann.did, c)
check(
  'a forged smart wallet link is marked invalid',
  statusC?.status === 'invalid',
  JSON.stringify(statusC),
)
done()
