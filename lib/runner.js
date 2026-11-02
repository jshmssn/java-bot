
'use strict'

const { performance } = require('node:perf_hooks')

function stringifyReason (reason) {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  try { return JSON.stringify(reason) } catch { return String(reason) }
}

function formatDuration (ms) {
  const seconds = Math.ceil(ms / 1000)
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} hour(s)`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} minute(s)`
  return `${seconds} second(s)`
}

/**
 * Minecraft 26.3 movement compatibility workaround for Mineflayer 4.39.0.
 *
 * Java 26.3 servers expect a client tick-end packet between movement updates.
 * The published Mineflayer 4.39.0 does not send it. Add a `tick_end` right
 * after each movement packet, using the original raw write method so packet
 * order is maintained when the client has no extra movement buffering layer.
 *
 * On protocols older than 1.21.2, tick_end is unavailable. Detect that once,
 * warn once, and then leave those older servers' movement alone.
 *
 * IMPORTANT: Remove/disable this workaround if switching to a Mineflayer
 * release that already sends tick_end, or when using a packet buffering layer
 * that delays movement packets; such a layer must pair tick_end at flush time.
 */
function installMovementTickEndFix (bot, logger = console) {
  const client = bot && bot._client
  if (!client || typeof client.write !== 'function') {
    logger.warn('[PROTOCOL] Raw Minecraft client unavailable; movement compatibility fix was not installed.')
    return false
  }

  const originalWrite = client.write.bind(client)
  const movementPackets = new Set(['position', 'position_look', 'look', 'flying'])
  let tickEndUnavailable = false

  client.write = (name, packet, ...args) => {
    const result = originalWrite(name, packet, ...args)

    if (movementPackets.has(name) && !tickEndUnavailable) {
      try {
        originalWrite('tick_end', {})
      } catch (error) {
        tickEndUnavailable = true
        logger.warn(`[PROTOCOL] Could not send tick_end (${stringifyReason(error)}). ` +
          'This is expected for Java versions before 1.21.2; fix disabled for this connection.')
      }
    }

    return result
  }

  logger.info('[PROTOCOL] Movement compatibility fix enabled (tick_end after movement packets).')
  return true
}

/**
 * Repeating schedule:
 *  - Accumulate 2 hours of *successful in-world* connection time.
 *  - Disconnect for 1 entire hour.
 *  - Attempt to reconnect immediately, retrying every 1 minute if needed.
 *  - Repeat until the Node.js process stops.
 *
 * Only spawned/connected time counts toward the online quota. Timers from an
 * earlier connection cannot cause duplicate reconnects.
 */
