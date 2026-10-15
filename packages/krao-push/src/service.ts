import type { Database, Platform } from './db.js'
import type { PushMessage, Sender } from './senders.js'

/** How long a sent key is remembered for de-duplication */
const SENT_TTL_MS = 2 * 24 * 60 * 60 * 1000
/** Devices one account may register; the oldest go first */
const MAX_TOKENS_PER_DID = 20

export class PushService {
  constructor(
    public db: Database,
    public senders: Partial<Record<Platform, Sender>>,
  ) {}

  async registerToken(opts: {
    did: string
    token: string
    platform: Platform
    appId: string
    ageRestricted: boolean
  }) {
    const now = new Date().toISOString()
    await this.db
      .insertInto('device_token')
      .values({
        did: opts.did,
        token: opts.token,
        platform: opts.platform,
        appId: opts.appId,
        ageRestricted: opts.ageRestricted ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflict((oc) =>
        oc.columns(['did', 'token']).doUpdateSet({
          platform: opts.platform,
          appId: opts.appId,
          ageRestricted: opts.ageRestricted ? 1 : 0,
          updatedAt: now,
        }),
      )
      .execute()
    // Reinstalls leave dead tokens behind; keep the newest few
    const stale = await this.db
      .selectFrom('device_token')
      .select('token')
      .where('did', '=', opts.did)
      .orderBy('updatedAt', 'desc')
      .offset(MAX_TOKENS_PER_DID)
      .limit(1000)
      .execute()
    if (stale.length) {
      await this.db
        .deleteFrom('device_token')
        .where('did', '=', opts.did)
        .where(
          'token',
          'in',
          stale.map((r) => r.token),
        )
        .execute()
    }
  }

  async unregisterToken(did: string, token: string) {
    await this.db
      .deleteFrom('device_token')
      .where('did', '=', did)
      .where('token', '=', token)
      .execute()
  }

  /** The account was deleted: its devices get nothing more */
  async deleteAccount(did: string) {
    await this.db.deleteFrom('device_token').where('did', '=', did).execute()
  }

  /** The account's devices by platform, without tokens (data exports) */
  async deviceSummary(did: string) {
    const rows = await this.db
      .selectFrom('device_token')
      .select('platform')
      .where('did', '=', did)
      .execute()
    const platforms: Record<string, number> = {}
    for (const { platform } of rows) {
      platforms[platform] = (platforms[platform] ?? 0) + 1
    }
    return { count: rows.length, platforms }
  }

  async setAgeRestricted(did: string, ageRestricted: boolean) {
    await this.db
      .updateTable('device_token')
      .set({ ageRestricted: ageRestricted ? 1 : 0 })
      .where('did', '=', did)
      .execute()
  }

  async hasDevices(dids: string[]): Promise<Set<string>> {
    if (!dids.length) return new Set()
    const rows = await this.db
      .selectFrom('device_token')
      .select('did')
      .distinct()
      .where('did', 'in', dids)
      .execute()
    return new Set(rows.map((r) => r.did))
  }

  /** Which of `keys` are already handled */
  async claimed(keys: string[]): Promise<Set<string>> {
    if (!keys.length) return new Set()
    const rows = await this.db
      .selectFrom('sent')
      .select('key')
      .where('key', 'in', keys)
      .execute()
    return new Set(rows.map((r) => r.key))
  }

  /**
   * Marks `key` as handled. False when it already was: the caller then sends
   * nothing, so a notification read twice reaches devices once.
   */
  async claim(key: string): Promise<boolean> {
    const res = await this.db
      .insertInto('sent')
      .values({ key, sentAt: new Date().toISOString() })
      .onConflict((oc) => oc.column('key').doNothing())
      .executeTakeFirst()
    return Number(res.numInsertedOrUpdatedRows ?? 0) > 0
  }

  /** Sends `msg` to every device of `did`; returns how many accepted it */
  async deliver(did: string, msg: PushMessage): Promise<number> {
    const tokens = await this.db
      .selectFrom('device_token')
      .select(['token', 'platform'])
      .where('did', '=', did)
      .execute()
    let delivered = 0
    await Promise.all(
      tokens.map(async ({ token, platform }) => {
        const sender = this.senders[platform]
        if (!sender) return
        const result = await sender
          .send(token, {
            ...msg,
            data: { ...msg.data, recipientDid: did },
          })
          .catch((err: unknown) => {
            console.error('krao-push send failed', err)
            return 'error' as const
          })
        if (result === 'ok') delivered++
        if (result === 'invalid-token') {
          // The device is gone for every account on it
          await this.db
            .deleteFrom('device_token')
            .where('token', '=', token)
            .execute()
        }
      }),
    )
    return delivered
  }

  async pruneSent(now = Date.now()) {
    await this.db
      .deleteFrom('sent')
      .where('sentAt', '<', new Date(now - SENT_TTL_MS).toISOString())
      .execute()
  }
}
