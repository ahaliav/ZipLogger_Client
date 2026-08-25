'use strict'

/**
 * Pino transport for ZipLogger.
 *
 *   const pino = require('pino')
 *   const logger = pino(pino.transport({
 *     target: 'ziplogger/pino',
 *     options: { endpoint: 'https://logs.yourcompany.com', apiKey: 'zk_...' },
 *   }))
 *
 * Runs in pino's worker thread via `pino-abstract-transport` (peer dependency):
 *   npm install pino pino-abstract-transport
 */

const { ZipLoggerClient, mapLevel } = require('./index')

let build
try {
  build = require('pino-abstract-transport')
} catch {
  throw new Error(
    "ziplogger/pino requires the 'pino-abstract-transport' package. " +
    'Run: npm install pino-abstract-transport')
}

const INTERNAL = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'err'])

/** @param {import('./index').ZipLoggerOptions} options */
module.exports = async function ziploggerPinoTransport(options) {
  const client = new ZipLoggerClient(options)

  return build(
    async function (source) {
      for await (const record of source) {
        const fields = {}
        for (const key of Object.keys(record)) {
          if (INTERNAL.has(key)) continue
          const value = record[key]
          fields[key] = value === null || ['string', 'number', 'boolean'].includes(typeof value)
            ? value
            : JSON.stringify(value)
        }
        if (typeof record.pid === 'number') fields.pid = record.pid

        client.log({
          timestamp: typeof record.time === 'number' ? new Date(record.time).toISOString() : undefined,
          severity: mapLevel(record.level),
          message: record.msg ?? '',
          stackTrace: record.err && typeof record.err.stack === 'string' ? record.err.stack : undefined,
          fields: record.err
            ? { ...fields, exceptionType: record.err.type, exceptionMessage: record.err.message }
            : fields,
        })
      }
    },
    {
      async close() {
        await client.close()
      },
    },
  )
}
