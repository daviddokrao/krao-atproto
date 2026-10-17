import { Subscription } from '@atproto/xrpc-server'
import { subLogger as log } from '../../logger.js'
import type { Database } from './db/index.js'

/*
 * Krao: labels from Krao's own labeler (its Ozone) into the data plane's
 * `label` table, which hydration reads. Bluesky fills that table with a
 * separate service; Krao follows the labeler's
 * com.atproto.label.subscribeLabels, keeping its cursor in
 * krao_subscription_cursor. Only labels whose `src` is the labeler's DID are
 * taken (the connection is to Krao's own service, on Krao's network). A
 * negation removes the label it negates.
 */

type WireLabel = {
  src?: unknown
  uri?: unknown
  cid?: unknown
  val?: unknown
  neg?: unknown
  cts?: unknown
  exp?: unknown
}

type LabelsMessage = {
  $type: string
  seq?: number
  labels?: WireLabel[]
}

export class KraoLabelSubscription {
  private ac?: AbortController
  private running?: Promise<void>
  /** Latest sequence number taken (for tests and logs) */
  seq?: number

  constructor(
    public opts: {
      db: Database
      /** The labeler's URL (eg http://ozone:3000) */
      service: string
      /** The labeler's DID: the only `src` taken */
      labelerDid: string
    },
  ) {}

  private get cursorKey() {
    return `labels:${this.opts.labelerDid}`
  }

  private async ensureTable() {
    await this.opts.db.pool.query(
      'create table if not exists krao_subscription_cursor (service varchar primary key, cursor bigint not null)',
    )
  }

  async getCursor(): Promise<number | undefined> {
    const res = await this.opts.db.pool.query(
      'select cursor from krao_subscription_cursor where service = $1',
      [this.cursorKey],
    )
    const value = res.rows[0]?.cursor
    return value === undefined ? undefined : Number(value)
  }

  private async setCursor(seq: number) {
    await this.opts.db.pool.query(
      'insert into krao_subscription_cursor (service, cursor) values ($1, $2) on conflict (service) do update set cursor = excluded.cursor',
      [this.cursorKey, seq],
    )
  }

  /** Takes one subscribeLabels message (exported for tests) */
  async handleMessage(message: LabelsMessage) {
    if (!message.$type.endsWith('#labels')) return
    for (const label of message.labels ?? []) {
      await this.applyLabel(label)
    }
    if (typeof message.seq === 'number') {
      this.seq = message.seq
      await this.setCursor(message.seq)
    }
  }

  async applyLabel(label: WireLabel) {
    if (label.src !== this.opts.labelerDid) return
    if (typeof label.uri !== 'string' || typeof label.val !== 'string') return
    const cid = typeof label.cid === 'string' ? label.cid : ''
    const { db } = this.opts.db
    if (label.neg === true) {
      await db
        .deleteFrom('label')
        .where('src', '=', label.src)
        .where('uri', '=', label.uri)
        .where('cid', '=', cid)
        .where('val', '=', label.val)
        .execute()
      return
    }
    const row = {
      src: label.src,
      uri: label.uri,
      cid,
      val: label.val,
      neg: false,
      cts: typeof label.cts === 'string' ? label.cts : new Date().toISOString(),
      exp: typeof label.exp === 'string' ? label.exp : null,
    }
    await db
      .insertInto('label')
      .values(row)
      .onConflict((oc) =>
        oc
          .columns(['src', 'uri', 'cid', 'val'])
          .doUpdateSet({ neg: false, cts: row.cts, exp: row.exp }),
      )
      .execute()
  }

  start() {
    if (this.ac) return
    const ac = new AbortController()
    this.ac = ac
    this.running = (async () => {
      await this.ensureTable()
      while (!ac.signal.aborted) {
        try {
          const sub = new Subscription<LabelsMessage>({
            service: this.opts.service.replace(/^http/, 'ws'),
            method: 'com.atproto.label.subscribeLabels',
            signal: ac.signal,
            getParams: async () => {
              const cursor = await this.getCursor()
              return cursor === undefined ? {} : { cursor }
            },
            validate: (value) =>
              value && typeof value === 'object' && '$type' in value
                ? (value as LabelsMessage)
                : undefined,
            onReconnectError: (err) =>
              log.warn({ err }, 'krao label subscription reconnecting'),
          })
          for await (const message of sub) {
            await this.handleMessage(message)
          }
        } catch (err) {
          if (ac.signal.aborted) break
          log.error({ err }, 'krao label subscription failed')
          await new Promise((resolve) => setTimeout(resolve, 5_000))
        }
      }
    })()
  }

  async destroy() {
    this.ac?.abort()
    await this.running?.catch(() => undefined)
    this.ac = undefined
  }
}
