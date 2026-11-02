'use strict'

const http = require('node:http')

/**
 * A tiny public HTTP endpoint for Render's required web port.
 * IMPORTANT: This cannot keep a Render Free service awake by itself.
 * An EXTERNAL monitor must request /health periodically.
 */
function createHttpServer ({ getStatus, startedAt = Date.now }) {
  if (typeof getStatus !== 'function') throw new TypeError('getStatus is required')
  const bootedAt = startedAt()

  return http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname
    const isHead = request.method === 'HEAD'
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }

    function reply (statusCode, payload, extraHeaders = {}) {
      const body = JSON.stringify(payload)
      response.writeHead(statusCode, { ...headers, ...extraHeaders })
      response.end(isHead ? undefined : body)
    }

    if (request.method !== 'GET' && !isHead) {
      return reply(405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' })
    }

    if (pathname === '/health' || pathname === '/ping') {
      // HTTP service healthy even while the Minecraft bot deliberately rests.
      return reply(200, { status: 'ok' })
    }

    if (pathname === '/' || pathname === '/status') {
      // Never expose the Minecraft hostname, account email or authentication cache.
      const { phase, cycle, connected, remainingActiveMs } = getStatus()
      return reply(200, {
        service: 'minecraft-java-bot',
        status: 'running',
        phase,
        cycle,
        connected,
        remainingActiveMs: Math.ceil(remainingActiveMs),
        uptimeSeconds: Math.floor((startedAt() - bootedAt) / 1000)
      })
    }

    return reply(404, { error: 'Not found' })
  })
}

module.exports = { createHttpServer }
