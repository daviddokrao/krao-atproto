// node --test services/krao/monitor/monitor.test.mjs
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { describe, it } from 'node:test'
import {
  AlertTracker,
  alertRequest,
  parseTargets,
  readBackup,
  readDisk,
  readHealth,
} from './checks.mjs'
import { startMonitor } from './monitor.mjs'

const MIN = 60_000

describe('AlertTracker', () => {
  it('alerts once when a check goes down, and once when it recovers', () => {
    const t = new AlertTracker({ failAfter: 2, repeatMs: 60 * MIN })
    const down = { name: 'rewards', ok: false, detail: 'HTTP 502' }
    const up = { name: 'rewards', ok: true, detail: 'ok' }
    assert.deepEqual(t.update([up], 0), [])
    // One failed round is not an outage
    assert.deepEqual(t.update([down], 1 * MIN), [])
    assert.deepEqual(t.update([down], 2 * MIN), [
      { name: 'rewards', status: 'down', detail: 'HTTP 502' },
    ])
    // Deduplicated while it stays down
    assert.deepEqual(t.update([down], 3 * MIN), [])
    assert.deepEqual(t.update([down], 30 * MIN), [])
    assert.equal(t.snapshot(30 * MIN).ok, false)
    assert.deepEqual(t.update([up], 32 * MIN), [
      { name: 'rewards', status: 'up', detail: 'ok', downForMs: 30 * MIN },
    ])
    assert.deepEqual(t.update([up], 33 * MIN), [])
    assert.equal(t.snapshot(33 * MIN).ok, true)
  })

  it('does not alert for a check that fails once between good rounds', () => {
    const t = new AlertTracker({ failAfter: 2 })
    const r = (ok) => [{ name: 'chat', ok, detail: ok ? 'ok' : 'timeout' }]
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(t.update(r(i % 2 === 0), i * MIN), [])
    }
  })

  it('reminds while a check stays down', () => {
    const t = new AlertTracker({ failAfter: 1, repeatMs: 60 * MIN })
    const down = [{ name: 'disk:/volumes/pds', ok: false, detail: '91% used' }]
    assert.equal(t.update(down, 0)[0].status, 'down')
    assert.deepEqual(t.update(down, 59 * MIN), [])
    const [reminder] = t.update(down, 60 * MIN)
    assert.equal(reminder.status, 'still-down')
    assert.equal(reminder.downForMs, 60 * MIN)
    assert.deepEqual(t.update(down, 61 * MIN), [])
  })

  it('tracks checks independently', () => {
    const t = new AlertTracker({ failAfter: 1 })
    const events = t.update([
      { name: 'pds', ok: true, detail: 'ok' },
      { name: 'push', ok: false, detail: 'no answer' },
    ])
    assert.deepEqual(
      events.map((e) => [e.name, e.status]),
      [['push', 'down']],
    )
  })
})

