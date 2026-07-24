# Python

A standard `logging` handler — batching, retries with backoff (429-aware), drop-on-backpressure,
and automatic enrichment. **Standard library only** — no dependencies.

## Install

```bash
pip install ziplogger
```

## Usage

```python
import logging
from ziplogger import ZipLoggerHandler

logging.basicConfig(level=logging.INFO)
logging.getLogger().addHandler(ZipLoggerHandler(
    endpoint="https://app.ziplogger.me",
    api_key="zk_...",
    source="billing-worker",          # optional; defaults to the script name
))

log = logging.getLogger("app.orders")
log.info("Order %s created", 83112, extra={"orderId": 83112, "customer": "acme"})

try:
    charge()
except Exception:
    log.exception("Payment failed")   # full traceback → ZipLogger's stackTrace field
```

- `extra={...}` values become searchable ZipLogger fields; the logger name becomes `category`.
- Exceptions logged with `log.exception(...)` / `exc_info=True` ship the full traceback, which
  feeds ZipLogger's git regression detection.
- Enrichment is automatic: `environment`, `machineName`, plus `release`/`commitSha` from the
  constructor or `ZIPLOGGER_RELEASE` / `ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` env vars.

## Behavior

A logging call never blocks and never raises. Entries go into a bounded in-memory queue
(default 10,000); a daemon thread batches them (default 100 per request, 2 s linger) and POSTs
NDJSON to `/ingest/v1/logs`. Transient failures (429 with `Retry-After`, 5xx, network) retry
with exponential backoff; non-transient responses and exhausted retries drop the batch and
increment `handler.dropped`. `logging.shutdown()` (automatic at exit) flushes the buffer.

## Options

| Parameter | Default | Purpose |
|---|---|---|
| `endpoint`, `api_key` | required | Server base URL + ingestion key |
| `source`, `release`, `commit_sha`, `environment`, `tags` | auto | Enrichment overrides |
| `queue_size` | 10000 | Max buffered entries (drops beyond) |
| `batch_size` / `flush_interval` | 100 / 2.0s | Batching |
| `max_retries`, `retry_base_delay`, `retry_max_delay` | 5 / 0.5s / 30s | Retry policy |
| `timeout` | 10.0s | Per-request HTTP timeout |
