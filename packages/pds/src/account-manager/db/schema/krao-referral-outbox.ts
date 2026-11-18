/** A sign-up with a Krao referral code, until the rewards service has it */
export interface KraoReferralOutbox {
  did: string
  code: string
  createdAt: string
  attempts: number
  lastError: string | null
  deliveredAt: string | null
  /** Set when the rewards service rejected the row for good */
  failedAt: string | null
}

export const tableName = 'krao_referral_outbox'

export type PartialDB = { [tableName]: KraoReferralOutbox }
