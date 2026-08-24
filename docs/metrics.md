# Request metrics (APM)

The Metrics page charts average and p95 latency plus throughput per service. Two ways to feed it:
the ASP.NET Core middleware, or a plain JSON POST from any stack.

Metrics are deliberately narrow. They are timing series, not a full metrics system: one number per
event, with labels. Distributed tracing answers "why was this request slow", metrics answer "is the
service slower than yesterday".

## ASP.NET Core middleware

Package: `ZipLogger.Metrics.AspNetCore` (net8.0 and net10.0)

```csharp
builder.Services.AddZipLoggerMetrics(builder.Configuration, service: "orders-api");
var app = builder.Build();
app.UseZipLoggerMetrics();   // early, so timings cover the whole pipeline
```

It reuses your `ZipLogger:Endpoint` and `ZipLogger:ApiKey` configuration, so if logging is already
set up there is nothing else to configure. Override under `ZipLogger:Metrics` when metrics need a
different key or endpoint:

```json
{
  "ZipLogger": {
    "Endpoint": "https://app.ziplogger.dev",
    "ApiKey": "zk_...",
    "Metrics": {
      "Service": "orders-api",
      "ExcludePaths": [ "/health", "/favicon.ico", "/metrics" ]
    }
  }
}
```

Or configure entirely in code:

```csharp
builder.Services.AddZipLoggerMetrics(o =>
{
    o.Endpoint = "https://app.ziplogger.dev";
    o.ApiKey   = "zk_...";
    o.Service  = "orders-api";
    o.ExcludePaths.Add("/internal/ping");
});
```

Every request is timed and shipped with `method`, `route`, and `status` labels. The `route` label is
the route **pattern** (`/orders/{id}`), not the literal path, which keeps label cardinality low
enough to aggregate. Without that, a million order ids would become a million series.

### Options

| Option | Default | Purpose |
|---|---|---|
| `Endpoint`, `ApiKey` | from `ZipLogger:*` | Server origin and ingestion key |
| `Service` | entry assembly name | Service name on the Metrics page |
| `MetricName` | `request.duration` | Name of the emitted series |
| `ExcludePaths` | `/health`, `/favicon.ico` | Paths never timed, matched as prefixes |
| `IncludeLabels` | `true` | Attach `method` / `route` / `status`. Set `false` to emit a bare series |
| `QueueCapacity` | 10,000 | Max buffered measurements before dropping |
| `BatchSize` | 100 | Measurements per request |
| `FlushInterval` | 2 s | Linger before flushing a partial batch |
| `MaxRetries` | 3 | Retry attempts per batch |
| `RetryBaseDelay` / `RetryMaxDelay` | 500 ms / 10 s | Backoff bounds |
| `HttpTimeout` | 10 s | Per-request HTTP timeout |
| `ShutdownTimeout` | 5 s | Flush budget on shutdown |

Delivery follows the same rules as the log clients: bounded queue, batching, 429-aware retries,
drop-on-backpressure, and it **never blocks a request**. `MetricShipper.DroppedCount` exposes loss.
When endpoint or key are missing the whole thing no-ops, so a local run without configuration costs
nothing and needs no `#if DEBUG`.

### Custom metrics and background jobs

Request timings are only the default. Inject `ZipLoggerMetrics` to time anything:

```csharp
public sealed class NightlyReconciler(ZipLoggerMetrics metrics)
{
    public async Task RunAsync()
    {
        using (metrics.TimeJob("nightly-reconcile"))   // emits job.duration on dispose
        {
            await ReconcileAsync();
        }

        metrics.Record("queue.depth", depth);
        metrics.Record("payment.gateway.latency", elapsed.TotalMilliseconds,
            new Dictionary<string, object> { ["provider"] = "stripe", ["outcome"] = "ok" });
    }
}
```

- `Record(name, durationMs, labels?)` ships one measurement.
- `TimeJob(jobName, metricName = "job.duration")` returns an `IDisposable` that records elapsed time
  when disposed, including when the block throws.

Keep label values bounded. Provider names and outcomes are good labels; user ids and order ids are
not, for the same reason route patterns beat literal paths.

