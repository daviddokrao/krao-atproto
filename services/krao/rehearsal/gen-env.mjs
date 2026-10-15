// Prints a fresh .env for a rehearsal: random secrets and keys, the
// krao.test domain, the local PLC and MinIO. Never use it for production.
import { randomBytes } from 'node:crypto'

const secret = () => randomBytes(24).toString('base64url')
const key = () => randomBytes(32).toString('hex')

const env = {
  KRAO_DOMAIN: 'krao.test',
  KRAO_ACME_EMAIL: 'ops@krao.test',
  KRAO_PLC_URL: 'http://plc:2582',
  POSTGRES_PASSWORD: secret(),
  PDS_JWT_SECRET: secret(),
  PDS_ADMIN_PASSWORD: secret(),
  PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: key(),
  BSKY_SERVICE_SIGNING_KEY: key(),
  BSKY_ADMIN_PASSWORD: secret(),
  BSYNC_API_KEY: secret(),
  OZONE_SIGNING_KEY_HEX: key(),
  OZONE_ROTATION_KEY_HEX: key(),
  OZONE_ADMIN_PASSWORD: secret(),
  KRAO_REWARDS_INTERNAL_TOKEN: secret() + secret(),
  KRAO_GATE_MEDIA_SECRET: secret() + secret(),
  KRAO_PUSH_COURIER_KEY: secret() + secret(),
  KRAO_PUSH_INTERNAL_TOKEN: secret() + secret(),
  // Tips are not rehearsed: no chain here
  KRAO_RPC_URLS: '{"eip155:8453":"http://127.0.0.1:9"}',
  KRAO_REWARDS_BOOTSTRAP_CODE: 'KRAO-REHEARSAL',
  KRAO_GATE_MEDIA_S3_BUCKET: 'krao-gate-media',
  KRAO_GATE_MEDIA_S3_REGION: 'us-east-1',
  KRAO_GATE_MEDIA_S3_ENDPOINT: 'http://minio:9000',
  KRAO_GATE_MEDIA_S3_PATH_STYLE: 'true',
  KRAO_S3_ACCESS_KEY_ID: 'rehearsal',
  KRAO_S3_SECRET_ACCESS_KEY: secret(),
  KRAO_BACKUP_DIR: './rehearsal/backups',
}
for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`)
