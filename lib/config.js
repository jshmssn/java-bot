'use strict'

const path = require('node:path')

function booleanValue (name, fallback, env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (/^(true|1|yes)$/i.test(raw)) return true
  if (/^(false|0|no)$/i.test(raw)) return false
  throw new Error(`${name} must be true or false`)
}

function integerValue (name, fallback, min, max, env) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return value
}

function loadConfig (env = process.env, projectDir = process.cwd()) {
  const host = (env.MC_HOST || 'localhost').trim()
  const username = (env.MC_USERNAME || 'JavaBot').trim()
  const auth = (env.MC_AUTH || 'offline').trim().toLowerCase()
  const engine = (env.MC_ENGINE || 'official').trim().toLowerCase()
  const rawVersion = (env.MC_VERSION || 'auto').trim()
  const version = rawVersion.toLowerCase() === 'auto' ? false : rawVersion
  const chatTrigger = (env.CHAT_TRIGGER || 'hello bot').trim()

  if (!host || /[:/\\\s]/.test(host)) throw new Error('MC_HOST must be a hostname or IP without http:// or a port')
  if (!username) throw new Error('MC_USERNAME cannot be empty')
  if (!['offline', 'microsoft'].includes(auth)) throw new Error('MC_AUTH must be offline or microsoft')
  if (!['official', 'community'].includes(engine)) throw new Error('MC_ENGINE must be official or community')
  if (!version && rawVersion.toLowerCase() !== 'auto') throw new Error('MC_VERSION cannot be empty')
  if (!chatTrigger) throw new Error('CHAT_TRIGGER cannot be empty')

  const config = {
    host,
    httpPort: integerValue('PORT', 10000, 1, 65535, env),
    port: integerValue('MC_PORT', 25565, 1, 65535, env),
    username,
    version,
    auth,
    engine,
    authCacheDir: path.resolve(projectDir, env.MC_AUTH_CACHE_DIR || './auth-cache'),
    activeDurationMs: integerValue('ACTIVE_DURATION_MS', 7200000, 1000, 604800000, env),
    restDurationMs: integerValue('REST_DURATION_MS', 3600000, 1000, 604800000, env),
    reconnectDelayMs: integerValue('RECONNECT_DELAY_MS', 60000, 1000, 3600000, env),
    joinTimeoutMs: integerValue('JOIN_TIMEOUT_MS', 120000, 0, 3600000, env),
    afkEnabled: booleanValue('AFK_ENABLED', true, env),
    afkIntervalMs: integerValue('AFK_INTERVAL_MS', 300000, 10000, 3600000, env),
    afkSneakDurationMs: integerValue('AFK_SNEAK_DURATION_MS', 1000, 100, 60000, env),
    chatEnabled: booleanValue('CHAT_ENABLED', true, env),
    chatTrigger,
    chatReply: env.CHAT_REPLY || 'Hello, {player}! I am a Java Edition bot.',
    chatCooldownMs: integerValue('CHAT_COOLDOWN_MS', 15000, 0, 3600000, env)
  }

  if (config.afkSneakDurationMs >= config.afkIntervalMs) {
    throw new Error('AFK_SNEAK_DURATION_MS must be shorter than AFK_INTERVAL_MS')
  }

  return config
}

module.exports = { loadConfig }
