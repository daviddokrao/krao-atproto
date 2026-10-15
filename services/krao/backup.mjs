#!/usr/bin/env node
/*
 * Backs up Krao's data: every SQLite database (VACUUM INTO, so a live WAL
 * database gives a consistent copy), Postgres (pg_dump), and the PDS blobs
 * and video files (tar). Each copy is checked before the backup counts:
 * a broken backup is deleted and the old ones are kept.
 *
 *   node services/krao/backup.mjs            once
 *   node services/krao/backup.mjs --every 24 every 24 hours
 *
 * Env:
 *   KRAO_BACKUP_VOLUMES       directory holding the data volumes (/volumes)
 *   KRAO_BACKUP_DIR           where archives go (/backups)
 *   KRAO_BACKUP_KEEP          archives kept locally (7)
 *   KRAO_BACKUP_POSTGRES_URL  Postgres to dump (optional)
 *   KRAO_BACKUP_SKIP          comma-separated volumes to leave out, e.g. video
 *   KRAO_BACKUP_S3_BUCKET     also upload each archive here (optional;
 *                             KRAO_BACKUP_S3_REGION, KRAO_BACKUP_S3_ENDPOINT,
 *                             AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 *
 * Restore: see services/krao/README.md.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const VOLUMES = process.env.KRAO_BACKUP_VOLUMES || '/volumes'
const OUT = process.env.KRAO_BACKUP_DIR || '/backups'
const KEEP = Number(process.env.KRAO_BACKUP_KEEP || 7)
const SKIP = new Set(
  (process.env.KRAO_BACKUP_SKIP || '').split(',').filter(Boolean),
)
const SQLITE_EXT = /\.(sqlite|sqlite3|db)$/

const log = (...args) => console.log(new Date().toISOString(), ...args)

/** Every SQLite database under `dir`, by its magic header */
function findSqlite(dir) {
  const found = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile() && SQLITE_EXT.test(entry.name)) {
        const fd = fs.openSync(p, 'r')
        const head = Buffer.alloc(16)
        fs.readSync(fd, head, 0, 16, 0)
        fs.closeSync(fd)
        if (head.toString('latin1').startsWith('SQLite format 3')) found.push(p)
      }
    }
  }
  walk(dir)
  return found
}

function tables(db) {
  return db
    .prepare(`select name from sqlite_master where type = 'table' order by name`)
    .all()
    .map((r) => r.name)
}

/** Copies one live database and proves the copy is whole */
function copySqlite(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const db = new Database(src, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 10000')
    db.prepare('vacuum into ?').run(dest)
    const copy = new Database(dest, { readonly: true })
    try {
      const check = copy.pragma('integrity_check', { simple: true })
      if (check !== 'ok') throw new Error(`integrity_check: ${check}`)
      const want = tables(db)
      const got = tables(copy)
      if (want.join() !== got.join()) {
        throw new Error(`tables differ: ${want} vs ${got}`)
      }
    } finally {
      copy.close()
    }
  } finally {
    db.close()
  }
}

/** Files that are not SQLite databases (blobs, video), as one tar */
function tarOthers(volume, dest) {
  const list = []
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      // The -wal/-shm files belong to the live databases copied above
      else if (
        entry.isFile() &&
        !SQLITE_EXT.test(entry.name) &&
        !/\.(sqlite|sqlite3|db)-(wal|shm|journal)$/.test(entry.name)
      ) {
        list.push(path.relative(volume, p))
      }
    }
  }
  walk(volume)
  if (!list.length) return false
  const listFile = `${dest}.list`
  fs.writeFileSync(listFile, list.join('\n'))
  execFileSync('tar', ['-cf', dest, '-C', volume, '-T', listFile])
  fs.rmSync(listFile)
  // Reads it all back: a truncated tar fails here
  execFileSync('tar', ['-tf', dest], { stdio: 'ignore' })
  return true
}

async function upload(file) {
  const bucket = process.env.KRAO_BACKUP_S3_BUCKET
  if (!bucket) return
  const { S3Client } = await import('@aws-sdk/client-s3')
  const { Upload } = await import('@aws-sdk/lib-storage')
  const client = new S3Client({
    region: process.env.KRAO_BACKUP_S3_REGION || 'auto',
    endpoint: process.env.KRAO_BACKUP_S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.KRAO_BACKUP_S3_ENDPOINT,
  })
  await new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: `krao-backups/${path.basename(file)}`,
      Body: fs.createReadStream(file),
    },
  }).done()
  log('uploaded to S3', path.basename(file))
}

function rotate() {
  const archives = fs
    .readdirSync(OUT)
    .filter((f) => /^krao-backup-.*\.tar$/.test(f))
    .sort()
  for (const old of archives.slice(0, Math.max(0, archives.length - KEEP))) {
    fs.rmSync(path.join(OUT, old))
    log('removed old backup', old)
  }
}

export async function backupOnce() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const work = path.join(OUT, `.work-${stamp}`)
  const archive = path.join(OUT, `krao-backup-${stamp}.tar`)
  fs.mkdirSync(work, { recursive: true })
  try {
    for (const volume of fs.readdirSync(VOLUMES).sort()) {
      if (SKIP.has(volume)) continue
      const dir = path.join(VOLUMES, volume)
      if (!fs.statSync(dir).isDirectory()) continue
      const dbs = findSqlite(dir)
      for (const src of dbs) {
        copySqlite(src, path.join(work, volume, path.relative(dir, src)))
      }
      const files = tarOthers(dir, path.join(work, `${volume}-files.tar`))
      log(`${volume}: ${dbs.length} databases${files ? ', files' : ''}`)
    }
    const pgUrl = process.env.KRAO_BACKUP_POSTGRES_URL
    if (pgUrl) {
      const dump = path.join(work, 'postgres.dump')
      execFileSync('pg_dump', ['--format=custom', '--file', dump, pgUrl])
      // Lists the dump's contents: a damaged dump fails here
      execFileSync('pg_restore', ['--list', dump], { stdio: 'ignore' })
      log('postgres: dumped')
    }
    execFileSync('tar', ['-cf', archive, '-C', work, '.'])
    fs.rmSync(work, { recursive: true, force: true })
    log('backup written', archive)
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(archive, { force: true })
    throw err
  }
  await upload(archive)
  rotate()
  return archive
}

const everyIdx = process.argv.indexOf('--every')
const everyHours = everyIdx > 0 ? Number(process.argv[everyIdx + 1]) : 0

if (import.meta.url === `file://${process.argv[1]}`) {
  if (everyHours > 0) {
    for (;;) {
      try {
        await backupOnce()
      } catch (err) {
        console.error(new Date().toISOString(), 'backup failed', err)
      }
      await new Promise((r) => setTimeout(r, everyHours * 3_600_000))
    }
  } else {
    await backupOnce()
  }
}
