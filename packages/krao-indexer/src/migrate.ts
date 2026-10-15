import { type Kysely, type Migration, Migrator } from 'kysely'

/**
 * Apply versioned schema changes. Each migration runs once, in name order,
 * and is recorded in `krao_migration`. Never edit a released migration:
 * add a new one.
 */
export async function runMigrations(
  db: Kysely<any>,
  migrations: Record<string, Migration>,
): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
    migrationTableName: 'krao_migration',
    migrationLockTableName: 'krao_migration_lock',
  })
  const { error, results } = await migrator.migrateToLatest()
  if (error) {
    const failed = results?.find((r) => r.status === 'Error')
    throw new Error(`Migration ${failed?.migrationName ?? '(setup)'} failed`, {
      cause: error,
    })
  }
}