describe('reading health answers', () => {
  it('reads services that are down or failing', () => {
    assert.deepEqual(readHealth('pds', { status: 200, body: {} }), [
      { name: 'pds', ok: true, detail: 'ok' },
    ])
    const [refused] = readHealth('rewards', { error: 'ECONNREFUSED' })
    assert.equal(refused.ok, false)
    assert.match(refused.detail, /ECONNREFUSED.*sign-ups/)
    const [db] = readHealth('chat', {
      status: 503,
      body: { ok: false, error: 'Database' },
    })
    assert.equal(db.ok, false)
    assert.match(db.detail, /HTTP 503 Database/)
  })

  it('reads the indexer firehose freshness and failed events', () => {
    const [main, firehose, failed] = readHealth(
      'indexer',
      {
        status: 200,
        body: { ok: true, lastEventAgoSec: 7200, failedEvents: 3 },
      },
      { firehoseMaxAgeSec: 3600, maxFailedEvents: 0 },
    )
    assert.equal(main.ok, true)
    assert.equal(firehose.name, 'indexer-firehose')
    assert.equal(firehose.ok, false)
    assert.equal(failed.ok, false)
    assert.match(failed.detail, /3 failed.*replayFailedEvents/)
    const fresh = readHealth('indexer', {
      status: 200,
      body: { ok: true, lastEventAgoSec: null, failedEvents: 0 },
    })
    assert.ok(fresh.every((r) => r.ok))
  })

  it('reads the PLC mirror lag and refused operations', () => {
    const [main, lag, rejected] = readHealth(
      'plc-mirror',
      {
        status: 200,
        body: {
          ok: true,
          lagSeconds: 1200,
          rejected: 2,
          lastError: 'HTTP 429',
        },
      },
      { plcMirrorMaxLagSec: 600 },
    )
    assert.equal(main.ok, true)
    assert.equal(lag.name, 'plc-mirror-lag')
    assert.equal(lag.ok, false)
    assert.match(lag.detail, /behind.*HTTP 429/)
    assert.equal(rejected.ok, false)
    const syncing = readHealth('plc-mirror', {
      status: 200,
      body: { ok: true, lagSeconds: null, rejected: 0, ops: 42 },
    })
    assert.ok(syncing.every((r) => r.ok))
    assert.match(syncing[1].detail, /first sync running \(42/)
    assert.match(
      readHealth('plc-mirror', { error: 'ECONNREFUSED' })[0].detail,
      /DIDs do not resolve/,
    )
  })

  it('reads disks and backups', () => {
    assert.equal(
      readDisk({ path: '/volumes/pds', total: 100, free: 10 }, 85).ok,
      false,
    )
    assert.equal(
      readDisk({ path: '/volumes/pds', total: 100, free: 50 }, 85).ok,
      true,
    )
    const now = Date.now()
    assert.equal(readBackup(null, now).ok, false)
    assert.equal(readBackup(now - 49 * 3600_000, now, 48).ok, false)
    assert.equal(readBackup(now - 2 * 3600_000, now, 48).ok, true)
  })

  it('parses targets', () => {
    assert.equal(parseTargets('').rewards, 'http://rewards:2592/_health')
    assert.deepEqual(parseTargets('a=http://x/_health, b=http://y'), {
      a: 'http://x/_health',
      b: 'http://y',
    })
  })
})

describe('alert formats', () => {
  const events = [{ name: 'rewards', status: 'down', detail: 'HTTP 502' }]

  it('sends generic JSON', () => {
    const req = alertRequest(events, {
      webhookUrl: 'https://hooks.example/x',
      format: 'json',
      domain: 'krao.net',
    })
    assert.equal(req.url, 'https://hooks.example/x')
    assert.equal(req.body.source, 'krao-monitor')
    assert.deepEqual(req.body.events, [
      { check: 'rewards', status: 'down', detail: 'HTTP 502' },
    ])
    assert.match(req.body.text, /^\[krao\.net\] Krao monitor\nDOWN rewards/)
  })

  it('sends Telegram messages', () => {
    const req = alertRequest(events, {
      webhookUrl: 'https://api.telegram.org/botTOKEN/sendMessage',
      format: 'telegram',
      telegramChatId: '-100123',
      domain: 'krao.net',
    })
    assert.equal(req.body.chat_id, '-100123')
    assert.match(req.body.text, /DOWN rewards: HTTP 502/)
  })
})

describe('monitor', () => {
  it('alerts when a service stops, and when it is back', async () => {
    const listen = async (handler) => {
      const server = http.createServer(handler).listen(0)
      await once(server, 'listening')
      return server
    }
    const healthy = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    const pds = await listen(healthy)
    let rewards = await listen(healthy)
    const rewardsPort = rewards.address().port
    const alerts = []
    const hook = await listen((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        alerts.push(JSON.parse(body))
        res.end('{}')
      })
    })
    const mon = startMonitor({
      domain: 'krao.test',
      port: 0,
      intervalMs: 50,
      targets: {
        pds: `http://127.0.0.1:${pds.address().port}/_health`,
        rewards: `http://127.0.0.1:${rewardsPort}/_health`,
      },
      failAfter: 2,
      diskPaths: [],
      backupDir: null,
      limits: {},
      alert: {
        webhookUrl: `http://127.0.0.1:${hook.address().port}/`,
        format: 'json',
        domain: 'krao.test',
      },
      repeatMs: Infinity,
    })
    const waitFor = async (cond) => {
      for (let i = 0; i < 100 && !cond(); i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(cond())
    }
    try {
      await waitFor(() => mon.tracker.state.get('rewards')?.checkedAt)
      assert.equal(alerts.length, 0)

      rewards.close()
      rewards.closeAllConnections()
      await waitFor(() => alerts.length === 1)
      assert.deepEqual(
        alerts[0].events.map((e) => [e.check, e.status]),
        [['rewards', 'down']],
      )
      const status = await fetch(
        `http://127.0.0.1:${mon.server.address().port}/status`,
      ).then((r) => r.json())
      assert.equal(status.ok, false)
      assert.equal(status.checks.rewards.ok, false)
      assert.equal(status.checks.pds.ok, true)

      rewards = await new Promise((resolve) => {
        const s = http
          .createServer(healthy)
          .listen(rewardsPort, () => resolve(s))
      })
      await waitFor(() => alerts.length === 2)
      assert.equal(alerts[1].events[0].status, 'up')
      // Nothing more while all is well
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(alerts.length, 2)
    } finally {
      mon.stop()
      for (const s of [pds, rewards, hook]) {
        s.close()
        s.closeAllConnections()
      }
    }
  })
})
