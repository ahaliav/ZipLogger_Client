export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface ZipLoggerOptions {
  /** Base URL of the ZipLogger server, e.g. "https://logs.yourcompany.com". */
  endpoint: string
  /** Tenant ingestion API key (zk_...). */
  apiKey: string
  /** Application/source name. Default: script name or ZIPLOGGER_SOURCE. */
  source?: string
  /** Release/version. Default: nearest package.json version or ZIPLOGGER_RELEASE. */
  release?: string
  /** Git commit SHA. Default: ZIPLOGGER_COMMIT_SHA / GIT_COMMIT / COMMIT_SHA. */
  commitSha?: string
  /** Deployment environment. Default: ZIPLOGGER_ENVIRONMENT / NODE_ENV / "production". */
  environment?: string
  /** Tags added to every entry. */
  tags?: string[]
  /** Max buffered entries before new ones are dropped. Default 10000. */
  queueCapacity?: number
  /** Max entries per HTTP request. Default 100. */
  batchSize?: number
  /** Linger before flushing a partial batch. Default 2000. */
  flushIntervalMs?: number
  /** Retry attempts per batch. Default 5. */
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  /** Per-request HTTP timeout. Default 10000. */
  timeoutMs?: number
}

export interface LogEntry {
  message: string
  severity?: Severity
  timestamp?: string
  source?: string
  release?: string
  commitSha?: string
  stackTrace?: string
  /** Error whose stack/name/message are mapped automatically. */
  error?: Error
  fields?: Record<string, unknown>
  tags?: string[]
}

export declare class ZipLoggerClient {
  constructor(options: ZipLoggerOptions)
  /** Entries lost to backpressure or exhausted retries. */
  dropped: number
  /** Queue an entry for background delivery. Never blocks, never throws. */
  log(entry: LogEntry): void
  /** Send anything still buffered. */
  flush(): Promise<void>
  /** Flush (bounded by timeoutMs) and stop accepting entries. */
  close(timeoutMs?: number): Promise<void>
}

export declare function mapLevel(level: string | number): Severity
