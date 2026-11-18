#!/usr/bin/env node
/*
 * Creates the moderation service's DID (Ozone) on the PLC directory: a
 * labeler whose label key is OZONE_SIGNING_KEY_HEX, at https://mod.<domain>.
 * Prints the DID, for OZONE_SERVER_DID. Run once per network:
 *
 *   docker compose run --rm --no-deps push node services/krao/create-ozone-did.mjs
 *
 * Env: KRAO_DOMAIN, KRAO_PLC_URL, OZONE_SIGNING_KEY_HEX, and
 * OZONE_ROTATION_KEY_HEX (keep it offline afterwards: it controls the DID).
 */
import { Secp256k1Keypair } from '@atproto/crypto'
import { Client } from '@did-plc/lib'

const need = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const domain = need('KRAO_DOMAIN')
const plcUrl = process.env.KRAO_PLC_URL || 'https://plc.directory'
const signing = await Secp256k1Keypair.import(need('OZONE_SIGNING_KEY_HEX'))
const rotation = await Secp256k1Keypair.import(need('OZONE_ROTATION_KEY_HEX'))

const client = new Client(plcUrl)
const did = await client.createDid({
  signingKey: signing.did(),
  rotationKeys: [rotation.did()],
  handle: `mod.${domain}`,
  pds: `https://pds.${domain}`,
  signer: rotation,
})
await client.updateData(did, rotation, (data) => ({
  ...data,
  verificationMethods: {
    ...data.verificationMethods,
    atproto_label: signing.did(),
  },
  services: {
    ...data.services,
    atproto_labeler: {
      type: 'AtprotoLabeler',
      endpoint: `https://mod.${domain}`,
    },
  },
}))
console.log(did)
