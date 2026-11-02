'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHttpServer } = require('../lib/http-server')

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close (server) {
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
}

test('HTTP health remains 200 throughout the one-hour resting phase', async () => {
  let phase = 'active'
  let connected = true
  const server = createHttpServer({ getStatus: () => ({ phase, cycle: 1, connected, remainingActiveMs: 60000 }) })
  const base = await listen(server)
  try {
    assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok' })
    phase = 'resting'
    connected = false
    assert.equal((await fetch(base + '/health')).status, 200)
    assert.equal((await fetch(base + '/ping')).status, 200)
    const status = await (await fetch(base + '/status')).json()
    assert.equal(status.phase, 'resting')
    assert.equal(status.connected, false)
    assert.equal(status.cycle, 1)
    assert.equal(status.service, 'minecraft-java-bot')
    assert.equal(typeof status.uptimeSeconds, 'number')
  } finally { await close(server) }
})

test('HTTP API only supports read methods and known endpoints', async () => {
  const server = createHttpServer({ getStatus: () => ({ phase: 'idle', cycle: 1, connected: false, remainingActiveMs: 7200000 }) })
  const base = await listen(server)
  try {
    const head = await fetch(base + '/health', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    const post = await fetch(base + '/health', { method: 'POST' })
    assert.equal(post.status, 405)
    const missing = await fetch(base + '/nope')
    assert.equal(missing.status, 404)
  } finally { await close(server) }
})

test('configuration validates optional Render PORT', () => {
  const { loadConfig } = require('../lib/config')
  assert.equal(loadConfig({}).httpPort, 10000)
  assert.equal(loadConfig({ PORT: '9200' }).httpPort, 9200)
  assert.throws(() => loadConfig({ PORT: 'not-a-port' }), /PORT/)
})
