'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const { createRunner } = require('../lib/runner')
const { loadConfig } = require('../lib/config')

const MIN = 60000
const HOUR = 60 * MIN

function fakeClock () {
  let time = 0
  let nextId = 1
  const jobs = new Map()

  function put (type, callback, duration) {
    const delay = Number(duration)
    if (!Number.isFinite(delay) || delay < 0) throw new Error(`Invalid delay: ${duration}`)
    const id = nextId++
    jobs.set(id, { type, callback, due: time + delay, delay })
    return id
  }

  return {
    now: () => time,
    jobs,
    setTimeout: (fn, ms) => put('timeout', fn, ms),
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn, ms) => put('interval', fn, ms),
    clearInterval: (id) => jobs.delete(id),
    advance (ms) {
      const until = time + ms
      let count = 0
      while (true) {
        const next = [...jobs.entries()].filter(([, job]) => job.due <= until)
          .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
        if (!next) break
        if (++count > 10000) throw new Error('Too many scheduled events')
        const [id, job] = next
        time = job.due
        if (job.type === 'timeout') jobs.delete(id)
        else if (jobs.has(id)) job.due += job.delay
        job.callback()
      }
      time = until
    },
    countType (type) { return [...jobs.values()].filter(job => job.type === type).length }
  }
}

function fakeBot (options = {}) {
  const username = typeof options === 'string' ? options : (options.username || 'JavaBot')
  const bot = new EventEmitter()
  bot.username = username
  bot.controls = []
  bot.chatMessages = []
  bot.ended = 0
  bot.setControlState = (key, value) => bot.controls.push([key, value])
  bot.chat = (message) => bot.chatMessages.push(message)
  bot.end = (reason) => { bot.ended++; bot.emit('end', reason) }
  bot.quit = (reason) => { bot.ended++; bot.emit('end', reason) }
  return bot
}

const quiet = { info () {}, warn () {}, error () {} }
const baseConfig = {
  ...loadConfig({}),
  afkEnabled: false,
  chatReply: 'Hello, {player}!'
}

function makeRunner (clock, overrides = {}, createBot = fakeBot) {
  const instances = []
  const mineflayer = {
    createBot (options) {
      const bot = createBot(options)
      instances.push(bot)
      return bot
    }
  }
  const runner = createRunner({
    mineflayer, config: { ...baseConfig, ...overrides },
    timers: clock, now: clock.now, logger: quiet
  })
  return { runner, instances }
}

test('configuration defaults to two hours online / one hour offline / one-minute retry', () => {
  const cfg = loadConfig({})
  assert.equal(cfg.activeDurationMs, 2 * HOUR)
  assert.equal(cfg.restDurationMs, HOUR)
  assert.equal(cfg.reconnectDelayMs, MIN)
  assert.equal(cfg.joinTimeoutMs, 2 * MIN)
  assert.equal(cfg.port, 25565)
  assert.equal(cfg.version, false)
  assert.throws(() => loadConfig({ ACTIVE_DURATION_MS: '-1' }), /ACTIVE_DURATION_MS/)
  assert.throws(() => loadConfig({ MC_AUTH: 'none' }), /MC_AUTH/)
  assert.throws(() => loadConfig({ RECONNECT_DELAY_MS: '0' }), /RECONNECT_DELAY_MS/)
})

test('2h connected, exactly 1h disconnected, then new cycle; repeat', () => {
  const clock = fakeClock()
  const { runner, instances } = makeRunner(clock)
  runner.start()
  assert.equal(instances.length, 1)
  instances[0].emit('spawn')
  assert.equal(runner.getStatus().connected, true)

  clock.advance(2 * HOUR - 1)
  assert.equal(instances[0].ended, 0)
  clock.advance(1)
  assert.equal(instances[0].ended, 1)
  assert.equal(runner.getStatus().phase, 'resting')

  clock.advance(HOUR - 1)
  assert.equal(instances.length, 1, 'no reconnection during the full offline hour')
  clock.advance(1)
  assert.equal(instances.length, 2)
  assert.equal(runner.getStatus().cycle, 2)
  instances[1].emit('spawn')
  clock.advance(2 * HOUR)
  assert.equal(instances[1].ended, 1)
  assert.equal(runner.getStatus().phase, 'resting')

  clock.advance(HOUR)
  assert.equal(instances.length, 3)
  assert.equal(runner.getStatus().cycle, 3)
  runner.stop()
  assert.equal(clock.jobs.size, 0)
})

