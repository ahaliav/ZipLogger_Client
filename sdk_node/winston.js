'use strict'

/**
 * Winston transport for ZipLogger.
 *
 *   const winston = require('winston')
 *   const { ZipLoggerTransport } = require('ziplogger/winston')
 *
 *   const logger = winston.createLogger({
 *     transports: [new ZipLoggerTransport({ endpoint: '...', apiKey: 'zk_...' })],
 *   })
 *
 * Requires the `winston-transport` peer package (ships with winston itself).
 */

const { ZipLoggerClient, mapLevel } = require('./index')

let Transport
try {
  Transport = require('winston-transport')
} catch {
  throw new Error(
    "ziplogger/winston requires the 'winston-transport' package (installed automatically with winston). " +
    'Run: npm install winston')
}

const INTERNAL = new Set(['level', 'message', 'timestamp', 'stack', Symbol.for('level'), Symbol.for('message'), Symbol.for('splat')])

class ZipLoggerTransport extends Transport {
  /** @param {import('./index').ZipLoggerOptions & import('winston-transport').TransportStreamOptions} options */
  constructor(options) {
    super(options)
    this.client = new ZipLoggerClient(options)
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info))

    const fields = {}
    for (const key of Object.keys(info)) {
      if (INTERNAL.has(key)) continue
      const value = info[key]
      fields[key] = value === null || ['string', 'number', 'boolean'].includes(typeof value)
        ? value
        : safeString(value)
    }

    this.client.log({
      severity: mapLevel(info.level),
      message: typeof info.message === 'string' ? info.message : safeString(info.message),
      stackTrace: typeof info.stack === 'string' ? info.stack : undefined,
      fields,
    })
    callback()
  }

  close() {
    void this.client.close()
  }
}

function safeString(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

module.exports = { ZipLoggerTransport }
