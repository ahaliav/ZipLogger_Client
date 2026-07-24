# OpenTelemetry (OTLP)

ZipLogger exposes a native **OTLP/HTTP logs receiver** at `POST /v1/logs` (alias:
`POST /ingest/v1/otlp/logs`) accepting standard `ExportLogsServiceRequest` payloads as
`application/x-protobuf` or `application/json`, optionally gzip-encoded. Any OTel SDK or
Collector can export to it — no ZipLogger code in your services.

## Point an OTel SDK exporter at ZipLogger

```bash
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.me   # exporter appends /v1/logs
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_...
```

## Or via the OTel Collector

```yaml
exporters:
  otlphttp/ziplogger:
    logs_endpoint: https://app.ziplogger.me/v1/logs
    headers: { X-Api-Key: "zk_..." }
```

## How OTLP records map

| OTLP | ZipLogger |
|---|---|
| `body` | `message` (structured bodies serialized to JSON) |
| `severityNumber` / `severityText` | `severity` (trace/debug→debug, info, warn, error, fatal) |
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

Partial success (queue backpressure) is reported per the OTLP spec in the response body
(`partialSuccess.rejectedLogRecords`) with HTTP 200; exporters retry per their own policy.
