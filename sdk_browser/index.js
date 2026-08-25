/**
 * ZipLogger browser SDK.
 *
 * Same delivery semantics as every ZipLogger SDK — bounded queue, NDJSON batches,
 * retry with backoff honoring 429 Retry-After, drop-on-backpressure, never throws —
 * tuned for the browser: smaller defaults, `fetch(..., { keepalive: true })` so a
 * final flush survives page unload, and automatic page context on every event.
 *
 * Zero dependencies. Works in any environment with `fetch` (tests run under Node).
 */

const SEVERITIES = new Set(['debug', 'info', 'warn', 'error', 'fatal'])
const HAS_WINDOW = typeof window !== 'undefined'

/** Cryptographically-random lowercase hex, for W3C trace/span ids. */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

export class ZipLoggerBrowser {
  /** @param {import('./index').BrowserOptions} options */
  constructor(options) {
    if (!options || !options.endpoint) throw new Error('ZipLogger: endpoint is required')
    if (!options.apiKey) throw new Error('ZipLogger: apiKey is required')

    const trimmed = String(options.endpoint).replace(/\/+$/, '')
    this._url = /\/logs$/i.test(trimmed) ? trimmed : trimmed + '/ingest/v1/logs'
    this._apiKey = options.apiKey
    this._source = options.source || (HAS_WINDOW ? window.location.hostname : 'browser')
    this._release = options.release
    this._commitSha = options.commitSha
    this._environment = options.environment || 'production'
    this._tags = Array.isArray(options.tags) && options.tags.length ? options.tags : undefined
    this._includePageContext = options.includePageContext !== false

    this._queueCapacity = options.queueCapacity ?? 1_000
    this._batchSize = options.batchSize ?? 20
    this._flushInterval = options.flushIntervalMs ?? 3_000
    this._maxRetries = options.maxRetries ?? 2
    this._retryBaseDelay = options.retryBaseDelayMs ?? 500

    this.dropped = 0
    this._queue = []
    this._timer = null
    this._sending = Promise.resolve()
    this._detach = []

    if (HAS_WINDOW) {
      const onHide = () => { void this.flush(true) }
      window.addEventListener('pagehide', onHide)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') onHide()
      })
      this._detach.push(() => window.removeEventListener('pagehide', onHide))
    }
  }

  /**
   * Queue one event for background delivery. Never blocks, never throws.
   * @param {import('./index').BrowserLogEntry} entry
   */
  log(entry) {
    if (this._queue.length >= this._queueCapacity) { this.dropped++; return }

    const fields = { environment: this._environment, ...entry.fields }
    if (this._includePageContext && HAS_WINDOW) {
      fields.url = window.location.href
      fields.userAgent = navigator.userAgent
    }
    const record = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      severity: SEVERITIES.has(entry.severity) ? entry.severity : 'info',
      message: entry.message ?? '',
      source: entry.source ?? this._source,
      release: entry.release ?? this._release,
      commitSha: entry.commitSha ?? this._commitSha,
      stackTrace: entry.stackTrace,
      fields,
      tags: entry.tags ?? this._tags,
    }
    if (entry.error instanceof Error) {
      record.stackTrace = record.stackTrace ?? (entry.error.stack || String(entry.error))
      fields.exceptionType = entry.error.name
      fields.exceptionMessage = entry.error.message
    }
    delete record.error

    this._queue.push(record)
    this._schedule(this._queue.length >= this._batchSize ? 0 : this._flushInterval)
  }

  /** Convenience: report a caught error with optional context. */
  captureError(error, fields) {
    this.log({
      severity: 'error',
      message: error && error.message ? error.message : String(error),
      error: error instanceof Error ? error : undefined,
      fields,
    })
  }

  /**
   * Start capturing window `error` and `unhandledrejection` events.
   * Returns a function that stops capturing.
   */
  captureGlobalErrors() {
    if (!HAS_WINDOW) return () => {}
    const onError = (event) => {
      this.log({
        severity: 'error',
        message: event.message || 'Uncaught error',
        error: event.error instanceof Error ? event.error : undefined,
        fields: { file: event.filename, line: event.lineno, column: event.colno, handler: 'window.onerror' },
      })
    }
    const onRejection = (event) => {
      const reason = event.reason
      this.log({
        severity: 'error',
        message: reason && reason.message ? `Unhandled rejection: ${reason.message}` : 'Unhandled promise rejection',
        error: reason instanceof Error ? reason : undefined,
        fields: { handler: 'unhandledrejection' },
      })
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    const stop = () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
    this._detach.push(stop)
    return stop
  }

  /**
   * Instrument `window.fetch` for distributed tracing: every outgoing request to your own
   * backend gets a W3C `traceparent` header, so the server continues the SAME trace — a failed
   * browser call and its backend waterfall share one trace id in ZipLogger. Failed requests
   * (HTTP >= 400 or network errors) are logged automatically with that trace id, which becomes
   * a "View trace" link on the server.
   *
   * Propagation targets: same-origin requests by default; pass `propagateTo` (array of origin
   * prefixes, e.g. ["https://api.mycompany.com"]) for cross-origin APIs you control — those
   * servers must allow the `traceparent` header in CORS. Returns a function that stops
   * instrumenting.
   *
   * @param {{ propagateTo?: string[], logFailures?: boolean }} [options]
   */
  instrumentFetch(options = {}) {
    if (!HAS_WINDOW || typeof window.fetch !== 'function') return () => {}
    const propagateTo = options.propagateTo || []
    const logFailures = options.logFailures !== false
    const sendSpans = options.sendSpans !== false
    const serviceName = options.serviceName || `${this._source}-browser`
    const ingestOrigin = this._url.split('/').slice(0, 3).join('/')
    const original = window.fetch.bind(window)
    const self = this
    const spanQueue = []
    let spanTimer = null

    const shouldPropagate = (url) => {
      if (url.startsWith(ingestOrigin)) return false // never trace our own telemetry shipping
      if (url.startsWith(window.location.origin) || url.startsWith('/')) return true
      return propagateTo.some((origin) => url.startsWith(origin))
    }

    // Ship the browser-side root spans over OTLP/JSON, so the ZipLogger waterfall shows the
    // request from the user's browser down through every backend service — one trace.
    const flushSpans = () => {
      spanTimer = null
      if (spanQueue.length === 0) return
      const spans = spanQueue.splice(0, spanQueue.length)
      const payload = {
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{ spans }],
        }],
      }
      void original(`${ingestOrigin}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': self._apiKey },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {})
    }
    const enqueueSpan = (span) => {
      if (!sendSpans) return
      spanQueue.push(span)
      if (spanTimer === null) spanTimer = setTimeout(flushSpans, self._flushInterval)
    }

    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!shouldPropagate(String(url))) return original(input, init)

      const traceId = randomHex(16)
      const spanId = randomHex(8)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set('traceparent', `00-${traceId}-${spanId}-01`)

      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const path = String(url).replace(/^https?:\/\/[^/]+/, '') || '/'
      const startNs = String(BigInt(Date.now()) * 1000000n)
      const finish = (status, errorMessage) => {
        enqueueSpan({
          traceId, spanId,
          name: `${method} ${path.split('?')[0]}`,
          kind: 'SPAN_KIND_CLIENT',
          startTimeUnixNano: startNs,
          endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
          attributes: [
            { key: 'url.full', value: { stringValue: String(url) } },
            { key: 'http.request.method', value: { stringValue: method } },
            ...(status ? [{ key: 'http.response.status_code', value: { intValue: String(status) } }] : []),
          ],
          ...(errorMessage || (status && status >= 400)
            ? { status: { code: 'STATUS_CODE_ERROR', message: errorMessage || `HTTP ${status}` } }
            : {}),
        })
      }

      try {
        const response = await original(input, { ...init, headers })
        finish(response.status)
        if (logFailures && response.status >= 400) {
          self.log({
            severity: response.status >= 500 ? 'error' : 'warn',
            message: `${method} ${url} failed with HTTP ${response.status}`,
            fields: { traceId, spanId, httpStatus: response.status, requestUrl: String(url) },
          })
        }
        return response
      } catch (error) {
        const message = error && error.message ? error.message : 'network error'
        finish(null, message)
        if (logFailures) {
          self.log({
            severity: 'error',
            message: `${method} ${url} failed: ${message}`,
            error: error instanceof Error ? error : undefined,
            fields: { traceId, spanId, requestUrl: String(url) },
          })
        }
        throw error
      }
    }

    const stop = () => {
      window.fetch = original
      if (spanTimer !== null) { clearTimeout(spanTimer); flushSpans() }
    }
    this._detach.push(stop)
    return stop
  }

  _schedule(delay) {
    if (this._timer !== null) {
      if (delay > 0) return
      clearTimeout(this._timer)
    }
    this._timer = setTimeout(() => {
      this._timer = null
      this._sending = this._sending.then(() => this._drain(false)).catch(() => {})
    }, delay)
    if (typeof this._timer === 'object' && this._timer.unref) this._timer.unref()
  }

  async _drain(keepalive) {
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, this._batchSize)
      await this._send(batch, keepalive)
    }
  }

  async _send(batch, keepalive) {
    const payload = batch.map((e) => JSON.stringify(e)).join('\n')

    for (let attempt = 0; ; attempt++) {
      let retryAfterMs = null
      try {
        const response = await fetch(this._url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-ndjson', 'X-Api-Key': this._apiKey },
          body: payload,
          keepalive, // survives page unload (64 KB budget — batches are small)
        })
        if (response.ok) return
        if (response.status !== 429 && response.status !== 408 && response.status < 500) {
          this.dropped += batch.length
          return
        }
        const header = response.headers.get('retry-after')
        if (header && !Number.isNaN(Number(header))) retryAfterMs = Number(header) * 1000
      } catch {
        // offline / network failure — transient
      }

      if (keepalive || attempt >= this._maxRetries) {
        this.dropped += batch.length // unloading pages don't get retries
        return
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(retryAfterMs ?? this._retryBaseDelay * 2 ** attempt, 10_000))
        if (typeof timer === 'object' && timer.unref) timer.unref()
      })
    }
  }

  /** Send anything still buffered. Pass keepalive=true during page unload. */
  async flush(keepalive = false) {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null }
    this._sending = this._sending.then(() => this._drain(keepalive)).catch(() => {})
    await this._sending
  }

  /** Flush and detach all global listeners. */
  async close() {
    for (const stop of this._detach.splice(0)) stop()
    await this.flush()
  }
}

export default ZipLoggerBrowser
