# Log shippers — Fluent Bit / Vector

For apps you can't modify, tail files and container output with a log shipper — both talk to the
plain NDJSON endpoint.

## Fluent Bit

```ini
[INPUT]
    Name   tail
    Path   /var/log/app/*.log
    Tag    app

# the tail input emits "log"; ZipLogger expects "message"
[FILTER]
    Name   modify
    Match  *
    Rename log message

[OUTPUT]
    Name             http
    Match            *
    Host             app.ziplogger.me
    Port             443
    TLS              On
    URI              /ingest/v1/logs
    Format           json_lines
    Json_date_key    timestamp
    Json_date_format iso8601
    Header           X-Api-Key zk_...
```

## Vector

```toml
[sources.app]
type = "file"
include = ["/var/log/app/*.log"]

[transforms.shape]
type = "remap"
inputs = ["app"]
source = '''
.severity = "info"
.source = "legacy-app"
'''

[sinks.ziplogger]
type = "http"
inputs = ["shape"]
uri = "https://app.ziplogger.me/ingest/v1/logs"
encoding.codec = "json"
framing.method = "newline_delimited"
request.headers.X-Api-Key = "zk_..."
```

Vector's file source puts the line in `.message` already; Fluent Bit's tail input uses `log`,
hence the rename filter. Unknown JSON keys are ignored by the ingestion endpoint, so extra
metadata is harmless.
