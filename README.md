# ZipLogger — Client Documentation

[ZipLogger](https://ziplogger.me) is log management that finds the commit that broke production —
search, dashboards, alerts, log-pattern clustering, AI analysis, and git regression attribution.

This repository is the public integration documentation: how to send logs to ZipLogger from any
language, framework, or shipper. Every integration converges into the same pipeline, so all
features work identically regardless of transport.

## Quick start

1. [Create a free account](https://ziplogger.me/signup.html) (1,000 logs/day, free forever).
2. In the app, create an ingestion key under **Settings → API keys** (`zk_...`).
3. Send your first log:

```bash
curl -X POST https://app.ziplogger.me/ingest/v1/logs \
  -H "X-Api-Key: zk_..." \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from curl","severity":"info","source":"quickstart"}'
```

Your log is searchable within seconds. Self-hosted? Replace `app.ziplogger.me` with your
instance's origin everywhere below.

## Integrations

| Guide | Package |
|---|---|
| [.NET](docs/dotnet.md) — `ILogger` provider + Serilog sink | `ZipLogger.Extensions.Logging`, `ZipLogger.Serilog` |
| [Python](docs/python.md) — stdlib `logging` handler | `ziplogger` (pip) |
| [Node.js](docs/nodejs.md) — core client + Pino & Winston transports | `ziplogger` (npm) |
| [Go](docs/go.md) — client + `log/slog` handler | `ziplogger` (Go module) |
| [Java](docs/java.md) — JDK-only client + `java.util.logging` handler | `dev.ziplogger:ziplogger` (Maven) |
| [Browser / React](docs/browser.md) — error capture + React error boundary | `@ziplogger/browser` (npm) |
| [OpenTelemetry](docs/opentelemetry.md) — native OTLP/HTTP logs receiver | any OTel SDK / Collector |
| [Fluent Bit / Vector](docs/shippers.md) — ship logs from apps you can't modify | — |
| [HTTP API](docs/http-api.md) — raw ingestion reference | anything that can POST JSON |

## Shared delivery semantics

Every official SDK behaves the same way, so you can trust them in production:

- **A logging call never blocks and never throws.** Entries buffer in a bounded in-memory queue
  (default 10,000) and ship in the background as NDJSON batches (default 100/batch, 2 s linger).
- **Drop over grow** — when the buffer is full, new entries are dropped and counted rather than
  growing memory without bound.
- **Retry with exponential backoff** on transient failures (429 honoring `Retry-After`, 408, 5xx,
  network errors); non-transient responses (400/401) drop the batch immediately.
- **Automatic enrichment** — `source`, `release`, `commitSha`, `environment`, `machineName` are
  attached from your build/runtime (overridable via options or `ZIPLOGGER_*` env vars). Release +
  commit SHA are what power git regression attribution.
- **Exceptions become `stackTrace`** — which feeds "which commit broke this?" analysis.
- **Graceful shutdown** — close/dispose flushes the buffer with a bounded timeout.

## Quotas

Each plan includes a daily log quota. When it's exhausted, ingestion answers `429` with a
`Retry-After` header pointing at the next UTC midnight; SDKs honor it automatically and your
application is never blocked. See [pricing](https://ziplogger.me/pricing.html) for plan limits.

## Support

- Documentation site: [ziplogger.me/docs.html](https://ziplogger.me/docs.html)
- Support: [support@ziplogger.dev](mailto:support@ziplogger.dev)
- Sales & partnerships: [contact@ziplogger.dev](mailto:contact@ziplogger.dev)
