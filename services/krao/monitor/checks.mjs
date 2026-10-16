/*
 * Krao monitor: what to check, how to read each answer, and when a change
 * is worth an alert. No I/O here (see monitor.mjs), so it is unit tested.
 */

/** Why some services matter more, said in their alerts */
const IMPACT = {
  rewards:
    'sign-ups (referral codes), phone verification and so posting and chat fail closed',
  pds: 'nobody can sign in, post or sign up',
  appview: 'feeds, profiles and notifications do not load',
  indexer: 'wallets, tips, gates and Krao feeds stop updating',
  chat: 'direct messages are down',
  video: 'video uploads and playback fail',
  push: 'push notifications stop',
  ozone: 'reports and moderation are down',
}

/**
 * The health endpoints of the production compose services. `KRAO_MONITOR_
 * TARGETS` (name=url, comma-separated) replaces the list.
 */
export const DEFAULT_TARGETS = {
  pds: 'http://pds:3000/xrpc/_health',
  appview: 'http://appview:2584/xrpc/_health',
  ozone: 'http://ozone:3000/xrpc/_health',
  bsync: 'http://bsync:2585/_health',
  indexer: 'http://indexer:2589/_health',
  chat: 'http://chat:2590/_health',
  video: 'http://video:2591/_health',
  rewards: 'http://rewards:2592/_health',
  push: 'http://push:2593/_health',
}

export function parseTargets(text) {
  if (!text?.trim()) return { ...DEFAULT_TARGETS }
  const targets = {}
  for (const entry of text.split(',')) {
    const i = entry.indexOf('=')
    if (i <= 0) throw new Error(`Bad KRAO_MONITOR_TARGETS entry: ${entry}`)
    targets[entry.slice(0, i).trim()] = entry.slice(i + 1).trim()
  }
  return targets
}

/**
 * Reads one health answer: `res` is `{ status, body }`, or `{ error }` when
 * the service did not answer. Returns one result for the service, and for
 * the indexer also its firehose freshness and failed events.
 */
export function readHealth(name, res, limits = {}) {
  const impact = IMPACT[name] ? ` (${IMPACT[name]})` : ''
  if (res.error) {
    return [{ name, ok: false, detail: `no answer: ${res.error}${impact}` }]
  }
  const body = res.body && typeof res.body === 'object' ? res.body : {}
  if (res.status !== 200 || body.ok === false) {
    const why = body.error ?? body.message ?? ''
    return [
      {
        name,
        ok: false,
        detail: `HTTP ${res.status}${why ? ` ${why}` : ''}${impact}`,
      },
    ]
  }
  const results = [{ name, ok: true, detail: 'ok' }]
  if (name === 'indexer') {
    const maxAge = limits.firehoseMaxAgeSec ?? 6 * 3600
    const age = body.lastEventAgoSec
    results.push({
      name: 'indexer-firehose',
      ok: age === null || age === undefined || age <= maxAge,
      detail:
        typeof age === 'number'
          ? `last firehose event ${formatDuration(age * 1000)} ago` +
            (age > maxAge
              ? ' (the indexer may be stuck; a quiet network looks the same)'
              : '')
          : 'no firehose event yet',
    })
    const maxFailed = limits.maxFailedEvents ?? 0
    const failed = Number(body.failedEvents ?? 0)
    results.push({
      name: 'indexer-failed-events',
      ok: failed <= maxFailed,
      detail:
        `${failed} failed firehose event(s)` +
        (failed > maxFailed
          ? ', replay with net.krao.indexer.admin.replayFailedEvents'
          : ''),
    })
  }
  return results
}

/** Disk use of one mount: `{ path, total, free }` in bytes */
export function readDisk(disk, maxPercent = 85) {
  const used = disk.total ? ((disk.total - disk.free) / disk.total) * 100 : 0
  return {
    name: `disk:${disk.path}`,
    ok: used <= maxPercent,
    detail: `${used.toFixed(0)}% used, ${formatBytes(disk.free)} free`,
  }
}

