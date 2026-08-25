# ziplogger (Go)

Go SDK for [ZipLogger](https://ziplogger.dev) — a standard-library-only client
with a first-class `log/slog` handler. Batching, retry with backoff (429-aware),
drop-on-backpressure, automatic enrichment. Go ≥ 1.21.

```bash
go get github.com/ahaliav/ZipLogger_Client/sdk_go
```

## slog (recommended)

```go
client, err := ziplogger.New(ziplogger.Options{
    Endpoint: "https://app.ziplogger.dev",
    APIKey:   "zk_...",
})
if err != nil { panic(err) }
defer client.Close(5 * time.Second)

logger := slog.New(ziplogger.NewSlogHandler(client, slog.LevelInfo))
logger.Info("order created", "orderId", 83112, "customer", "acme")
logger.Error("payment failed", "err", err)   // err → stackTrace + exception fields
```

## Direct client

```go
client.Log(ziplogger.Entry{
    Severity: "error",
    Message:  "job failed",
    Err:      err,
    Fields:   map[string]any{"jobId": 42},
})
```

## Behavior

`Log` never blocks and never panics. Entries buffer in a bounded channel (default 10,000), ship
as NDJSON batches (default 100 per request, 2s linger) to `/ingest/v1/logs`, retry transient
failures (429 honoring `Retry-After`, 5xx, network) with exponential backoff, and drop with a
counter (`client.Dropped()`) when the queue overflows or retries exhaust. Every entry is
enriched with `environment`, `machineName`, and — from `ZIPLOGGER_RELEASE` /
`ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` env vars or `Options` — the release and commit SHA that
power ZipLogger's git regression detection.