test('after the offline hour, sleeping server causes one-minute retries until spawn', () => {
  const clock = fakeClock()
  const { runner, instances } = makeRunner(clock)
  runner.start()
  instances[0].emit('spawn')
  clock.advance(2 * HOUR + HOUR)
  assert.equal(instances.length, 2, 'first reconnect immediately when rest ends')
  instances[1].emit('end', 'server asleep')
  clock.advance(MIN - 1)
  assert.equal(instances.length, 2)
  clock.advance(1)
  assert.equal(instances.length, 3)
  instances[2].emit('error', Error('connection refused'))
  clock.advance(MIN)
  assert.equal(instances.length, 4)
  instances[3].emit('spawn')
  clock.advance(2 * HOUR)
  assert.equal(runner.getStatus().phase, 'resting')
  runner.stop()
})

test('only spawned/connected time counts toward two hours across accidental disconnects', () => {
  const clock = fakeClock()
  const { runner, instances } = makeRunner(clock, { joinTimeoutMs: 5 * MIN })
  runner.start()
  instances[0].emit('spawn')
  clock.advance(30 * MIN)
  instances[0].emit('end', 'network lost')
  assert.equal(runner.getStatus().remainingActiveMs, 90 * MIN)
  clock.advance(MIN)
  assert.equal(instances.length, 2)
  clock.advance(2 * MIN) // Time waiting to spawn should not count.
  instances[1].emit('spawn')
  clock.advance(90 * MIN - 1)
  assert.equal(runner.getStatus().phase, 'active')
  clock.advance(1)
  assert.equal(runner.getStatus().phase, 'resting')
  runner.stop()
})

test('join timeout and multiple terminal events produce only one retry', () => {
  const clock = fakeClock()
  const { runner, instances } = makeRunner(clock)
  runner.start()
  clock.advance(2 * MIN) // No spawn; join watchdog closes connection.
  assert.equal(instances[0].ended, 1)
  instances[0].emit('error', Error('stale'))
  instances[0].emit('end', 'stale')
  clock.advance(MIN - 1)
  assert.equal(instances.length, 1)
  clock.advance(1)
  assert.equal(instances.length, 2)
  runner.stop()
  assert.equal(clock.jobs.size, 0)
})

test('chat greeting and sneak activity still work in connected window', () => {
  const clock = fakeClock()
  const { runner, instances } = makeRunner(clock, { afkEnabled: true })
  runner.start()
  const bot = instances[0]
  bot.emit('spawn')
  bot.emit('chat', 'JavaBot', 'hello bot')
  bot.emit('chat', 'Alex', 'hello BOT')
  bot.emit('chat', 'Alex', 'hello bot')
  assert.deepEqual(bot.chatMessages, ['Hello, Alex!'])
  clock.advance(15000)
  bot.emit('chat', 'Alex', 'hello bot')
  assert.deepEqual(bot.chatMessages, ['Hello, Alex!', 'Hello, Alex!'])
  clock.advance(5 * MIN - 15000)
  assert.deepEqual(bot.controls.at(-1), ['sneak', true])
  clock.advance(1000)
  assert.deepEqual(bot.controls.at(-1), ['sneak', false])
  runner.stop()
  assert.equal(clock.jobs.size, 0)
})

test('failed client construction retries after one minute; stopping cancels retry', () => {
  const clock = fakeClock()
  let attempts = 0
  const mineflayer = { createBot () { attempts++; throw Error('server offline') } }
  const runner = createRunner({ mineflayer, config: baseConfig, timers: clock, now: clock.now, logger: quiet })
  runner.start()
  assert.equal(attempts, 1)
  clock.advance(MIN)
  assert.equal(attempts, 2)
  runner.stop()
  clock.advance(5 * HOUR)
  assert.equal(attempts, 2)
  assert.equal(clock.jobs.size, 0)
})