/** Age of the newest backup archive (`newestMs`: its mtime, or null) */
export function readBackup(newestMs, now, maxAgeHours = 48) {
  if (newestMs === null) {
    return { name: 'backup', ok: false, detail: 'no backup archive found' }
  }
  const age = now - newestMs
  return {
    name: 'backup',
    ok: age <= maxAgeHours * 3600_000,
    detail: `newest backup ${formatDuration(age)} old`,
  }
}

/**
 * Turns check results into alerts, once per change: a check goes down
 * after `failAfter` failed rounds in a row (one slow answer is not an
 * outage), comes back up on its first good round, and while down is
 * reminded every `repeatMs`. Checks never seen failing raise nothing.
 */
export class AlertTracker {
  constructor({ failAfter = 2, repeatMs = 6 * 3600_000 } = {}) {
    this.failAfter = failAfter
    this.repeatMs = repeatMs
    /** name -> { down, failures, since, lastAlertAt, detail, checkedAt } */
    this.state = new Map()
  }

  /** Records one round; returns the alerts it raises */
  update(results, now = Date.now()) {
    const events = []
    for (const r of results) {
      let s = this.state.get(r.name)
      if (!s) {
        s = { down: false, failures: 0, since: now, lastAlertAt: 0 }
        this.state.set(r.name, s)
      }
      s.detail = r.detail
      s.checkedAt = now
      if (r.ok) {
        if (s.down) {
          events.push({
            name: r.name,
            status: 'up',
            detail: r.detail,
            downForMs: now - s.since,
          })
          s.down = false
          s.since = now
        } else if (s.failures) {
          s.since = now
        }
        s.failures = 0
        continue
      }
      s.failures++
      if (!s.down && s.failures >= this.failAfter) {
        s.down = true
        s.since = now
        s.lastAlertAt = now
        events.push({ name: r.name, status: 'down', detail: r.detail })
      } else if (s.down && now - s.lastAlertAt >= this.repeatMs) {
        s.lastAlertAt = now
        events.push({
          name: r.name,
          status: 'still-down',
          detail: r.detail,
          downForMs: now - s.since,
        })
      }
    }
    return events
  }

  /** The /status answer */
  snapshot(now = Date.now()) {
    const checks = {}
    let ok = true
    for (const [name, s] of [...this.state].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (s.down) ok = false
      checks[name] = {
        ok: !s.down,
        failing: s.failures > 0,
        since: new Date(s.since).toISOString(),
        detail: s.detail,
        checkedAt: new Date(s.checkedAt).toISOString(),
      }
    }
    return { ok, at: new Date(now).toISOString(), checks }
  }
}

/** One alert message for the events of a round */
export function formatAlert(events, domain) {
  const lines = events.map((e) => {
    if (e.status === 'down') return `DOWN ${e.name}: ${e.detail}`
    if (e.status === 'up') {
      return `RECOVERED ${e.name} after ${formatDuration(e.downForMs)}`
    }
    return `STILL DOWN ${e.name} for ${formatDuration(e.downForMs)}: ${e.detail}`
  })
  return `[${domain}] Krao monitor\n${lines.join('\n')}`
}

/** The webhook request for an alert: generic JSON or a Telegram message */
export function alertRequest(events, cfg) {
  const text = formatAlert(events, cfg.domain)
  if (cfg.format === 'telegram') {
    return {
      url: cfg.webhookUrl,
      body: {
        chat_id: cfg.telegramChatId,
        text,
        disable_web_page_preview: true,
      },
    }
  }
  return {
    url: cfg.webhookUrl,
    body: {
      source: 'krao-monitor',
      domain: cfg.domain,
      text,
      events: events.map((e) => ({
        check: e.name,
        status: e.status,
        detail: e.detail,
        ...(e.downForMs !== undefined
          ? { downForSec: e.downForMs / 1000 }
          : {}),
      })),
    },
  }
}

export function formatDuration(ms) {
  const sec = Math.round(ms / 1000)
  if (sec < 120) return `${sec}s`
  if (sec < 7200) return `${Math.round(sec / 60)} min`
  if (sec < 172800) return `${Math.round(sec / 3600)} h`
  return `${Math.round(sec / 86400)} days`
}

function formatBytes(n) {
  const gb = n / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`
}
