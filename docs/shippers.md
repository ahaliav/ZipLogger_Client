# Log shippers (Fluent Bit / Vector)

For apps you cannot modify, tail files and container output with a log shipper. Both talk to the
plain NDJSON endpoint, so no ZipLogger-specific plugin is needed.

Three rules cover almost every problem people hit:

1. **The line must end up in `message`.** Fluent Bit's tail input calls it `log`; Vector's file
   source already calls it `message`.
2. **Unknown top-level keys are dropped.** Metadata must be nested under `fields` to be searchable.
   This is the one that silently loses pod names and container ids.
3. **Set `severity` yourself.** Anything ZipLogger does not recognize becomes `info`, so an
   unmapped pipeline turns your errors into info-level noise and no alert ever fires.

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
    Host             app.ziplogger.ai
    Port             443
    TLS              On
    URI              /ingest/v1/logs
    Format           json_lines
    Json_date_key    timestamp
    Json_date_format iso8601
    Header           X-Api-Key zk_...
```

### Adding severity and source

```ini
[FILTER]
    Name   modify
    Match  *
    Rename log message
    Set    source legacy-app
    Set    severity info

# promote real errors so alerts and the error view work
[FILTER]
    Name      modify
    Match     *
    Condition Key_value_matches message (?i)(error|exception|fatal|panic)
    Set       severity error
```

Regex-guessing severity is a stopgap. If the app can emit JSON, parse it instead and map the real
level:

```ini
[FILTER]
    Name    parser
    Match   *
    Key_Name log
    Parser   json_app
    Reserve_Data On

# [PARSER] in parsers.conf
# Name json_app
# Format json
# Time_Key ts
# Time_Format %Y-%m-%dT%H:%M:%S.%L%z
```

### Nesting metadata into fields

Kubernetes and Docker filters add top-level keys, which ZipLogger ignores. Nest them so they become
searchable:

```ini
[FILTER]
    Name   kubernetes
    Match  kube.*
    Merge_Log On

# move everything except the fields ZipLogger knows into fields{}
[FILTER]
    Name         nest
    Match        *
    Operation    nest
    Wildcard     kubernetes
    Wildcard     container_name
    Wildcard     pod_name
    Nest_under   fields
