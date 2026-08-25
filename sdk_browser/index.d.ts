export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface BrowserOptions {
  /** Base URL of the ZipLogger server, e.g. "https://logs.yourcompany.com". */
  endpoint: string
  /** Tenant ingestion API key (zk_...). Use a key dedicated to browser traffic. */
  apiKey: string
  /** Source name. Default: window.location.hostname. */
  source?: string
  release?: string
  commitSha?: string
  /** Default "production". */
  environment?: string
  tags?: string[]
  /** Attach url + userAgent fields to every event. Default true. */
  includePageContext?: boolean
  /** Max buffered events. Default 1000. */
  queueCapacity?: number
  /** Max events per request. Default 20. */
  batchSize?: number
  /** Linger before flushing a partial batch. Default 3000. */
  flushIntervalMs?: number
  /** Retry attempts per batch. Default 2 (browsers should not hammer). */
  maxRetries?: number
  retryBaseDelayMs?: number
}

export interface BrowserLogEntry {
  message: string
  severity?: Severity
  timestamp?: string
  source?: string
  release?: string
  commitSha?: string
  stackTrace?: string
  error?: Error
  fields?: Record<string, unknown>
  tags?: string[]
}

export declare class ZipLoggerBrowser {
  constructor(options: BrowserOptions)
  /** Events lost to backpressure or exhausted retries. */
  dropped: number
  /** Queue an event for background delivery. Never blocks, never throws. */
  log(entry: BrowserLogEntry): void
  /** Report a caught error with optional context fields. */
  captureError(error: unknown, fields?: Record<string, unknown>): void
  /** Capture window error / unhandledrejection events. Returns a stop function. */
  captureGlobalErrors(): () => void
  /**
   * Wraps window.fetch: adds a W3C traceparent header to same-origin requests (plus any
   * origins in propagateTo) so browser calls and backend traces share one trace id, and
   * logs failed requests (HTTP >= 400 / network errors) with that trace id.
   */
  instrumentFetch(options?: {
    propagateTo?: string[]
    logFailures?: boolean
    /** Export a browser-side root span per request (default true) so the waterfall starts in the browser. */
    sendSpans?: boolean
    /** Service name for browser spans (default "<source>-browser"). */
    serviceName?: string
  }): () => void
  /** Send anything still buffered. keepalive=true during page unload. */
  flush(keepalive?: boolean): Promise<void>
  /** Flush and detach global listeners. */
  close(): Promise<void>
}
export default ZipLoggerBrowser

// ./react
import type * as ReactNamespace from 'react'
export declare function createErrorBoundary(
  React: typeof ReactNamespace,
  client: ZipLoggerBrowser,
): ReactNamespace.ComponentType<{
  children?: ReactNamespace.ReactNode
  fallback?: ReactNamespace.ReactNode
  name?: string
  onError?: (error: unknown, info: { componentStack?: string }) => void
}>
export declare function createUseZipLogger(
  React: typeof ReactNamespace,
  client: ZipLoggerBrowser,
): () => {
  captureError: (error: unknown, fields?: Record<string, unknown>) => void
  log: (entry: BrowserLogEntry) => void
}
