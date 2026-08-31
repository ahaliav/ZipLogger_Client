# Node.js

A zero-dependency core client plus **Pino** and **Winston** transports. Batching, retry with
backoff (429-aware), drop-on-backpressure, automatic enrichment. Node 18 or newer.

```bash
npm install ziplogger
```

The package ships CommonJS with TypeScript declarations, and is importable by name from ESM and
TypeScript.

## Pino

```js
const pino = require('pino')

const logger = pino(pino.transport({
  target: 'ziplogger/pino',
  options: { endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...' },
}))

logger.info({ orderId: 83112, customer: 'acme' }, 'Order created')
logger.error({ err }, 'Payment failed')   // err.stack becomes ZipLogger's stackTrace
```

Requires `pino-abstract-transport` (`npm i pino pino-abstract-transport`). The transport runs in
pino's worker thread, so serialization and HTTP shipping stay off your event loop entirely.

Ship to ZipLogger and stdout at once:

```js
const logger = pino(pino.transport({
  targets: [
    { target: 'pino-pretty', options: { colorize: true } },
    { target: 'ziplogger/pino', level: 'info',
      options: { endpoint: 'https://app.ziplogger.ai', apiKey: process.env.ZIPLOGGER_API_KEY } },
  ],
}))
```

Everything on the log object except pino's own internals (`level`, `time`, `msg`, `pid`,
`hostname`, `err`) becomes a ZipLogger field. `err` is unpacked into `stackTrace`,
`fields.exceptionType`, and `fields.exceptionMessage`. Values that are not strings, numbers, or
booleans are JSON-stringified, so nested objects arrive readable rather than as `[object Object]`.

## Winston

```js
const winston = require('winston')
const { ZipLoggerTransport } = require('ziplogger/winston')

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console(),
    new ZipLoggerTransport({
      endpoint: 'https://app.ziplogger.ai',
      apiKey: process.env.ZIPLOGGER_API_KEY,
      source: 'orders-api',
      level: 'info',           // standard winston transport option
    }),
  ],
})

logger.info('Order created', { orderId: 83112 })
logger.error('Payment failed', { err })
```

Metadata becomes fields; `info.stack` becomes `stackTrace`. Use
`winston.format.errors({ stack: true })` so `Error` objects populate it:

```js
const logger = winston.createLogger({
  format: winston.format.combine(winston.format.errors({ stack: true }), winston.format.json()),
  transports: [new ZipLoggerTransport({ endpoint: '...', apiKey: 'zk_...' })],
})
```

## Core client (any framework, or none)

```js
const { ZipLoggerClient } = require('ziplogger')

const zl = new ZipLoggerClient({ endpoint: 'https://app.ziplogger.ai', apiKey: 'zk_...' })
zl.log({ severity: 'info', message: 'job finished', fields: { jobId: 42 } })
zl.log({ severity: 'error', message: 'job failed', error: err })
await zl.close()   // flush on shutdown
```

From ESM or TypeScript:

```ts
import { ZipLoggerClient, type LogEntry } from 'ziplogger'

const zl = new ZipLoggerClient({
  endpoint: 'https://app.ziplogger.ai',
  apiKey: process.env.ZIPLOGGER_API_KEY!,
})
```

There is no default export; import `ZipLoggerClient` and `mapLevel` by name.

`log()` accepts `message`, `severity`, `timestamp`, `source`, `release`, `commitSha`, `stackTrace`,
`error`, `fields`, and `tags`. Passing `error` is the shortcut: its `stack`, `name`, and `message`
are mapped for you.

`mapLevel(level)` is exported too, for writing your own transport. It handles pino's numeric levels
plus the usual names (`warning`, `trace`, `verbose`, `silly`, `critical`).

## Recipes

### Express and Fastify

```js
// Express: log unhandled errors with their stack
app.use((err, req, res, next) => {
  logger.error({ err, method: req.method, route: req.route?.path, userId: req.user?.id },
               'Unhandled error')
  res.status(500).json({ error: 'internal' })
})
```

```js
// Fastify uses pino natively: point its logger config at the transport
const fastify = require('fastify')({
  logger: {
    transport: {
      target: 'ziplogger/pino',
      options: { endpoint: 'https://app.ziplogger.ai', apiKey: process.env.ZIPLOGGER_API_KEY },
    },
  },
})
```

### NestJS

```ts
// main.ts, using nestjs-pino, so Nest's own logs ship too
import { LoggerModule } from 'nestjs-pino'

LoggerModule.forRoot({
  pinoHttp: {
    transport: {
      target: 'ziplogger/pino',
      options: { endpoint: 'https://app.ziplogger.ai', apiKey: process.env.ZIPLOGGER_API_KEY },
    },
  },
})
```

### Catching what you did not log

```js
process.on('uncaughtException', async (err) => {
  zl.log({ severity: 'fatal', message: 'uncaughtException', error: err })
  await zl.close(2000)     // flush before the process dies
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  zl.log({ severity: 'error', message: 'unhandledRejection',
           error: reason instanceof Error ? reason : undefined,
           fields: { reason: String(reason) } })
})
```

