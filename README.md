# ZipLogger client documentation

[ZipLogger](https://ziplogger.dev) is log management that finds the commit that broke production:
search, dashboards, alerts, log-pattern clustering, distributed tracing, request metrics, AI
analysis, and git regression attribution.

This repository is the public integration documentation: how to send telemetry to ZipLogger from
any language, framework, or shipper, and how to read it back out. Every integration converges into
the same pipeline, so all features work identically regardless of transport.

ZipLogger is a hosted service. Your workspace lives at `https://app.ziplogger.dev` and your apps
only need outbound HTTPS to reach it. There is nothing to install or operate.

## Quick start

1. [Create a free account](https://ziplogger.dev/signup.html) (1,000 logs/day, free forever).
2. In the app, create an ingestion key under **Settings → API keys** (`zk_...`).
3. Send your first log:

```bash
curl -X POST https://app.ziplogger.dev/ingest/v1/logs \
  -H "X-Api-Key: zk_..." \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from curl","severity":"info","source":"quickstart"}'
```

Your log is searchable within seconds.

## Integrations

### Logs

| Guide | Package |
|---|---|
| [.NET](docs/dotnet.md): `ILogger` provider, Serilog sink, core client | `ZipLogger.Extensions.Logging`, `ZipLogger.Serilog`, `ZipLogger.Client` |
| [Python](docs/python.md): stdlib `logging` handler | `ziplogger` (pip) |
| [Node.js](docs/nodejs.md): core client plus Pino and Winston transports | `ziplogger` (npm) |
| [Go](docs/go.md): client plus `log/slog` handler | `ziplogger` (Go module) |
| [Java](docs/java.md): JDK-only client plus `java.util.logging` handler | `dev.ziplogger:ziplogger` (Maven) |
| [Browser / React](docs/browser.md): error capture, React error boundary, fetch tracing | `@ziplogger/browser` (npm) |
| [OpenTelemetry](docs/opentelemetry.md): native OTLP/HTTP logs receiver | any OTel SDK or Collector |
| [Fluent Bit / Vector](docs/shippers.md): ship logs from apps you cannot modify | any shipper |
| [HTTP ingestion API](docs/http-api.md): raw log ingestion reference | anything that can POST JSON |

### Traces, metrics, and everything else

| Guide | What it covers |
|---|---|
| [Distributed tracing](docs/tracing.md) | OTLP/HTTP `/v1/traces`, span mapping, browser-to-backend traces, trace/log correlation |
| [Request metrics (APM)](docs/metrics.md) | ASP.NET Core middleware, custom metrics, and the `/ingest/v1/metrics` endpoint for any stack |
| [MCP server](docs/mcp.md) | Query your workspace from Claude Code, Cursor, or any MCP client |
| [Alerts and webhooks](docs/alerts-webhooks.md) | Webhook payload contract and the sandboxed custom-script API |
| [Query API](docs/query-api.md) | Read logs, traces, metrics, and patterns back out programmatically |
| [Configuration reference](docs/configuration.md) | Every `ZIPLOGGER_*` environment variable and option, side by side |

## Shared delivery semantics

Every official SDK behaves the same way, so you can trust them in production:

- **A logging call never blocks and never throws.** Entries buffer in a bounded in-memory queue
  (default 10,000) and ship in the background as NDJSON batches (default 100/batch, 2 s linger).
- **Drop over grow.** When the buffer is full, new entries are dropped and counted rather than
  growing memory without bound. Every SDK exposes that counter, so you can alert on it.
- **Retry with exponential backoff** on transient failures (429 honoring `Retry-After`, 408, 5xx,
  network errors). Non-transient responses (400/401) drop the batch immediately.
- **Automatic enrichment.** `source`, `release`, `commitSha`, `environment`, and `machineName` are
  attached from your build and runtime, overridable via options or `ZIPLOGGER_*` environment
  variables. Release plus commit SHA are what power git regression attribution.
- **Exceptions become `stackTrace`**, which feeds "which commit broke this?" analysis.
- **Graceful shutdown.** Close or dispose flushes the buffer with a bounded timeout.

See the [configuration reference](docs/configuration.md) for the exact option name in each language.

## Quotas

Each plan includes a daily and a monthly log quota, and spans count toward the same quota as logs.
When a quota is exhausted, ingestion answers `429` with a `Retry-After` header pointing at the next
UTC midnight, plus a JSON body showing current usage. SDKs honor it automatically and your
application is never blocked. See [pricing](https://ziplogger.dev/pricing.html) for plan limits and
[the HTTP API reference](docs/http-api.md#responses) for the response body.

## Support

- Documentation site: [ziplogger.dev/docs.html](https://ziplogger.dev/docs.html)
- Support: [support@ziplogger.dev](mailto:support@ziplogger.dev)
- Sales and partnerships: [contact@ziplogger.dev](mailto:contact@ziplogger.dev)
