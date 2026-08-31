# Python

A standard `logging` handler: batching, retries with backoff (429-aware), drop-on-backpressure, and
automatic enrichment. **Standard library only**, no dependencies.

Because it is an ordinary `logging.Handler`, every library in your process that uses `logging`
starts shipping the moment you attach it. You do not instrument call sites.

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
    endpoint="https://app.ziplogger.ai",
    api_key="zk_...",
    source="billing-worker",          # optional; defaults to the script name
))

log = logging.getLogger("app.orders")
log.info("Order %s created", 83112, extra={"orderId": 83112, "customer": "acme"})

try:
    charge()
except Exception:
    log.exception("Payment failed")   # full traceback to ZipLogger's stackTrace field
```

- `extra={...}` values become searchable ZipLogger fields, and the logger name becomes `category`.
- Exceptions logged with `log.exception(...)` or `exc_info=True` ship the full traceback, which
  feeds git regression detection.
- Enrichment is automatic: `environment`, `machineName`, plus `release` and `commitSha` from the
  constructor or the `ZIPLOGGER_RELEASE` / `ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` variables.

Use `%s` formatting rather than f-strings. `log.info("Order %s created", order_id)` keeps one
message template that ZipLogger can cluster and count; `log.info(f"Order {order_id} created")`
produces a distinct message per order and ruins pattern grouping.

### Field types

Field values that are not `str`, `int`, `float`, `bool`, or `None` are stringified before they are
sent, so dataclasses and model objects arrive as their `repr`. Pass the pieces you want to query on
explicitly:

```python
# searchable numbers and strings
log.info("Order created", extra={"orderId": order.id, "total": float(order.total),
                                 "currency": order.currency})
```

Avoid `extra` keys that collide with `LogRecord` attributes (`message`, `module`, `args`,
`process`, and friends). The handler skips reserved names rather than overwriting them.

## Configuration via dictConfig

Most real projects configure logging declaratively. The handler works as any other:

```python
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "plain"},
        "ziplogger": {
            "class": "ziplogger.ZipLoggerHandler",
            "level": "INFO",
            "endpoint": "https://app.ziplogger.ai",
            "api_key": os.environ["ZIPLOGGER_API_KEY"],
            "source": "web",
        },
    },
    "root": {"level": "INFO", "handlers": ["console", "ziplogger"]},
    "loggers": {
        # keep the noise local, ship the signal
        "django.db.backends": {"level": "WARNING", "handlers": ["console"], "propagate": False},
    },
}
```

Attaching the handler only when a key is present keeps local development quiet:

```python
handlers = ["console"]
if os.environ.get("ZIPLOGGER_API_KEY"):
    handlers.append("ziplogger")
```

## Recipes

### Django

Put the `LOGGING` dict above in `settings.py`. Django's own error logging (`django.request`) then
ships with tracebacks, which is exactly what you want for regression attribution.

To stamp request context onto every record, combine a middleware with a `logging.Filter`. A filter
can add attributes to the record, and the handler turns them into fields:

```python
import contextvars, logging

_request = contextvars.ContextVar("zl_request", default={})

class RequestContextFilter(logging.Filter):
    def filter(self, record):
        for key, value in _request.get().items():
            setattr(record, key, value)
        return True

class ZipLoggerContextMiddleware:
    def __init__(self, get_response): self.get_response = get_response

    def __call__(self, request):
        _request.set({"path": request.path, "method": request.method,
                      "userId": getattr(request.user, "id", None)})
        try:
            return self.get_response(request)
        finally:
            _request.set({})
```

Register the filter on the `ziplogger` handler in your `LOGGING` dict
(`"filters": {"reqctx": {"()": "myapp.logging.RequestContextFilter"}}`, then
`"handlers": {"ziplogger": {..., "filters": ["reqctx"]}}`).

### Flask and FastAPI

```python
import logging
from ziplogger import ZipLoggerHandler

handler = ZipLoggerHandler(endpoint="https://app.ziplogger.ai",
                          api_key=os.environ["ZIPLOGGER_API_KEY"], source="api")
logging.getLogger().addHandler(handler)
logging.getLogger().setLevel(logging.INFO)

# FastAPI/Uvicorn: also capture the server's own loggers
for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    logging.getLogger(name).addHandler(handler)
```

Unhandled exceptions in a Flask or FastAPI view are logged by the framework at error level with a
traceback, so they arrive without extra work.

### Celery

Celery replaces logging configuration by default. Opt out and attach the handler yourself:

```python
from celery.signals import setup_logging, after_setup_logger

@setup_logging.connect
def _no_hijack(**kwargs):
    pass   # keep our dictConfig

