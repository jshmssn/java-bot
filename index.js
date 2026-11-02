'use strict'

const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const { loadConfig } = require('./lib/config')
const { createRunner } = require('./lib/runner')
const { createHttpServer } = require('./lib/http-server')

let config
try {
  config = loadConfig(process.env, __dirname)
} catch (error) {
  console.error(`[CONFIG] ${error.message}`)
  process.exit(1)
}

const enginePackage = config.engine === 'community' ? '@wp2508/mineflayer' : 'mineflayer'
let mineflayer
try {
  mineflayer = require(enginePackage)
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND') {
    console.error(`[SETUP] Missing package '${enginePackage}'. Run: npm install ${enginePackage}`)
  } else {
    console.error('[SETUP] Could not load Mineflayer:', error)
  }
  process.exit(1)
}

const runner = createRunner({ mineflayer, config })
const server = createHttpServer({ getStatus: () => runner.getStatus() })

server.on('error', (error) => {
  console.error(`[HTTP] Could not start Render health endpoint: ${error.message}`)
  runner.stop()
  process.exit(1)
})

// Render requires an HTTP listener on 0.0.0.0:$PORT.
// External probes of /health keep a Free web service from idling out.
server.listen(config.httpPort, '0.0.0.0', () => {
  console.log(`[HTTP] Health: http://0.0.0.0:${config.httpPort}/health`)
  console.log(`[HTTP] Bot status: http://0.0.0.0:${config.httpPort}/status`)
  runner.start()
})

let shutdownStarted = false
function shutdown (signal) {
  if (shutdownStarted) return
  shutdownStarted = true
  console.log(`[BOT] Received ${signal}. Disconnecting cleanly...`)
  runner.stop()
  server.close()
  // Allow the network socket to drain, but do not hang forever.
  setTimeout(() => process.exit(0), 3000).unref()
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