function createRunner ({ mineflayer, config, logger = console, timers = globalThis, now = () => performance.now() }) {
  let phase = 'idle' // idle, active, resting, stopped
  let current = null
  let retryTimer = null
  let restTimer = null
  let remainingActiveMs = config.activeDurationMs
  let cycle = 1

  const isCurrent = (session) => phase === 'active' && current === session

  function clearTimer (timer, kind = 'timeout') {
    if (timer !== null) {
      if (kind === 'interval') timers.clearInterval(timer)
      else timers.clearTimeout(timer)
    }
    return null
  }

  function stopAfk (session) {
    session.afkTimer = clearTimer(session.afkTimer, 'interval')
    session.sneakReleaseTimer = clearTimer(session.sneakReleaseTimer)
    if (session.spawned) {
      try { session.bot.setControlState('sneak', false) } catch (_) {}
    }
  }

  function startAfk (session) {
    if (!config.afkEnabled) return

    session.afkTimer = timers.setInterval(() => {
      if (!isCurrent(session) || !session.spawned || session.sneakReleaseTimer !== null) return

      try {
        session.bot.setControlState('sneak', true)
        session.sneakReleaseTimer = timers.setTimeout(() => {
          session.sneakReleaseTimer = null
          if (!isCurrent(session) || !session.spawned) return
          try {
            session.bot.setControlState('sneak', false)
          } catch (error) {
            logger.warn(`[AFK] Could not release sneak: ${stringifyReason(error)}`)
          }
        }, config.afkSneakDurationMs)
      } catch (error) {
        logger.warn(`[AFK] Sneak failed: ${stringifyReason(error)}`)
      }
    }, config.afkIntervalMs)
  }

  // Count only time since the latest successful spawn, not retries or rest.
  function accountOnlineTime (session) {
    session.activeTimer = clearTimer(session.activeTimer)
    if (session.onlineSince === null) return

    const elapsedMs = Math.max(0, now() - session.onlineSince)
    remainingActiveMs = Math.max(0, remainingActiveMs - elapsedMs)
    session.onlineSince = null
  }

  function closeSession (session, reason) {
    if (current === session) current = null
    session.joinTimer = clearTimer(session.joinTimer)
    stopAfk(session)
    session.spawned = false

    try {
      session.bot.end(reason)
    } catch (_) {
      try { session.bot.quit(reason) } catch (_) {}
    }
  }

  function scheduleRetry (reason) {
    if (phase !== 'active' || retryTimer !== null || current !== null) return

    logger.warn(`[BOT] ${stringifyReason(reason)}. Retrying in ${formatDuration(config.reconnectDelayMs)}...`)
    retryTimer = timers.setTimeout(() => {
      retryTimer = null
      connect()
    }, config.reconnectDelayMs)
  }

  function beginRest () {
    if (phase !== 'active') return

    phase = 'resting'
    retryTimer = clearTimer(retryTimer)

    if (current) {
      const session = current
      accountOnlineTime(session)
      closeSession(session, 'Scheduled offline break')
    }

    logger.info(`[SCHEDULE] Online target reached. Staying disconnected for ${formatDuration(config.restDurationMs)}.`)
    restTimer = timers.setTimeout(() => {
      restTimer = null
      if (phase !== 'resting') return

      cycle++
      remainingActiveMs = config.activeDurationMs
      phase = 'active'
      logger.info(`[SCHEDULE] Rest over. Starting cycle ${cycle}; reconnecting now.`)
      connect()
    }, config.restDurationMs)
  }

  function onConnectionLost (session, reason) {
    if (!isCurrent(session)) return // Ignore duplicate kicked/error/end events.

    accountOnlineTime(session)
    closeSession(session, 'Connection lost')

    if (remainingActiveMs <= 0) beginRest()
    else scheduleRetry(reason)
  }

  function onOnlineQuotaTimer (session) {
    if (!isCurrent(session) || !session.spawned) return

    accountOnlineTime(session)
    if (remainingActiveMs > 0) {
      // Timers can sometimes fire a fraction of a millisecond early.
      session.onlineSince = now()
      session.activeTimer = timers.setTimeout(() => onOnlineQuotaTimer(session), Math.ceil(remainingActiveMs))
      return
    }

    beginRest()
  }

  function connect () {
    if (phase !== 'active' || current !== null) return

    logger.info(`[BOT] Connecting to ${config.host}:${config.port} as ${config.username} (${config.auth})...`)

    let bot
    try {
      bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username: config.username,
        version: config.version,
        auth: config.auth,
        profilesFolder: config.authCacheDir,
        keepAlive: true,
        logErrors: false // Log client errors once, using the handlers below.
      })
    } catch (error) {
      logger.error(`[BOT] Could not start connection: ${stringifyReason(error)}`)
      scheduleRetry('Connection setup failed')
      return
    }

    // Fix 'Invalid move player packet received' kicks on Java 26.3 servers.
    // The wrapped write belongs to this connection only; a reconnect gets a
    // new client and therefore a fresh wrapper.
    // Optional Render variable MC_TICK_END_FIX=false disables the workaround
    // when upgrading to a Mineflayer release that already sends tick_end.
    if (config.movementTickEndFix !== false &&
        String(process.env.MC_TICK_END_FIX || 'true').toLowerCase() !== 'false') {
      installMovementTickEndFix(bot, logger)
    }

    const session = {
      bot,
      spawned: false,
      onlineSince: null,
      activeTimer: null,
      joinTimer: null,
      afkTimer: null,
      sneakReleaseTimer: null,
      lastReplies: new Map()
    }
    current = session

    if (config.joinTimeoutMs > 0) {
      session.joinTimer = timers.setTimeout(() => {
        if (!isCurrent(session) || session.spawned) return
        logger.warn(`[BOT] Did not spawn within ${formatDuration(config.joinTimeoutMs)}.`)
        onConnectionLost(session, 'Join timeout')
      }, config.joinTimeoutMs)
    }

    bot.on('login', () => {
      if (isCurrent(session)) logger.info('[BOT] Logged in; waiting to spawn...')
    })

    bot.on('spawn', () => {
      if (!isCurrent(session) || session.spawned) return

      session.joinTimer = clearTimer(session.joinTimer)
      session.spawned = true
      session.onlineSince = now()
      session.activeTimer = timers.setTimeout(() => onOnlineQuotaTimer(session), Math.ceil(remainingActiveMs))
      startAfk(session)
      logger.info(`[SCHEDULE] Connected as ${bot.username || config.username}. ` +
        `${formatDuration(remainingActiveMs)} of online time remaining in cycle ${cycle}.`)
    })

    bot.on('chat', (username, message) => {
      if (!isCurrent(session)) return
      logger.info(`[CHAT] ${username}: ${message}`)
      if (!session.spawned || !config.chatEnabled || typeof message !== 'string') return
      if ((username || '').toLowerCase() === (bot.username || config.username).toLowerCase()) return
      if (!message.toLowerCase().includes(config.chatTrigger.toLowerCase())) return

      const key = (username || 'Unknown').toLowerCase()
      const lastReply = session.lastReplies.get(key)
      const currentTime = now()
      if (lastReply !== undefined && currentTime - lastReply < config.chatCooldownMs) return

      try {
        bot.chat(config.chatReply.replace(/\{player\}/g, username || 'player'))
        session.lastReplies.set(key, currentTime)
      } catch (error) {
        logger.warn(`[CHAT] Could not send reply: ${stringifyReason(error)}`)
      }
    })

    bot.on('kicked', (reason) => {
      if (isCurrent(session)) logger.warn(`[BOT] Kicked: ${stringifyReason(reason)}`)
      onConnectionLost(session, 'Kicked from server')
    })

    bot.on('error', (error) => {
      if (isCurrent(session)) logger.error(`[BOT] Error: ${stringifyReason(error)}`)
      onConnectionLost(session, 'Connection error')
    })

    bot.on('end', (reason) => {
      if (isCurrent(session)) logger.warn(`[BOT] Disconnected: ${stringifyReason(reason)}`)
      onConnectionLost(session, 'Disconnected')
    })
  }

  function start () {
    if (phase !== 'idle') return

    phase = 'active'
    logger.info(`[SCHEDULE] Repeating: ${formatDuration(config.activeDurationMs)} connected -> ` +
      `${formatDuration(config.restDurationMs)} offline. Failed joins retry every ${formatDuration(config.reconnectDelayMs)}.`)
    connect()
  }

  function stop () {
    if (phase === 'stopped') return

    phase = 'stopped'
    retryTimer = clearTimer(retryTimer)
    restTimer = clearTimer(restTimer)

    if (current) {
      const session = current
      accountOnlineTime(session)
      closeSession(session, 'Bot stopped')
    }

    logger.info('[BOT] Stopped; all timers cleared.')
  }

  function getStatus () {
    const remaining = current && current.onlineSince !== null
      ? Math.max(0, remainingActiveMs - Math.max(0, now() - current.onlineSince))
      : remainingActiveMs

    return {
      phase,
      cycle,
      connected: Boolean(current && current.spawned),
      remainingActiveMs: remaining
    }
  }

  return { start, stop, getStatus }
}

module.exports = { createRunner, installMovementTickEndFix }
