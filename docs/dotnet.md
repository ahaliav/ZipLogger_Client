# .NET

Your application code never references ZipLogger — it logs through the standard abstractions
(`ILogger` or Serilog), and the provider/sink ships entries in the background.

## ILogger (Microsoft.Extensions.Logging)

Package: `ZipLogger.Extensions.Logging`

```csharp
// Program.cs
builder.Logging.AddZipLogger(options =>
{
    options.Endpoint = "https://app.ziplogger.me";
    options.ApiKey   = "zk_...";
});
```

Or configure from `appsettings.json` (call `builder.Logging.AddZipLogger();` with no arguments):

```json
{
  "Logging": {
    "ZipLogger": {
      "Endpoint": "https://app.ziplogger.me",
      "ApiKey": "zk_...",
      "LogLevel": { "Default": "Information" }
    }
  }
}
```

Then just log as usual — structured values, scopes, and exceptions all flow through:

```csharp
logger.LogWarning("Payment {Status} for {Customer}", "declined", "acme");
// → severity=warn, fields: { Status: "declined", Customer: "acme", messageTemplate: "...", category: "..." }

logger.LogError(ex, "Sync failed");
// → stackTrace = ex.ToString() (feeds git regression attribution), fields: exceptionType, exceptionMessage
```

## Serilog

Package: `ZipLogger.Serilog`

```csharp
Log.Logger = new LoggerConfiguration()
    .WriteTo.ZipLogger("https://app.ziplogger.me", "zk_...")
    .CreateLogger();
```

## What the client does for you

- **Never blocks, never throws** — entries go into a bounded in-memory channel; a background
  worker batches them (default 100/batch, 2 s linger) and POSTs NDJSON to `/ingest/v1/logs`.
- **Drop over grow** — when the queue is full (default 10,000) new entries are dropped and counted
  (`ILogShipper.DroppedCount`) instead of growing memory unboundedly.
- **Retry with exponential backoff + jitter** — on 429 (honoring `Retry-After`), 408, 5xx, and
  network failures; non-transient errors (401, 400) drop the batch immediately.
- **Automatic enrichment** — every entry gets:
  - `source` — entry assembly name (or `Source` option / `ZIPLOGGER_SOURCE`)
  - `release` — assembly informational version (or `Release` option / `ZIPLOGGER_RELEASE`)
  - `commitSha` — SourceLink `+sha` version suffix (or `CommitSha` option /
    `ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` / `COMMIT_SHA`) — powers regression attribution
  - `fields.environment` — `DOTNET_ENVIRONMENT` / `ASPNETCORE_ENVIRONMENT`
  - `fields.machineName` — machine name
- **Graceful shutdown** — disposal flushes the buffer (bounded by `ShutdownTimeout`, default 5 s).

## Options

`ZipLoggerClientOptions`: `QueueCapacity`, `BatchSize`, `FlushInterval`, `MaxRetries`,
`RetryBaseDelay`/`RetryMaxDelay`, `HttpTimeout`, `ShutdownTimeout`, `Tags`, plus the enrichment
overrides above. The ILogger provider adds `IncludeScopes` / `IncludeCategory`.

## Request metrics (APM)

Package: `ZipLogger.Metrics.AspNetCore` — a middleware that times every request and powers the
**Metrics** page's avg/p95 latency and throughput series per service:

```csharp
builder.Services.AddZipLoggerMetrics(builder.Configuration, service: "orders-api");
var app = builder.Build();
app.UseZipLoggerMetrics();   // early, so timings cover the whole pipeline
```

It reuses your `ZipLogger:Endpoint` / `ZipLogger:ApiKey` settings (overridable under
`ZipLogger:Metrics`), attaches `method` / `route` (the route *pattern*, keeping label cardinality
low) / `status` labels, and follows the same delivery semantics as the log clients — bounded
queue, batching, 429-aware retries, never blocks a request, no-op when unconfigured.
