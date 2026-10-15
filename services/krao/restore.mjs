#!/usr/bin/env node
/*
 * Restores a backup.mjs archive into empty volumes and Postgres. Run it with
 * the services stopped, in the backup container (it mounts every volume):
 *
 *   docker compose stop
 *   docker compose up -d postgres
 *   docker compose run --rm backup node services/krao/restore.mjs \
 *     /backups/krao-backup-<time>.tar
 *   docker compose up -d
 *
 * Refuses to write over a volume that already holds data, unless --force.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const VOLUMES = process.env.KRAO_BACKUP_VOLUMES || '/volumes'
const args = process.argv.slice(2)
const force = args.includes('--force')
const archive = args.find((a) => !a.startsWith('--'))
if (!archive) {
  console.error('Usage: restore.mjs <archive.tar> [--force]')
  process.exit(2)
}

const log = (...m) => console.log(new Date().toISOString(), ...m)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'krao-restore-'))
try {
  execFileSync('tar', ['-xf', archive, '-C', work])
  for (const entry of fs.readdirSync(work, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.name.endsWith('-files.tar')) continue
    const volume = entry.isDirectory()
      ? entry.name
      : entry.name.slice(0, -'-files.tar'.length)
    const dest = path.join(VOLUMES, volume)
    if (!fs.existsSync(dest)) {
      log(`skipping ${volume}: not mounted`)
      continue
    }
    if (entry.isDirectory()) {
      const existing = fs.readdirSync(dest)
      if (existing.length && !force) {
        throw new Error(`${dest} is not empty (use --force to overwrite)`)
      }
      fs.cpSync(path.join(work, entry.name), dest, { recursive: true })
      log(`${volume}: databases restored`)
    } else {
      execFileSync('tar', ['-xf', path.join(work, entry.name), '-C', dest])
      log(`${volume}: files restored`)
    }
  }
  // The services run as the image's `node` user
  execFileSync('chown', ['-R', 'node:node', VOLUMES])
  const dump = path.join(work, 'postgres.dump')
  const pgUrl = process.env.KRAO_BACKUP_POSTGRES_URL
  if (fs.existsSync(dump) && pgUrl) {
    execFileSync(
      'pg_restore',
      ['--clean', '--if-exists', '--no-owner', '--dbname', pgUrl, dump],
      { stdio: 'inherit' },
    )
    log('postgres: restored')
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
log('restore done')
