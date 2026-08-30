# Go

A standard-library-only client with a first-class `log/slog` handler. Batching, retry with backoff
(429-aware), drop-on-backpressure, automatic enrichment. Go 1.21 or newer, zero dependencies.

```bash
go get github.com/ziploggerhq/ZipLogger_Client/sdk_go
```

```go
import ziplogger "github.com/ziploggerhq/ZipLogger_Client/sdk_go"
```

## slog (recommended)

```go
client, err := ziplogger.New(ziplogger.Options{
    Endpoint: "https://app.ziplogger.dev",
    APIKey:   os.Getenv("ZIPLOGGER_API_KEY"),
    Source:   "orders-api",
})
if err != nil { panic(err) }
defer client.Close(5 * time.Second)

logger := slog.New(ziplogger.NewSlogHandler(client, slog.LevelInfo))
slog.SetDefault(logger)   // so every package's slog calls ship too

logger.Info("order created", "orderId", 83112, "customer", "acme")
logger.Error("payment failed", "err", err)   // err becomes stackTrace + exception fields
```

`New` returns an error only for a missing endpoint or key, so a config mistake surfaces at startup
rather than as silent loss later.

### Errors

An attribute keyed `err` or `error` whose value is an `error` is special-cased: it populates the
entry's error rather than becoming an ordinary field, which is what produces `stackTrace`,
`fields.exceptionType`, and `fields.exceptionMessage`.

```go
logger.Error("payment failed", "err", err)       // recognized
logger.Error("payment failed", "cause", err)     // just a field, no stack trace
```

To get a real stack trace rather than just the error message, wrap with something that captures
one and set `StackTrace` explicitly on a direct `Entry`. A plain `error` only carries its message.

### Attributes and groups

`With` and `WithGroup` behave as the `slog` contract requires, and groups become dotted field
names, which keeps them readable in search:

```go
reqLog := logger.With("requestId", id).WithGroup("http")
reqLog.Info("handled", "method", "GET", "status", 200)
// fields: requestId, http.method, http.status
```

A logger built with `With` is the idiomatic way to carry request context in Go: build it once per
request, pass it down, and every line inherits the fields.

### Level mapping

| slog level | ZipLogger severity |
|---|---|
| below `LevelInfo` | `debug` |
| `LevelInfo` | `info` |
| `LevelWarn` | `warn` |
| `LevelError` to `LevelError+3` | `error` |
| `LevelError+4` and above | `fatal` |

The handler's own level argument filters before anything is queued, so debug logs you do not want
never cost quota.

## Direct client

```go
client.Log(ziplogger.Entry{
    Severity: "error",
    Message:  "job failed",
    Err:      err,
    Fields:   map[string]any{"jobId": 42},
})
```

`Entry` fields: `Timestamp`, `Severity`, `Message`, `Source`, `Release`, `CommitSha`, `StackTrace`,
`Err`, `Fields`, `Tags`. Anything left zero falls back to the client's enrichment.

## Recipes

### net/http middleware

```go
func WithLogging(logger *slog.Logger, next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        rec := &statusRecorder{ResponseWriter: w, status: 200}
        next.ServeHTTP(rec, r)

        reqLog := logger.With(
            "method", r.Method,
            "route", routePattern(r),   // the pattern, not the raw path: low cardinality
            "status", rec.status,
            "durationMs", time.Since(start).Milliseconds(),
        )
        if rec.status >= 500 {
            reqLog.Error("request failed")
        } else {
            reqLog.Info("request handled")
        }
    })
}
```

### Panics

A panic in a handler bypasses your logging entirely unless you recover:

```go
defer func() {
    if r := recover(); r != nil {
        client.Log(ziplogger.Entry{
            Severity:   "fatal",
            Message:    fmt.Sprintf("panic: %v", r),
            StackTrace: string(debug.Stack()),   // the real stack, which regression analysis needs
        })
        client.Close(2 * time.Second)
        panic(r)
    }
}()
```

`debug.Stack()` is the one place Go gives you a full stack trace, so this recipe is worth having in
every long-running service. It is what turns a panic into a "which commit broke this?" answer.

### Graceful shutdown

```go
ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
defer stop()
<-ctx.Done()

_ = srv.Shutdown(context.Background())
client.Close(5 * time.Second)   // bounded flush; never blocks exit indefinitely
```

`Close` flushes what is buffered, up to the timeout you pass, and is idempotent: a second call
returns immediately, so a `defer` plus an explicit call in a signal handler is safe.

### Proxies, custom transports, and tests

`Options.HTTPClient` replaces the default client outright, which is the hook for corporate proxies,
custom TLS, and tests:

```go
client, _ := ziplogger.New(ziplogger.Options{
    Endpoint:   "https://app.ziplogger.dev",
    APIKey:     "zk_...",
    HTTPClient: &http.Client{Timeout: 3 * time.Second, Transport: myTransport},
})
```

