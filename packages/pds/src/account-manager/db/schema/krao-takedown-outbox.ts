import type { Generated } from 'kysely'

/** An account takedown or its lifting, until the Krao rewards service has it */
export interface KraoTakedownOutbox {
  id: Generated<number>
  did: string
  /** 1: taken down, 0: lifted */
  applied: 0 | 1
  createdAt: string
  attempts: number
  lastError: string | null
  deliveredAt: string | null
  /** Set when the rewards service rejected the row for good */
  failedAt: string | null
}

export const tableName = 'krao_takedown_outbox'

export type PartialDB = { [tableName]: KraoTakedownOutbox }
