import { randomBytes, randomInt } from 'node:crypto'
import type { Transaction } from 'kysely'
import type {
  Beneficiary,
  CodeKind,
  Database,
  DatabaseSchema,
  EntryStatus,
  KycStatus,
  PointsEntryTable,
  ReferralCodeTable,
  RewardEvent,
  RewardRuleTable,
  Vesting,
} from './db.js'

type Db = Database | Transaction<DatabaseSchema>

/** Crockford base32 without 0/1 too: nothing to confuse when read aloud */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const PERSONAL_CODE_LENGTH = 8
const CODE_RE = /^[A-Z0-9-]{3,32}$/

export const normalizeCode = (code: string) => code.trim().toUpperCase()

export const isValidCodeFormat = (code: string) => CODE_RE.test(code)

export function randomCode(length = PERSONAL_CODE_LENGTH) {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return code
}

let lastMs = 0
let seq = 0

/** Sorts by creation time, also within the same millisecond */
export function newId() {
  const ms = Date.now()
  seq = ms === lastMs ? seq + 1 : 0
  lastMs = ms
  return (
    ms.toString(36).padStart(9, '0') +
    seq.toString(36).padStart(4, '0') +
    randomBytes(4).toString('hex')
  )
}

const now = () => new Date().toISOString()

const parseList = <T>(json: string): T[] => {
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export type Rule = Omit<
  RewardRuleTable,
  'enabled' | 'vesting' | 'codeKinds'
> & {
  enabled: boolean
  vesting: Vesting[]
  codeKinds: CodeKind[]
}

export type RuleInput = Omit<Rule, 'version' | 'updatedAt' | 'updatedBy'>

const toRule = (row: RewardRuleTable): Rule => ({
  ...row,
  enabled: !!row.enabled,
  vesting: parseList<Vesting>(row.vesting),
  codeKinds: parseList<CodeKind>(row.codeKinds),
})

/** The rules a new service starts with (David, 2026-10-14) */
export const DEFAULT_RULES: RuleInput[] = [
  {
    id: 'referral.inviter',
    enabled: true,
    description: 'Inviting someone who joins',
    event: 'account.created',
    beneficiary: 'referrer',
    amount: 100,
    vesting: ['kyc:self', 'kyc:related'],
    codeKinds: [],
    campaignId: null,
    validFrom: null,
    validUntil: null,
    capPerBeneficiary: null,
    capPerDay: null,
  },
  {
    id: 'referral.invitee',
    enabled: true,
    description: 'Joining with a referral code',
    event: 'account.created',
    beneficiary: 'actor',
    amount: 50,
    vesting: ['kyc:self', 'kyc:related'],
    codeKinds: [],
    campaignId: null,
    validFrom: null,
    validUntil: null,
    capPerBeneficiary: null,
    capPerDay: null,
  },
]

export type CodeCheck =
  | { valid: true; code: ReferralCodeTable }
  | { valid: false; reason: 'not_found' | 'disabled' | 'expired' | 'used_up' }

export type EntryView = PointsEntryTable & { waitingFor: Vesting[] }

export class RewardsService {
  constructor(public db: Database) {}

  async audit(
    db: Db,
    actor: string,
    action: string,
    subject: string | null,
    data?: unknown,
  ) {
    await db
      .insertInto('audit_log')
      .values({
        actor,
        action,
        subject,
        data: data === undefined ? null : JSON.stringify(data),
        createdAt: now(),
      })
      .execute()
  }

  // Codes
  // -----

  async getCode(db: Db, code: string) {
    return db
      .selectFrom('referral_code')
      .selectAll()
      .where('code', '=', normalizeCode(code))
      .executeTakeFirst()
  }

  async codeUses(db: Db, code: string) {
    const row = await db
      .selectFrom('referral')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('code', '=', code)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async checkCode(raw: string, db: Db = this.db): Promise<CodeCheck> {
    const code = normalizeCode(raw)
    if (!isValidCodeFormat(code)) return { valid: false, reason: 'not_found' }
    const row = await this.getCode(db, code)
    if (!row) return { valid: false, reason: 'not_found' }
    if (row.disabled) return { valid: false, reason: 'disabled' }
    if (row.expiresAt && row.expiresAt <= now()) {
      return { valid: false, reason: 'expired' }
    }
    if (
      row.maxUses !== null &&
      (await this.codeUses(db, code)) >= row.maxUses
    ) {
      return { valid: false, reason: 'used_up' }
    }
    return { valid: true, code: row }
  }

  /** The account's personal code, created on first use */
  async personalCode(did: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.db
        .selectFrom('referral_code')
        .select('code')
        .where('ownerDid', '=', did)
        .where('kind', '=', 'personal')
        .executeTakeFirst()
      if (existing) return existing.code
      // Either the random code or the account's personal code may clash
      await this.db
        .insertInto('referral_code')
        .values({
          code: randomCode(),
          kind: 'personal',
          ownerDid: did,
          campaignId: null,
          maxUses: null,
          expiresAt: null,
          disabled: 0,
          note: null,
          createdBy: did,
          createdAt: now(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    throw new Error('Could not create a personal referral code')
  }

  async createCode(
    admin: string,
    opts: {
      code?: string
      kind: CodeKind
      ownerDid?: string
      campaignId?: string
      maxUses?: number
      expiresAt?: string
      note?: string
    },
  ) {
    const code = normalizeCode(opts.code ?? randomCode(10))
    if (!isValidCodeFormat(code)) {
      throw new RewardsError(
        'InvalidRequest',
        'Codes are 3-32 letters, digits or dashes',
      )
    }
    return this.db.transaction().execute(async (tx) => {
      if (await this.getCode(tx, code)) {
        throw new RewardsError('CodeTaken', 'The code already exists')
      }
      const row: ReferralCodeTable = {
        code,
        kind: opts.kind,
        ownerDid: opts.ownerDid ?? null,
        campaignId: opts.campaignId ?? null,
        maxUses: opts.maxUses ?? null,
        expiresAt: opts.expiresAt ?? null,
        disabled: 0,
        note: opts.note ?? null,
        createdBy: admin,
        createdAt: now(),
      }
      await tx.insertInto('referral_code').values(row).execute()
      await this.audit(tx, admin, 'code.create', code, row)
      return row
    })
  }

  async updateCode(
    admin: string,
    opts: {
      code: string
      disabled?: boolean
      maxUses?: number
      expiresAt?: string
      note?: string
    },
  ) {
    return this.db.transaction().execute(async (tx) => {
      const row = await this.getCode(tx, opts.code)
      if (!row) throw new RewardsError('NotFound', 'No such code')
      const changes: Partial<ReferralCodeTable> = {}
      if (opts.disabled !== undefined) changes.disabled = opts.disabled ? 1 : 0
      if (opts.maxUses !== undefined) changes.maxUses = opts.maxUses
      if (opts.expiresAt !== undefined) changes.expiresAt = opts.expiresAt
      if (opts.note !== undefined) changes.note = opts.note
      if (Object.keys(changes).length) {
        await tx
          .updateTable('referral_code')
          .set(changes)
          .where('code', '=', row.code)
          .execute()
      }
      await this.audit(tx, admin, 'code.update', row.code, changes)
      return { ...row, ...changes }
    })
  }

  // Referrals
  // ---------

  /**
   * Records who referred a new account, as reported by the PDS. Idempotent:
   * the PDS retries until it gets an answer.
   */
  async recordReferral(did: string, rawCode: string, createdAt: string) {
    await this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('referral')
        .select('did')
        .where('did', '=', did)
        .executeTakeFirst()
      if (existing) return

      const code = normalizeCode(rawCode)
      const check = await this.checkCode(code, tx)
      const row = check.valid ? check.code : await this.getCode(tx, code)
      /*
       * The PDS checked the code; if it no longer passes (eg sign-ups raced
       * past its use limit), keep the sign-up but flag it for admins
       * instead of rewarding it
       */
      const flag = check.valid
        ? null
        : check.reason === 'used_up'
          ? 'over_limit'
          : 'invalid_code'
      const referrerDid = row?.ownerDid ?? null
      const referrer2Did = referrerDid
        ? ((
            await tx
              .selectFrom('referral')
              .select('referrerDid')
              .where('did', '=', referrerDid)
              .executeTakeFirst()
          )?.referrerDid ?? null)
        : null
      await tx
        .insertInto('referral')
        .values({
          did,
          code,
          referrerDid,
          referrer2Did,
          codeKind: row?.kind ?? null,
          campaignId: row?.campaignId ?? null,
          flag,
          createdAt,
        })
        .execute()
      if (flag) {
        await this.audit(tx, 'system', 'referral.flagged', did, { code, flag })
      }
      if (!flag) {
        await this.handleEvent(tx, {
          id: `account.created:${did}`,
          type: 'account.created',
          actorDid: did,
          referrerDid,
          referrer2Did,
          codeKind: row?.kind ?? null,
          campaignId: row?.campaignId ?? null,
          createdAt,
        })
      }
    })
  }

  // Rules
  // -----

  /** Adds the default rules to an empty rule table */
  async seedRules() {
    const any = await this.db
      .selectFrom('reward_rule')
      .select('id')
      .executeTakeFirst()
    if (any) return
    for (const rule of DEFAULT_RULES) await this.upsertRule('system', rule)
  }

  async listRules() {
    const rows = await this.db
      .selectFrom('reward_rule')
      .selectAll()
      .orderBy('id')
      .execute()
    return rows.map(toRule)
  }

  async upsertRule(admin: string, input: RuleInput) {
    return this.db.transaction().execute(async (tx) => {
      const old = await tx
        .selectFrom('reward_rule')
        .selectAll()
        .where('id', '=', input.id)
        .executeTakeFirst()
      const row: RewardRuleTable = {
        id: input.id,
        version: (old?.version ?? 0) + 1,
        enabled: input.enabled ? 1 : 0,
        description: input.description ?? null,
        event: input.event,
        beneficiary: input.beneficiary,
        amount: input.amount,
        vesting: JSON.stringify(input.vesting ?? []),
        codeKinds: JSON.stringify(input.codeKinds ?? []),
        campaignId: input.campaignId ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        capPerBeneficiary: input.capPerBeneficiary ?? null,
        capPerDay: input.capPerDay ?? null,
        updatedAt: now(),
        updatedBy: admin,
      }
      await tx
        .insertInto('reward_rule')
        .values(row)
        .onConflict((oc) => oc.column('id').doUpdateSet(row))
        .execute()
      await this.audit(tx, admin, 'rule.upsert', row.id, {
        before: old ? toRule(old) : null,
        after: toRule(row),
      })
      return toRule(row)
    })
  }

  // Events and ledger
  // -----------------

  /**
   * Runs the enabled rules for an event, once per event id, then approves
   * whatever the event made eligible
   */
  async handleEvent(
    tx: Db,
    event: {
      id: string
      type: RewardEvent
      actorDid: string
      referrerDid: string | null
      referrer2Did: string | null
      codeKind: CodeKind | null
      campaignId: string | null
      createdAt: string
    },
  ) {
    const inserted = await tx
      .insertInto('reward_event')
      .values({
        id: event.id,
        type: event.type,
        actorDid: event.actorDid,
        data: JSON.stringify(event),
        createdAt: event.createdAt,
      })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst()
    if (!Number(inserted.numInsertedOrUpdatedRows)) return

    const at = now()
    const rules = (
      await tx
        .selectFrom('reward_rule')
        .selectAll()
        .where('event', '=', event.type)
        .where('enabled', '=', 1)
        .execute()
    ).map(toRule)

    const beneficiaries: Record<Beneficiary, string | null> = {
      actor: event.actorDid,
      referrer: event.referrerDid,
      referrer2: event.referrer2Did,
    }
    const touched = new Set<string>([event.actorDid])
    for (const rule of rules) {
      if (rule.validFrom && at < rule.validFrom) continue
      if (rule.validUntil && at >= rule.validUntil) continue
      if (
        rule.codeKinds.length &&
        (!event.codeKind || !rule.codeKinds.includes(event.codeKind))
      ) {
        continue
      }
      if (rule.campaignId && rule.campaignId !== event.campaignId) continue
      const did = beneficiaries[rule.beneficiary]
      if (!did) continue
      // The other side of a referral, for kyc:related
      const relatedDid =
        rule.beneficiary === 'actor' ? event.referrerDid : event.actorDid
      if (!(await this.withinCaps(tx, rule, did))) continue
      await tx
        .insertInto('points_entry')
        .values({
          id: newId(),
          did,
          amount: rule.amount,
          status: 'pending',
          ruleId: rule.id,
          ruleVersion: rule.version,
          eventId: event.id,
          relatedDid,
          vesting: JSON.stringify(rule.vesting),
          note: null,
          idempotencyKey: `${event.id}:${rule.id}`,
          createdAt: at,
          decidedAt: null,
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
      touched.add(did)
    }
    await this.settle(tx, [...touched])
  }

  private async withinCaps(tx: Db, rule: Rule, did: string) {
    if (rule.capPerBeneficiary !== null) {
      const row = await tx
        .selectFrom('points_entry')
        .select((eb) => eb.fn.sum<number>('amount').as('total'))
        .where('did', '=', did)
        .where('ruleId', '=', rule.id)
        .where('status', '!=', 'void')
        .executeTakeFirst()
      if (Number(row?.total ?? 0) + rule.amount > rule.capPerBeneficiary) {
        return false
      }
    }
    if (rule.capPerDay !== null) {
      const startOfDay = new Date().toISOString().slice(0, 10)
      const row = await tx
        .selectFrom('points_entry')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('did', '=', did)
        .where('ruleId', '=', rule.id)
        .where('status', '!=', 'void')
        .where('createdAt', '>=', startOfDay)
        .executeTakeFirst()
      if (Number(row?.count ?? 0) >= rule.capPerDay) return false
    }
    return true
  }

  private async kycApproved(tx: Db, dids: string[]) {
    if (!dids.length) return new Set<string>()
    const rows = await tx
      .selectFrom('kyc_record')
      .select('did')
      .where('did', 'in', dids)
      .where('status', '=', 'approved')
      .execute()
    return new Set(rows.map((r) => r.did))
  }

  /** The vesting conditions of an entry that are not met yet */
  waitingFor(
    entry: Pick<PointsEntryTable, 'did' | 'relatedDid' | 'vesting'>,
    approved: Set<string>,
  ): Vesting[] {
    return parseList<Vesting>(entry.vesting).filter((condition) => {
      if (condition === 'kyc:self') return !approved.has(entry.did)
      if (condition === 'kyc:related') {
        return !!entry.relatedDid && !approved.has(entry.relatedDid)
      }
      return true
    })
  }

  /** Approves the pending entries of or about these accounts that now vest */
  async settle(tx: Db, dids: string[]) {
    if (!dids.length) return
    const pending = await tx
      .selectFrom('points_entry')
      .selectAll()
      .where('status', '=', 'pending')
      .where((eb) =>
        eb.or([eb('did', 'in', dids), eb('relatedDid', 'in', dids)]),
      )
      .execute()
    if (!pending.length) return
    const approved = await this.kycApproved(tx, [
      ...new Set(
        pending.flatMap((e) =>
          e.relatedDid ? [e.did, e.relatedDid] : [e.did],
        ),
      ),
    ])
    const vested = pending
      .filter((e) => this.waitingFor(e, approved).length === 0)
      .map((e) => e.id)
    if (!vested.length) return
    await tx
      .updateTable('points_entry')
      .set({ status: 'approved', decidedAt: now() })
      .where('id', 'in', vested)
      .where('status', '=', 'pending')
      .execute()
  }

  async balance(did: string) {
    const rows = await this.db
      .selectFrom('points_entry')
      .select(['status', (eb) => eb.fn.sum<number>('amount').as('total')])
      .where('did', '=', did)
      .groupBy('status')
      .execute()
    const total = (status: EntryStatus) =>
      Number(rows.find((r) => r.status === status)?.total ?? 0)
    return { pending: total('pending'), approved: total('approved') }
  }

  async listEntries(did: string, limit: number, cursor?: string) {
    let query = this.db
      .selectFrom('points_entry')
      .selectAll()
      .where('did', '=', did)
      .orderBy('id', 'desc')
      .limit(limit)
    if (cursor) query = query.where('id', '<', cursor)
    const rows = await query.execute()
    const approved = await this.kycApproved(this.db, [
      did,
      ...rows.flatMap((r) => (r.relatedDid ? [r.relatedDid] : [])),
    ])
    const entries: EntryView[] = rows.map((r) => ({
      ...r,
      waitingFor: r.status === 'pending' ? this.waitingFor(r, approved) : [],
    }))
    return {
      entries,
      cursor: rows.length === limit ? rows[rows.length - 1].id : undefined,
    }
  }

  async adjustPoints(admin: string, did: string, amount: number, note: string) {
    return this.db.transaction().execute(async (tx) => {
      const id = newId()
      const entry: PointsEntryTable = {
        id,
        did,
        amount,
        status: 'approved',
        ruleId: null,
        ruleVersion: null,
        eventId: null,
        relatedDid: null,
        vesting: '[]',
        note,
        idempotencyKey: `adjust:${id}`,
        createdAt: now(),
        decidedAt: now(),
      }
      await tx.insertInto('points_entry').values(entry).execute()
      await this.audit(tx, admin, 'points.adjust', did, { amount, note, id })
      return { ...entry, waitingFor: [] as Vesting[] }
    })
  }

  /**
   * Takes back an account's points: its pending entries are voided, its
   * approved ones reversed. So are the points others got through it: those
   * pending on it (eg its referrer's), and those its sign-up or KYC gave
   * (eg its referrer's, once approved).
   */
  async revokePoints(actor: string, did: string, note: string, tx?: Db) {
    const run = async (tx: Db) => {
      const at = now()
      const voided = await tx
        .updateTable('points_entry')
        .set({ status: 'void', decidedAt: at, note })
        .where('status', '=', 'pending')
        .where((eb) => eb.or([eb('did', '=', did), eb('relatedDid', '=', did)]))
        .executeTakeFirst()
      const approved = await tx
        .selectFrom('points_entry')
        .selectAll()
        .where('status', '=', 'approved')
        .where('amount', '>', 0)
        .where((eb) =>
          eb.or([
            eb('did', '=', did),
            eb('eventId', 'in', [
              `account.created:${did}`,
              `kyc.approved:${did}`,
            ]),
          ]),
        )
        .execute()
      let reversed = 0
      for (const entry of approved) {
        const result = await tx
          .insertInto('points_entry')
          .values({
            id: newId(),
            did: entry.did,
            amount: -entry.amount,
            status: 'approved',
            ruleId: entry.ruleId,
            ruleVersion: entry.ruleVersion,
            eventId: entry.eventId,
            relatedDid: entry.relatedDid,
            vesting: '[]',
            note,
            idempotencyKey: `revoke:${entry.id}`,
            createdAt: at,
            decidedAt: at,
          })
          .onConflict((oc) => oc.doNothing())
          .executeTakeFirst()
        reversed += Number(result.numInsertedOrUpdatedRows ?? 0)
      }
      const counts = {
        voided: Number(voided.numUpdatedRows ?? 0),
        reversed,
      }
      await this.audit(tx, actor, 'points.revoke', did, { note, ...counts })
      return counts
    }
    return tx ? run(tx) : this.db.transaction().execute(run)
  }

  // KYC
  // ---

  async kycRecord(did: string, db: Db = this.db) {
    return db
      .selectFrom('kyc_record')
      .selectAll()
      .where('did', '=', did)
      .executeTakeFirst()
  }

  /**
   * Applies a KYC outcome. Approval may vest points; a final rejection
   * voids the pending points that depended on this account.
   */
  async setKycStatus(
    actor: string,
    did: string,
    update: {
      status: KycStatus
      provider: string
      providerRef?: string | null
      rejectReason?: string | null
      /** The provider found the same person on another account */
      duplicate?: boolean
    },
    tx?: Db,
  ) {
    const run = async (tx: Db) => {
      const old = await this.kycRecord(did, tx)
      /*
       * A provider's approval or final rejection stands: later provider
       * events (resets, replays) do not change it, except finding a
       * duplicate. Admins may override either (manual review).
       */
      const manual = update.provider === 'manual'
      if (
        !manual &&
        old?.status === 'approved' &&
        update.status !== 'approved' &&
        !update.duplicate
      ) {
        return
      }
      if (!manual && old?.status === 'rejected') return
      const row = {
        did,
        status: update.status,
        provider: update.provider,
        providerRef: update.providerRef ?? old?.providerRef ?? null,
        rejectReason: update.rejectReason ?? null,
        updatedAt: now(),
      }
      await tx
        .insertInto('kyc_record')
        .values(row)
        .onConflict((oc) => oc.column('did').doUpdateSet(row))
        .execute()
      await this.audit(tx, actor, 'kyc.status', did, {
        from: old?.status ?? 'none',
        to: update.status,
        provider: update.provider,
        reason: update.rejectReason ?? undefined,
        duplicate: update.duplicate || undefined,
      })
      if (update.status === 'approved') {
        const referral = await tx
          .selectFrom('referral')
          .selectAll()
          .where('did', '=', did)
          .executeTakeFirst()
        await this.handleEvent(tx, {
          id: `kyc.approved:${did}`,
          type: 'kyc.approved',
          actorDid: did,
          referrerDid: referral?.referrerDid ?? null,
          referrer2Did: referral?.referrer2Did ?? null,
          codeKind: referral?.codeKind ?? null,
          campaignId: referral?.campaignId ?? null,
          createdAt: now(),
        })
        await this.settle(tx, [did])
      } else if (update.status === 'rejected') {
        await this.revokePoints(
          actor,
          did,
          update.duplicate
            ? 'Identity verification found a duplicate account'
            : 'Identity verification was rejected',
          tx,
        )
      }
    }
    return tx ? run(tx) : this.db.transaction().execute(run)
  }
}

export class RewardsError extends Error {
  constructor(
    public error: string,
    message: string,
  ) {
    super(message)
  }
}