## Any other stack: POST the metrics endpoint

```
POST https://app.ziplogger.dev/ingest/v1/metrics
X-Api-Key: zk_...
Content-Type: application/json
```

Accepts a **single object** or a **JSON array**.

```bash
curl -X POST https://app.ziplogger.dev/ingest/v1/metrics \
  -H "X-Api-Key: zk_..." -H "Content-Type: application/json" \
  -d '[
    {"service":"orders-api","name":"request.duration","durationMs":142.7,
     "labels":{"method":"GET","route":"/orders/{id}","status":200}},
    {"service":"orders-api","name":"request.duration","durationMs":2310.4,
     "labels":{"method":"POST","route":"/orders","status":500},
     "traceId":"4bf92f3577b34da6a3ce929d0e0e4736"}
  ]'
```

### Fields

| Field | Type | Notes |
|---|---|---|
| `service` | string | Service name. Defaults to `unknown`, so always send it. |
| `name` | string | Metric name. Defaults to `request.duration`. |
| `durationMs` | number | The measurement, for latency-shaped metrics. |
| `value` | number | The measurement, for anything else. When `value` is absent or zero, `durationMs` is used as the value. |
| `timestamp` | ISO-8601 string | Defaults to receive time. |
| `labels` | object | Dimensions such as `method`, `route`, `status`. |
| `traceId` | string | Links the measurement to a trace. |

Response: `202` with `{"accepted": N}`. `401` for a missing or invalid key.

Metrics ingestion is **not metered against your log quota**, but keep the volume sane: send one
measurement per event, not one per millisecond.

### A minimal middleware in other languages

```python
# Flask / any WSGI app
import time, requests, threading

def record(service, route, method, status, ms):
    threading.Thread(target=lambda: requests.post(
        "https://app.ziplogger.dev/ingest/v1/metrics",
        headers={"X-Api-Key": "zk_..."},
        json={"service": service, "name": "request.duration", "durationMs": ms,
              "labels": {"method": method, "route": route, "status": status}},
        timeout=5), daemon=True).start()

@app.before_request
def _start(): request.environ["_t0"] = time.perf_counter()

@app.after_request
def _stop(response):
    ms = (time.perf_counter() - request.environ["_t0"]) * 1000
    # request.url_rule is the pattern, not the literal path: low cardinality
    record("billing-api", str(request.url_rule), request.method, response.status_code, ms)
    return response
```

```js
// Express
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    void fetch('https://app.ziplogger.dev/ingest/v1/metrics', {
      method: 'POST',
      headers: { 'X-Api-Key': 'zk_...', 'Content-Type': 'application/json' },
      // req.route?.path is the pattern; req.path would explode cardinality
      body: JSON.stringify({ service: 'web', name: 'request.duration', durationMs: ms,
        labels: { method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode } }),
    }).catch(() => {})
  })
  next()
})
```

Batch these in production rather than one request per request. The pattern to copy is in
[the HTTP API guide](http-api.md#writing-your-own-client).

## Reading metrics back

```
GET /api/v1/metrics/services?from=...&to=...
GET /api/v1/metrics/series?service=orders-api&name=request.duration&interval=5m&from=...&to=...
```

Both take a JWT, not an API key. Series returns `{ interval, buckets: [{ time, avg, p95, count }] }`.
See the [query API](query-api.md).

## Alerts on metrics

Latency alerting is driven by traces rather than these series, because traces carry the per-operation
detail a useful alert needs: a rule fires when an operation's p95 rises a chosen percentage above
its own 24-hour baseline. See [alerts and webhooks](alerts-webhooks.md) and
[tracing](tracing.md#what-tracing-unlocks).

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing on the Metrics page | Endpoint and key resolved? The package silently no-ops when either is missing, by design. |
| Service listed as `unknown` | Set `Service` (or `service` in the JSON payload). |
| Middleware timings look too low | `UseZipLoggerMetrics()` must run early, before the middleware you want included. |
| Too many series, charts unreadable | A label is high-cardinality. Use route patterns, not literal paths. |
| p95 flat but users report slowness | Check `ExcludePaths`, and confirm the slow path is not excluded. |