@after_setup_logger.connect
def _attach(logger, **kwargs):
    logger.addHandler(ZipLoggerHandler(endpoint=..., api_key=..., source="worker"))
```

### Gunicorn and uWSGI: fork safety

The handler starts a daemon thread in the process that creates it. A pre-fork server that
instantiates it in the master **before** forking leaves workers with a queue whose worker thread
does not exist in the child, so entries buffer and never ship.

Create the handler after the fork:

```python
# gunicorn.conf.py
def post_fork(server, worker):
    import logging
    from ziplogger import ZipLoggerHandler
    logging.getLogger().addHandler(ZipLoggerHandler(
        endpoint="https://app.ziplogger.ai", api_key=os.environ["ZIPLOGGER_API_KEY"],
        source=f"web"))
```

The same rule applies to `multiprocessing` workers: configure logging inside the child, not in the
parent.

### Scripts, cron jobs, and notebooks

`logging.shutdown()` runs automatically at interpreter exit and flushes. For a process killed with
`SIGKILL`, or a notebook kernel you restart, nothing can flush, so lower the linger if the job is
very short:

```python
handler = ZipLoggerHandler(..., flush_interval=0.25)
```

## Severity mapping

| Python level | ZipLogger severity |
|---|---|
| `DEBUG` (and below) | `debug` |
| `INFO` | `info` |
| `WARNING` | `warn` |
| `ERROR` | `error` |
| `CRITICAL` | `fatal` |

Custom levels map by numeric value: below `WARNING` becomes `info`, at or above becomes `error`.

## Behavior

A logging call never blocks and never raises. Entries go into a bounded in-memory queue (default
10,000); a daemon thread batches them (default 100 per request, 2 s linger) and POSTs NDJSON to
`/ingest/v1/logs`. Transient failures (429 with `Retry-After`, 5xx, network) retry with exponential
backoff; non-transient responses and exhausted retries drop the batch and increment
`handler.dropped`. `logging.shutdown()`, which runs at exit, flushes the buffer.

Watch `handler.dropped` in long-running services. A non-zero value means real loss, either from a
full queue or from an unreachable endpoint:

```python
if handler.dropped:
    print(f"ziplogger dropped {handler.dropped} entries", file=sys.stderr)
```

## Options

| Parameter | Default | Purpose |
|---|---|---|
| `endpoint`, `api_key` | required | Server origin and ingestion key |
| `source` | script name | Service name |
| `release`, `commit_sha` | env vars | Build identity, powers regression attribution |
| `environment` | `production` | Deployment environment |
| `tags` | none | Tags added to every entry |
| `queue_size` | 10000 | Max buffered entries (drops beyond) |
| `batch_size` | 100 | Entries per request |
| `flush_interval` | 2.0 s | Linger before flushing a partial batch |
| `max_retries` | 5 | Retry attempts per batch |
| `retry_base_delay` | 0.5 s | First backoff delay |
| `retry_max_delay` | 30 s | Backoff ceiling |
| `timeout` | 10.0 s | Per-request HTTP timeout |
| `level` | `NOTSET` | Handler-level filter |

`endpoint` and `api_key` are validated in the constructor: a missing value raises `ValueError` at
startup rather than failing silently later.

## Tracing

For distributed traces, use OpenTelemetry auto-instrumentation and point it at ZipLogger; there is
nothing ZipLogger-specific to install:

```bash
pip install opentelemetry-distro opentelemetry-exporter-otlp
opentelemetry-bootstrap -a install
OTEL_EXPORTER_OTLP_ENDPOINT=https://app.ziplogger.ai \
OTEL_EXPORTER_OTLP_HEADERS=X-Api-Key=zk_... \
OTEL_SERVICE_NAME=billing-api \
  opentelemetry-instrument gunicorn app:wsgi
```

Then stamp the trace id onto your logs so each line links to its waterfall. See
[tracing](tracing.md#correlating-logs-with-traces).

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing arrives | The root logger's level. `addHandler` does not change it, so `INFO` records are filtered before the handler sees them. |
| Nothing arrives under gunicorn or uWSGI | The handler was created before the fork. See fork safety above. |
| Nothing arrives from Celery | Celery hijacked logging. Connect `setup_logging` as shown. |
| Fields missing | They must go in `extra={...}`, and reserved `LogRecord` names are skipped. |
| Fields arrive as strings | Only str/int/float/bool/None pass through untouched; everything else is stringified. |
| `handler.dropped` climbing | Queue full or endpoint unreachable. Check the key, then raise `batch_size`. |
| Every message is its own pattern | f-strings instead of `%s` formatting. |
