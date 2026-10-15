import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb, migrateDb } from './db.js'

const applied = async (db: ReturnType<typeof createDb>) =>
  (
    await sql<{
      name: string
    }>`select name from krao_migration order by name`.execute(db)
  ).rows.map((r) => r.name)

describe('migrateDb', () => {
  it('records each migration once', async () => {
    const db = createDb(':memory:')
    await migrateDb(db)
    await migrateDb(db)
    expect(await applied(db)).toEqual([
      '001-initial',
      '002-gated-media-store',
      '003-gate-access-log',
    ])
    await db.destroy()
  })

  it('upgrades a database made before versioning', async () => {
    const db = createDb(':memory:')
    // The wallet table as the first release made it
    await sql`create table wallet (uri varchar primary key, did varchar not null, account varchar not null, accountRaw varchar not null, label varchar, status varchar not null, reason varchar, createdAt varchar not null, indexedAt varchar not null)`.execute(
      db,
    )
    await sql`insert into wallet values ('at://did:example:a/net.krao.wallet/1', 'did:example:a', 'eip155:8453:0xabc', '0xAbC', null, 'verified', null, 'x', 'x')`.execute(
      db,
    )
    await migrateDb(db)
    const row = await db
      .selectFrom('wallet')
      .select('evmAddress')
      .executeTakeFirstOrThrow()
    expect(row.evmAddress).toBe('0xabc')
    expect(await applied(db)).toEqual([
      '001-initial',
      '002-gated-media-store',
      '003-gate-access-log',
    ])
    await db.destroy()
  })
})