```go
// in tests, point at a stub and assert on what was shipped
srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    received = append(received, string(body))
    w.WriteHeader(http.StatusAccepted)
}))
client, _ := ziplogger.New(ziplogger.Options{Endpoint: srv.URL, APIKey: "test"})
```

Note that when `HTTPClient` is set, its own `Timeout` governs requests rather than
`Options.Timeout`.

### CLI tools and short-lived jobs

```go
client, _ := ziplogger.New(ziplogger.Options{
    Endpoint:      endpoint,
    APIKey:        key,
    FlushInterval: 250 * time.Millisecond,
})
defer client.Close(3 * time.Second)
```

Without the explicit `Close`, a process that exits inside the 2 s linger loses the batch.

## Behavior

`Log` never blocks and never panics. Entries buffer in a bounded channel (default 10,000), ship as
NDJSON batches (default 100 per request, 2 s linger) to `/ingest/v1/logs`, retry transient failures
(429 honoring `Retry-After`, 5xx, network) with exponential backoff, and drop with a counter
(`client.Dropped()`) when the queue overflows or retries exhaust.

Every entry is enriched with `environment`, `machineName`, and, from `ZIPLOGGER_RELEASE` /
`ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` or `Options`, the release and commit SHA that power
ZipLogger's git regression detection.

Export `Dropped()` somewhere you will notice it:

```go
go func() {
    for range time.Tick(time.Minute) {
        if n := client.Dropped(); n > 0 {
            fmt.Fprintf(os.Stderr, "ziplogger dropped %d entries\n", n)
        }
    }
}()
```

## Options

| Option | Default | Purpose |
|---|---|---|
| `Endpoint` | required | Server origin. `/ingest/v1/logs` is appended unless it already ends in `/logs` |
| `APIKey` | required | Ingestion key, sent as `X-Api-Key` |
| `Source` | executable name | Service name (or `ZIPLOGGER_SOURCE`) |
| `Release` | `ZIPLOGGER_RELEASE` | Build version |
| `CommitSha` | `ZIPLOGGER_COMMIT_SHA`, `GIT_COMMIT`, `COMMIT_SHA` | Commit of the running build |
| `Environment` | `ZIPLOGGER_ENVIRONMENT` or `production` | Deployment environment |
| `Tags` | none | Tags added to every entry |
| `QueueCapacity` | 10000 | Max buffered entries |
| `BatchSize` | 100 | Entries per request |
| `FlushInterval` | 2 s | Linger before flushing a partial batch |
| `MaxRetries` | 5 | Retry attempts per batch |
| `RetryBaseDelay` / `RetryMaxDelay` | 500 ms / 30 s | Backoff bounds |
| `Timeout` | 10 s | Per-request HTTP timeout |
| `HTTPClient` | none | Replace the default client (proxies, tests) |

Zero values take the documented defaults, so you only set what you mean to change.

### Injecting release and commit at build time

```bash
go build -ldflags "-X main.commit=$(git rev-parse HEAD)" ./...
```

```go
var commit string   // set by -ldflags

client, _ := ziplogger.New(ziplogger.Options{
    Endpoint: endpoint, APIKey: key, CommitSha: commit,
})
```

Or set `ZIPLOGGER_COMMIT_SHA` in the environment and skip the wiring. See the
[configuration reference](configuration.md).

## Tracing

Go has no auto-instrumentation agent, so traces are wired in code with the standard OTel packages:

```go
exp, _ := otlptracehttp.New(ctx,
    otlptracehttp.WithEndpoint("app.ziplogger.dev"),
    otlptracehttp.WithHeaders(map[string]string{"X-Api-Key": key}),
)
tp := sdktrace.NewTracerProvider(
    sdktrace.WithBatcher(exp),
    sdktrace.WithResource(resource.NewWithAttributes(semconv.SchemaURL,
        semconv.ServiceName("orders-api"))),
)
otel.SetTracerProvider(tp)

// wrap handlers and clients
handler := otelhttp.NewHandler(mux, "server")
```

Then add the trace id to your log fields so lines link to waterfalls:

```go
sc := trace.SpanContextFromContext(ctx)
logger.Error("payment failed", "err", err, "traceId", sc.TraceID().String())
```

See [tracing](tracing.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| `ziplogger: Endpoint is required` | `New` validates up front. Check your env plumbing. |
| Nothing arrives from a short program | Add `defer client.Close(...)`; a process that exits inside the linger loses the batch. |
| No `stackTrace` on errors | The attribute must be keyed `err` or `error`, and hold an `error` value. |
| Group fields look wrong | `WithGroup` dots the keys (`http.method`). Search for the dotted name. |
| `Options.Timeout` seems ignored | You supplied `HTTPClient`; its own `Timeout` wins. |
| `Dropped()` climbing | Queue full or endpoint unreachable. Verify the key, then raise `BatchSize`. |
