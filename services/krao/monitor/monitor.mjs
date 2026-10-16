#!/usr/bin/env node
/*
 * Krao monitor: polls every service's health endpoint, the indexer's
 * firehose freshness and failed events, disk use of the data volumes and the
 * age of the newest backup. Alerts go to a webhook when a check goes down or
 * recovers (once per change, reminders while down); GET /status answers with
 * every check as JSON.
 *
 *   node services/krao/monitor/monitor.mjs
 *
 * Env (see services/krao/README.md, "Monitoring"):
 *   KRAO_DOMAIN                    named in alerts
 *   KRAO_MONITOR_PORT              /status port (2594)
 *   KRAO_MONITOR_INTERVAL_SEC      seconds between rounds (60)
 *   KRAO_MONITOR_TARGETS           name=url,... health URLs (compose services)
 *   KRAO_MONITOR_FAIL_AFTER        failed rounds before an alert (2)
 *   KRAO_MONITOR_DISK_PATHS        mounts to watch (every dir in /volumes)
 *   KRAO_MONITOR_DISK_MAX_PERCENT  disk alert threshold (85)
 *   KRAO_MONITOR_BACKUP_DIR        backup archives (/backups; empty: off)
 *   KRAO_MONITOR_BACKUP_MAX_AGE_HOURS  (48)
 *   KRAO_MONITOR_FIREHOSE_MAX_AGE_SEC  indexer silence alert (21600)
 *   KRAO_MONITOR_MAX_FAILED_EVENTS     indexer failed events allowed (0)
 *   KRAO_ALERT_WEBHOOK_URL         where alerts go (unset: logged only)
 *   KRAO_ALERT_FORMAT              json (default) or telegram
 *   KRAO_ALERT_TELEGRAM_CHAT_ID    chat for the telegram format
 *   KRAO_ALERT_REPEAT_HOURS        reminder while down (6, 0: never)
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  AlertTracker,
  alertRequest,
  formatAlert,
  parseTargets,
  readBackup,
  readDisk,
  readHealth,
} from './checks.mjs'

const env = process.env
const num = (name, fallback) =>
  env[name] !== undefined && env[name] !== '' ? Number(env[name]) : fallback

export function configFromEnv() {
  const backupDir = env.KRAO_MONITOR_BACKUP_DIR ?? '/backups'
  return {
    domain: env.KRAO_DOMAIN || 'krao',
    port: num('KRAO_MONITOR_PORT', 2594),
    intervalMs: num('KRAO_MONITOR_INTERVAL_SEC', 60) * 1000,
    targets: parseTargets(env.KRAO_MONITOR_TARGETS),
    failAfter: num('KRAO_MONITOR_FAIL_AFTER', 2),
    diskPaths: env.KRAO_MONITOR_DISK_PATHS
      ? env.KRAO_MONITOR_DISK_PATHS.split(',').filter(Boolean)
      : volumeDirs('/volumes'),
    diskMaxPercent: num('KRAO_MONITOR_DISK_MAX_PERCENT', 85),
    backupDir: backupDir || null,
    backupMaxAgeHours: num('KRAO_MONITOR_BACKUP_MAX_AGE_HOURS', 48),
    limits: {
      firehoseMaxAgeSec: num('KRAO_MONITOR_FIREHOSE_MAX_AGE_SEC', 6 * 3600),
      maxFailedEvents: num('KRAO_MONITOR_MAX_FAILED_EVENTS', 0),
    },
    alert: {
      webhookUrl: env.KRAO_ALERT_WEBHOOK_URL || null,
      format: env.KRAO_ALERT_FORMAT === 'telegram' ? 'telegram' : 'json',
      telegramChatId: env.KRAO_ALERT_TELEGRAM_CHAT_ID,
      domain: env.KRAO_DOMAIN || 'krao',
    },
    repeatMs: num('KRAO_ALERT_REPEAT_HOURS', 6) * 3600_000 || Infinity,
  }
}

function volumeDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
  } catch {
    return []
  }
}

async function fetchHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch (err) {
    return { error: err?.cause?.code ?? err?.message ?? String(err) }
  }
}

function newestBackupMs(dir) {
  let newest = null
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^krao-backup-.*\.tar$/.test(name)) continue
      const { mtimeMs } = fs.statSync(path.join(dir, name))
      if (newest === null || mtimeMs > newest) newest = mtimeMs
    }
  } catch {
    return null
  }
  return newest
}

/** One round of every check */
export async function runChecks(cfg, now = Date.now()) {
  const results = (
    await Promise.all(
      Object.entries(cfg.targets).map(async ([name, url]) =>
        readHealth(name, await fetchHealth(url), cfg.limits),
      ),
    )
  ).flat()
  for (const p of cfg.diskPaths) {
    try {
      const s = fs.statfsSync(p)
      results.push(
        readDisk(
          { path: p, total: s.blocks * s.bsize, free: s.bavail * s.bsize },
          cfg.diskMaxPercent,
        ),
      )
    } catch (err) {
      results.push({ name: `disk:${p}`, ok: false, detail: String(err) })
    }
  }
  if (cfg.backupDir) {
    results.push(
      readBackup(newestBackupMs(cfg.backupDir), now, cfg.backupMaxAgeHours),
    )
  }
  return results
}

/** Sends an alert; false when the webhook did not take it (retried later) */
export async function sendAlert(events, alertCfg) {
  console.log(formatAlert(events, alertCfg.domain))
  if (!alertCfg.webhookUrl) return true
  const { url, body } = alertRequest(events, alertCfg)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return true
  } catch (err) {
    console.error('krao-monitor: alert not delivered', err?.message ?? err)
    return false
  }
}

/** Runs rounds forever; returns a handle to stop it (and its /status) */
export function startMonitor(cfg) {
  const tracker = new AlertTracker({
    failAfter: cfg.failAfter,
    repeatMs: cfg.repeatMs,
  })
  /** Alerts the webhook has not taken yet */
  let unsent = []
  let timer
  let stopped = false
  const round = async () => {
    const results = await runChecks(cfg)
    unsent.push(...tracker.update(results))
    if (unsent.length && (await sendAlert(unsent, cfg.alert))) unsent = []
  }
  const loop = async () => {
    try {
      await round()
    } catch (err) {
      console.error('krao-monitor: round failed', err)
    }
    if (!stopped) timer = setTimeout(loop, cfg.intervalMs)
  }
  const server = http.createServer((req, res) => {
    // 200 either way: it says whether the monitor runs, /status says the rest
    if (req.url === '/status' || req.url === '/_health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(tracker.snapshot()))
      return
    }
    res.writeHead(404).end()
  })
  server.listen(cfg.port)
  void loop()
  return {
    tracker,
    server,
    stop: () => {
      stopped = true
      clearTimeout(timer)
      server.close()
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = configFromEnv()
  startMonitor(cfg)
  console.log(
    `Krao monitor on :${cfg.port}, every ${cfg.intervalMs / 1000}s: ` +
      `${Object.keys(cfg.targets).join(', ')}; disks ${cfg.diskPaths.join(', ') || 'none'}` +
      (cfg.alert.webhookUrl
        ? ''
        : ' (no KRAO_ALERT_WEBHOOK_URL: alerts are logged)'),
  )
  const shutdown = () => process.exit(0)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
