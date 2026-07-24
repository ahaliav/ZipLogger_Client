# HTTP ingestion API

Anything that can POST JSON can ingest directly. Authentication is a per-tenant ingestion key
(create one under **Settings → API keys**), sent as the `X-Api-Key` header.

## Endpoint

```
POST https://app.ziplogger.me/ingest/v1/logs
X-Api-Key: zk_...
Content-Type: application/json      (or application/x-ndjson)
```

Accepts a **single object**, a **JSON array**, or **NDJSON** (one JSON object per line — what the
official SDKs send).

```bash
curl -X POST https://app.ziplogger.me/ingest/v1/logs \
  -H "X-Api-Key: zk_..." \
  -H "Content-Type: application/json" \
  -d '{"message":"hello","severity":"info","source":"cron-job"}'
```

## Entry fields

| Field | Type | Notes |
|---|---|---|
| `message` | string | **Required.** The log line. |
| `timestamp` | ISO-8601 string | Defaults to receive time. |
| `severity` | string | `debug`, `info` (default), `warn`, `error`, `fatal`. |
| `source` | string | Service/app name — drives filtering and dashboards. |
| `release` | string | Version of the running build. |
| `commitSha` | string | Git commit of the running build — powers regression attribution. |
| `stackTrace` | string | Exception stack trace — feeds "which commit broke this?" analysis. |
| `fields` | object | Arbitrary key/values, all searchable (e.g. `orderId`, `traceId`). |
| `tags` | string[] | Free-form labels. |

Unknown keys are ignored, so shippers can pass extra metadata harmlessly.

## Responses

| Status | Meaning |
|---|---|
| `202` | Accepted into the ingestion pipeline. |
| `400` | Malformed payload (e.g. missing `message`). |
| `401` | Missing/invalid `X-Api-Key`. |
| `429` | Daily quota exhausted or backpressure — retry after the `Retry-After` header (seconds). |

## Quotas

Each plan includes a daily log quota; `429` responses carry a `Retry-After` header pointing at
the next UTC midnight. Official SDKs honor it automatically — your application is never blocked
by an exhausted quota. See [pricing](https://ziplogger.me/pricing.html) for plan limits.