### Graceful shutdown

```js
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await server.close()
    await zl.close(5000)   // bounded: never let a hung network delay exit
    process.exit(0)
  })
}
```

### Serverless (Lambda, Cloud Functions, Vercel)

The runtime freezes your container between invocations, so a background timer may never fire. Flush
explicitly at the end of every handler and keep the linger short:

```js
const zl = new ZipLoggerClient({
  endpoint: process.env.ZIPLOGGER_ENDPOINT,
  apiKey: process.env.ZIPLOGGER_API_KEY,
  flushIntervalMs: 200,
})

exports.handler = async (event) => {
  try {
    return await work(event)
  } finally {
    await zl.flush()     // flush, but keep the client for the next warm invocation
  }
}
```

Use `flush()` rather than `close()` in a warm-start runtime: `close()` stops accepting entries, so
the next invocation on the same container would log into a closed client.

## Severity mapping

| Input | ZipLogger severity |
|---|---|
| pino `>= 60`, `fatal`, `critical` | `fatal` |
| pino `>= 50`, `error` | `error` |
| pino `>= 40`, `warn`, `warning` | `warn` |
| pino `>= 30`, `info` | `info` |
| below that, `debug`, `trace`, `verbose`, `silly` | `debug` |

Anything unrecognized becomes `info`.

## Behavior

`log()` never blocks and never throws. Entries buffer in a bounded queue (default 10,000), ship as
NDJSON batches (default 100 per request, 2 s linger) to `/ingest/v1/logs`, retry transient failures
(429 honoring `Retry-After`, 5xx, network) with exponential backoff, and drop with a counter
(`client.dropped`) when the queue overflows or retries exhaust.

**Timers are `unref`ed**, so the SDK never keeps your process alive. That is the right default for
CLIs, and the reason short-lived processes should `await close()` explicitly rather than assuming
the timer will fire.

Every entry is enriched with `environment` (from `ZIPLOGGER_ENVIRONMENT` or `NODE_ENV`),
`machineName`, `release` (nearest `package.json` version), and `commitSha` (`ZIPLOGGER_COMMIT_SHA`,
`GIT_COMMIT`, or `COMMIT_SHA`), which are the inputs to git regression detection.

## Options

| Option | Default | Purpose |
|---|---|---|
| `endpoint`, `apiKey` | required | Server origin and ingestion key |
| `source` | script name | Service name |
| `release` | nearest `package.json` version | Build version |
| `commitSha` | env vars | Commit of the running build |
| `environment` | `NODE_ENV` or `production` | Deployment environment |
| `tags` | none | Tags added to every entry |
| `queueCapacity` | 10000 | Max buffered entries |
| `batchSize` | 100 | Entries per request |
| `flushIntervalMs` | 2000 | Linger before flushing a partial batch |
| `maxRetries` | 5 | Retry attempts per batch |
| `retryBaseDelayMs` / `retryMaxDelayMs` | 500 / 30000 | Backoff bounds |
| `timeoutMs` | 10000 | Per-request HTTP timeout |

Methods: `log(entry)`, `flush()`, `close(timeoutMs?)`, and the `dropped` counter.

## Docker and Kubernetes

```dockerfile
ENV ZIPLOGGER_SOURCE=orders-api ZIPLOGGER_ENVIRONMENT=production
ARG GIT_COMMIT
ENV ZIPLOGGER_COMMIT_SHA=$GIT_COMMIT
```

`release` comes from `package.json` automatically, so bumping the version is enough to make releases
comparable in the UI. See the [configuration reference](configuration.md).

## Tracing

Use OpenTelemetry auto-instrumentation and point the OTLP exporter at ZipLogger:

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
            @opentelemetry/exporter-trace-otlp-proto
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.ai \
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_... \
OTEL_SERVICE_NAME=orders-api \
  node --require @opentelemetry/auto-instrumentations-node/register app.js
```

Add the active trace id to your log fields to link the two. See
[tracing](tracing.md#correlating-logs-with-traces). For traces that start in the browser, see the
[browser guide](browser.md#frontend-to-backend-tracing).

## Troubleshooting

| Symptom | Check |
|---|---|
| `ziplogger/pino requires the 'pino-abstract-transport' package` | `npm i pino-abstract-transport`. It is an optional peer dependency. |
| Nothing arrives from a script | The process exited before the linger elapsed. `await zl.close()`, since timers are `unref`ed. |
| Nothing arrives from Lambda | Flush inside the handler; the container freezes between invocations. |
| Winston `stackTrace` empty | Add `winston.format.errors({ stack: true })`. |
| A field arrives as a JSON string | Non-primitive values are JSON-stringified so nothing is lost. Send the scalar you want to filter or range-query on as its own field. |
| `client.dropped` rising | Queue full or endpoint unreachable. Verify the key, then raise `batchSize`. |
| Duplicate logs | Both a pino transport and a manual client instance are shipping. Pick one. |