```

After this, `fields.kubernetes.pod_name` is searchable and shows up on the log detail panel.

### Stack traces: multiline is not optional

Without a multiline parser, a 30-frame Java stack trace becomes 30 separate log entries. You lose
the trace, the error clustering is wrong, and you burn 30 times the quota.

```ini
[INPUT]
    Name                tail
    Path                /var/log/app/*.log
    Tag                 app
    multiline.parser    java          # also: go, python, ruby, dotnet
```

For a custom format, define your own:

```ini
[MULTILINE_PARSER]
    Name          app_trace
    Type          regex
    Flush_Timeout 1000
    Rule          "start_state"  "/^\d{4}-\d{2}-\d{2}/"  "cont"
    Rule          "cont"         "/^\s+at\s/"            "cont"
```

Once the frames are joined, move them into `stackTrace` so regression attribution can parse them:

```ini
[FILTER]
    Name   modify
    Match  *
    Copy   message stackTrace
```

`stackTrace` is the field the "which commit broke this?" analysis reads. A stack trace stuck inside
`message` is searchable but not attributable.

### Kubernetes DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: fluent-bit, namespace: logging }
spec:
  selector: { matchLabels: { app: fluent-bit } }
  template:
    metadata: { labels: { app: fluent-bit } }
    spec:
      serviceAccountName: fluent-bit
      containers:
        - name: fluent-bit
          image: cr.fluentbit.io/fluent/fluent-bit:latest
          env:
            - name: ZIPLOGGER_API_KEY
              valueFrom: { secretKeyRef: { name: ziplogger, key: apiKey } }
          volumeMounts:
            - { name: varlog, mountPath: /var/log }
            - { name: config, mountPath: /fluent-bit/etc/ }
      volumes:
        - { name: varlog, hostPath: { path: /var/log } }
        - { name: config, configMap: { name: fluent-bit-config } }
```

```ini
[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    multiline.parser  cri
    Tag               kube.*

[FILTER]
    Name   kubernetes
    Match  kube.*
    Merge_Log On

[OUTPUT]
    Name    http
    Match   *
    Host    app.ziplogger.ai
    Port    443
    TLS     On
    URI     /ingest/v1/logs
    Format  json_lines
    Json_date_key    timestamp
    Json_date_format iso8601
    Header  X-Api-Key ${ZIPLOGGER_API_KEY}
```

Keep the key in a `Secret` and reference it as an environment variable, not in the ConfigMap.

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
uri = "https://app.ziplogger.ai/ingest/v1/logs"
encoding.codec = "json"
framing.method = "newline_delimited"
request.headers.X-Api-Key = "zk_..."
```

Vector's file source puts the line in `.message` already; Fluent Bit's tail input uses `log`, hence
the rename filter.

### A fuller Vector pipeline

VRL makes the nesting and severity mapping explicit, which is why Vector is the easier of the two to
get right:

```toml
[transforms.shape]
type = "remap"
inputs = ["app"]
source = '''
# parse app JSON when present, fall back to the raw line
parsed, err = parse_json(.message)
if err == null {
  .message  = string!(parsed.msg ?? parsed.message ?? .message)
  .severity = downcase(string!(parsed.level ?? "info"))
  .fields   = object!(parsed) # everything else stays searchable
} else {
  .severity = "info"
}

# ZipLogger accepts debug/info/warn/error/fatal; anything else becomes info
if .severity == "warning" { .severity = "warn" }
if .severity == "critical" || .severity == "crit" { .severity = "fatal" }
if !includes(["debug","info","warn","error","fatal"], .severity) { .severity = "info" }

.source     = "legacy-app"
.release    = get_env_var("RELEASE") ?? null
.commitSha  = get_env_var("GIT_COMMIT") ?? null
.timestamp  = format_timestamp!(now(), format: "%+")

# host metadata belongs in fields, not at the top level
.fields = merge(object(.fields) ?? {}, { "host": .host, "file": .file })
del(.host)
del(.file)
'''
```

Add batching and compression at the sink for volume:

```toml
[sinks.ziplogger]
type = "http"
inputs = ["shape"]
uri = "https://app.ziplogger.ai/ingest/v1/logs"
encoding.codec = "json"
framing.method = "newline_delimited"
compression = "gzip"
request.headers.X-Api-Key = "${ZIPLOGGER_API_KEY}"
batch.max_events = 100
batch.timeout_secs = 2
buffer.type = "disk"          # survives a Vector restart
buffer.max_size = 268435488
```

A disk buffer is the one advantage a shipper has over an in-process SDK: it survives a restart of
the shipper itself.

### Multiline in Vector

```toml
[sources.app]
type = "file"
include = ["/var/log/app/*.log"]
multiline.start_pattern = '^\d{4}-\d{2}-\d{2}'
multiline.condition_pattern = '^\s+(at|\.\.\.)\s'
multiline.mode = "continue_through"
multiline.timeout_ms = 1000
```

### Kubernetes

```toml
[sources.kube]
type = "kubernetes_logs"

[transforms.shape]
type = "remap"
inputs = ["kube"]
source = '''
.source   = string!(.kubernetes.container_name ?? "unknown")
.severity = "info"
.fields   = { "pod": .kubernetes.pod_name, "namespace": .kubernetes.pod_namespace,
              "node": .kubernetes.pod_node_name }
del(.kubernetes)
'''
```

## Other shippers

Anything that can POST NDJSON works, since the endpoint has no shipper-specific requirements:

- **Logstash:** an `http` output with `format => json_batch` and the `X-Api-Key` header. Rename
  `@timestamp` to `timestamp` and `event.original` to `message` in a `mutate` filter.
- **rsyslog:** `omhttp` with `template` producing the JSON shape.
- **journald:** Fluent Bit's `systemd` input, then the same filters. Map `MESSAGE` to `message` and
  `PRIORITY` to a severity.
- **Anything else:** see [the HTTP API](http-api.md), which documents the payload and the response
  body.

## Shipper or SDK?

Use a shipper when the app cannot be changed, when you need a disk buffer that survives restarts,
or when one agent must serve many workloads on a node. Use an SDK when you can, because it gets you
things a shipper cannot reconstruct from a text line: `release` and `commitSha` from the build,
exceptions already separated into `stackTrace`, structured fields with real types, and trace ids
that link a log to its waterfall.

Running both is normal: SDKs in your own services, a shipper for the third-party containers next to
them.

## Troubleshooting

| Symptom | Check |
|---|---|
| Entries arrive with an empty message | The line is still in `log` (Fluent Bit). Rename it to `message`. |
| Pod and container metadata missing | Top-level keys are dropped. Nest them under `fields`. |
| Everything is `info` | No severity mapping. Unrecognized values silently become `info`. |
| One stack trace becomes 30 entries | No multiline parser on the input. |
| Regression attribution never finds anything | The trace is inside `message`. Copy it into `stackTrace`. |
| `400` from the endpoint | Not newline-delimited. Fluent Bit needs `Format json_lines`; Vector needs `framing.method = "newline_delimited"`. |
| `429` | Quota exhausted. Filter noisy sources at the shipper, which is cheaper than filtering after ingestion. |
| Quota gone in an hour | A shipper tailing everything, including debug and access logs. Exclude at the input. |
