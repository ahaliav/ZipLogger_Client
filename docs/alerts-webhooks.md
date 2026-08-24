# Alerts and webhooks

Alert rules are configured in the app under **Alerts**. This page documents the parts you write
code against: the webhook payload your endpoint receives, and the sandboxed script API.

## Conditions

A rule evaluates over a sliding window and fires on one of:

| Condition | Fires when |
|---|---|
| `CountGt` | Matching events in the window exceed the threshold |
| `CountLt` | Matching events fall below the threshold |
| `NoData` | Nothing matched at all, which is how a service going quiet shows up |
| `ServiceDown` | An active health check is failing |
| `LatencyIncrease` | An operation's p95 latency rises a chosen percentage above its own 24-hour baseline, per service or per route (powered by traces) |
| `TrafficSpike` | An absolute cap is crossed, for example more than 500 requests to `/api/orders` in a minute |
| `TrafficIncrease` | A relative cap is crossed, for example 3x normal traffic |

Count rules filter by severity and by the same [query syntax](mcp.md#query-syntax) as Search.
Traffic rules can be narrowed by service, endpoint, or any span attribute (method, path, status
code, user agent), each with a triage severity.

**A rule fires once when the threshold is crossed and once on recovery.** It does not re-notify
every evaluation while the condition persists, so a sustained outage produces two messages rather
than a hundred.

## Channels

| Channel | Notes |
|---|---|
| Email | One or more comma-separated addresses. Works out of the box. |
| Webhook | HTTP POST with a Slack-compatible body. Slack, Discord, Mattermost, or your own endpoint. |
| SMS and voice call | Works immediately through the built-in sender, or with your own Twilio account (**Settings → Alert notifications**). Calls read the alert aloud. Message text is capped at 150 characters. |
| Custom script | Sandboxed JavaScript on every state change: page PagerDuty, open a ticket, call any API. |

A custom message on the rule (a runbook link, who to wake) is included in every channel.

**Allowances.** Every plan includes 20 voice calls, 50 SMS, and 100 emails per workspace per month.
Past that, sends draw from prepaid credits. Connecting your own Twilio account makes phone
notifications unmetered by ZipLogger.

## Webhook payload

The POST body is intentionally Slack-compatible, so Slack, Discord, and Mattermost incoming
webhooks work with no translation layer:

```json
{
  "text": ":rotating_light: *Checkout errors* FIRING\nCount of errors in checkout-api is 143 (threshold: 50)\nRunbook: https://wiki.internal/checkout"
}
```

The shape is always a single `text` string:

- Line 1: an emoji (`:rotating_light:` firing, `:large_green_circle:` resolved), the rule name in
  Slack bold, then `FIRING` or `RESOLVED`.
- Line 2: a generated summary of what crossed which threshold.
- Line 3: your custom message, when the rule has one.

Parsing prose is fragile. If you need structured data, use a **custom script** instead and POST
whatever shape your system wants.

### Receiving it yourself

```js
// Express
app.post('/hooks/ziplogger', (req, res) => {
  const text = req.body.text ?? ''
  const firing = text.includes('FIRING')
  const [firstLine, ...rest] = text.split('\n')
  page({ firing, title: firstLine.replace(/[*:]/g, '').trim(), detail: rest.join(' ') })
  res.sendStatus(200)   // any 2xx; non-2xx is logged and not retried
})
```

Requirements for the endpoint:

- **Publicly reachable over http(s).** URLs pointing at `localhost`, `.local`, `.internal`,
  private ranges, or cloud metadata addresses are rejected, since the request originates inside
  ZipLogger's network. DNS is resolved at send time, so a public name pointing at a private
  address is rejected too.
- **Answer within 10 seconds.** A hung webhook must not stall evaluation for other rules.
- **No redirects.** Redirects are not followed. Give the final URL.
- **Delivery is best effort.** A non-2xx response is logged and not retried, so treat the webhook
  as a notification, not a queue.

## Custom scripts

Sandboxed JavaScript, run on every state change. The built-in test runner dry-runs it against a
fake alert before you save.

```js
// Page PagerDuty when firing, resolve the incident when it clears.
const payload = {
  routing_key: secrets.PD_ROUTING_KEY,
  event_action: alert.state === 'firing' ? 'trigger' : 'resolve',
  dedup_key: `ziplogger-${alert.name}`,
  payload: {
    summary: alert.summary,
    severity: alert.state === 'firing' ? 'critical' : 'info',
    source: alert.service || 'ziplogger',
    custom_details: { observed: alert.value, threshold: alert.threshold },
  },
}

const res = http.post('https://events.pagerduty.com/v2/enqueue', payload)
log(`PagerDuty responded ${res.status}: ${res.body}`)
```

### Available bindings

| Binding | Description |
|---|---|
| `alert.name` | Rule name |
| `alert.state` | `firing` or `resolved` |
| `alert.condition` | `CountGt`, `LatencyIncrease`, `ServiceDown`, and so on (see above) |
| `alert.service` | Service the rule targets, when set |
| `alert.value` | The observed value that triggered evaluation |
| `alert.threshold` | The configured threshold |
| `alert.summary` | The generated human-readable summary |
| `alert.message` | Your custom message on the rule, when set |
| `secrets.NAME` | Values you stored on the rule, encrypted at rest and never displayed again |
| `http.post(url, body?, headers?)` | Returns `{ status, body }` |
| `http.get(url, headers?)` | Returns `{ status, body }` |
| `log(value)` | Writes to the script's run output, visible in the test runner |

### Limits

- **5 seconds** of total execution time.
- **At most 5 HTTP requests** per run. The sixth throws.
- Target URLs face the same public-address rules as webhooks.
- Secrets are write-only from the UI's perspective: store them once, reference them by name.

Keep scripts short and idempotent. They run on the firing edge and the recovery edge, and a script
that assumes it only ever runs once will misbehave on recovery.

## Service health checks

The Dashboards page derives a status for every service seen in the last 24 hours: `healthy`,
`errors` (error-level events in the last 15 minutes), or `silent` (no telemetry for 15+ minutes).

A quiet service is not necessarily a dead one, so any service card's gear icon adds an **active
health check**: a public URL ZipLogger requests on your chosen interval (1 to 60 minutes).

- Any response **below HTTP 400 counts as up**, recorded with latency.
- An error status or a timeout marks the service **down**.
- Ticking "Alert when this service goes down" creates a linked `ServiceDown` rule that can use any
  channel above.

Point it at a real readiness endpoint, not your home page. A health check that only proves nginx is
alive will stay green through a database outage:

```csharp
app.MapGet("/health", async (AppDbContext db) =>
    await db.Database.CanConnectAsync() ? Results.Ok("ok") : Results.StatusCode(503));
```

Health-check URLs must be publicly reachable, for the same reason webhook URLs must be.

## Choosing thresholds

- **Alert on symptoms, not causes.** "Checkout error rate above 20 per minute" survives a refactor;
  "exceptions in `PaymentGateway.Charge`" does not.
- **Size the window to the signal.** A 1-minute window on a low-traffic service produces noise from
  ordinary variance. Five minutes is a saner floor.
- **Use `NoData` for anything scheduled.** A nightly job that logs nothing at all is the failure
  mode a count threshold will never catch.
- **Prefer `LatencyIncrease` over an absolute latency cap.** A baseline-relative rule keeps working
  as traffic and hardware change, without anyone remembering to retune it.
