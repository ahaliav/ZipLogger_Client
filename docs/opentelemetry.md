# OpenTelemetry (OTLP)

ZipLogger exposes a native **OTLP/HTTP logs receiver** at `POST /v1/logs` (alias:
`POST /ingest/v1/otlp/logs`) accepting standard `ExportLogsServiceRequest` payloads as
`application/x-protobuf` or `application/json`, optionally gzip-encoded. Any OTel SDK or Collector
can export to it, with no ZipLogger code in your services.

This is the right path when you are already standardized on OpenTelemetry, when you want one
telemetry pipeline for several backends, or when your language has no ZipLogger SDK. If you just
want logs from a .NET, Python, Node, Go, or Java service, the native SDK is less work and enriches
`release` and `commitSha` for you.

For traces, see [distributed tracing](tracing.md). The same key and the same origin serve both.

## Point an OTel SDK exporter at ZipLogger

```bash
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.ai   # exporter appends /v1/logs
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_...
OTEL_SERVICE_NAME=orders-api
OTEL_RESOURCE_ATTRIBUTES=service.version=2026.8.1,deployment.environment=production
```

Give the exporter the **origin only**. It appends the signal path itself, so setting the full URL
here produces `/v1/logs/v1/logs` and nothing arrives.

To send logs but not traces (or the reverse), use the signal-specific variables:

```bash
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://app.ziplogger.ai/v1/logs
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://app.ziplogger.ai/v1/traces
```

Signal-specific endpoints take the **full path**, unlike the shared one. This trips up most first
attempts.

### Per-language notes

```bash
# Python: no code change
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
opentelemetry-instrument --logs_exporter otlp python app.py
```

```bash
# Java: the agent handles logs and traces together
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.logs.exporter=otlp -Dotel.traces.exporter=otlp \
     -jar app.jar
```

```csharp
// .NET
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;
    o.IncludeFormattedMessage = true;
    o.AddOtlpExporter();
});
```

```js
// Node.js
const { LoggerProvider, BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs')
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto')

const provider = new LoggerProvider()
provider.addLogRecordProcessor(new BatchLogRecordProcessor(new OTLPLogExporter()))
```

Log signal support varies by language and is less mature than tracing. Where it lags, use the
native ZipLogger SDK for logs and OTLP for traces. Mixing them is fine and common: the trace id
correlates the two.

## Or via the OTel Collector

```yaml
receivers:
  otlp:
    protocols:
      grpc:
      http:

processors:
  batch:
    timeout: 2s
    send_batch_size: 512
  resourcedetection:
    detectors: [env, system]

exporters:
  otlphttp/ziplogger:
    logs_endpoint: https://app.ziplogger.ai/v1/logs
    traces_endpoint: https://app.ziplogger.ai/v1/traces
    headers: { X-Api-Key: "zk_..." }
    compression: gzip
    retry_on_failure:
      enabled: true

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [resourcedetection, batch]
      exporters: [otlphttp/ziplogger]
    traces:
      receivers: [otlp]
      processors: [resourcedetection, batch]
      exporters: [otlphttp/ziplogger]
```

A Collector earns its place when you want one egress point, fan-out to more than one backend, or
enrichment and redaction before data leaves your network:

```yaml
processors:
  # strip anything you must not ship
  attributes/redact:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: user.email
        action: delete
  # stamp the deploy identity that powers regression attribution
  resource/build:
    attributes:
      - key: service.version
        value: ${env:RELEASE}
        action: upsert
      - key: vcs.ref.head.revision
        value: ${env:GIT_COMMIT}
        action: upsert
```

## How OTLP log records map

| OTLP | ZipLogger |
|---|---|
| `body` | `message` (structured bodies serialized to JSON) |
| `severityNumber` / `severityText` | `severity` (trace and debug become `debug`, then info, warn, error, fatal) |
| `timeUnixNano` (fallback `observedTimeUnixNano`) | `timestamp` |
| resource `service.name` | `source` |
| resource `service.version` | `release` |
| resource `vcs.ref.head.revision` / `service.commit.sha` / `commit.sha` | `commitSha` |
| resource `deployment.environment(.name)` | `fields.environment` |
| resource `host.name` | `fields.machineName` |
| attribute `exception.stacktrace` | `stackTrace` (feeds regression attribution) |
| attribute `exception.type` / `exception.message` | `fields.exceptionType` / `fields.exceptionMessage` |
| `traceId` / `spanId` | `fields.traceId` / `fields.spanId` (hex) |
| scope name, `eventName`, other attributes | preserved in `fields` |

Two of these rows are worth setting deliberately:

- **`service.version` and a commit attribute** are what make git regression attribution work. Set
  `vcs.ref.head.revision` (the current semantic-conventions name) in CI, or one of the accepted
  aliases.
- **`traceId`** arrives automatically when your logs are emitted inside a span, and it is what puts
  a **View trace** link on the log line.

## Responses

| Status | Meaning |
|---|---|
| `200` | Accepted. A `partialSuccess` body reports anything rejected |
| `400` | Invalid OTLP payload, with a `detail` field |
| `401` | Missing or invalid `X-Api-Key` |
| `415` | Content type is neither `application/x-protobuf` nor `application/json` |
| `429` | Quota exhausted, with `Retry-After` |

Partial success (queue backpressure) is reported per the OTLP spec in the response body
(`partialSuccess.rejectedLogRecords`, or `rejectedSpans` for traces) with HTTP 200; exporters retry
per their own policy.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives | The shared `OTEL_EXPORTER_OTLP_ENDPOINT` takes the origin; signal-specific variables take the full path. Mixing the two conventions is the usual cause. |
| `401` | Header syntax is `OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_...`, comma-separated for several headers, with no `Bearer`. |
| `415` | Set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (or `http/json`). gRPC is not accepted; use a Collector to translate. |
| Source shows as `unknown` | Set `OTEL_SERVICE_NAME` or the `service.name` resource attribute. |
| No regression attribution | No commit attribute. Set `vcs.ref.head.revision` in CI. |
| Logs arrive, traces do not | Traces need their own exporter and pipeline. See [tracing](tracing.md). |
| Quota exhausting quickly | Spans are metered with logs. Sample traces at the SDK. |
