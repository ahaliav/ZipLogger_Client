# Migrate from Mixpanel to ZipLogger

You do not have to rewrite your instrumentation. ZipLogger accepts Mixpanel-shaped payloads, so
in most codebases the migration is **two lines of configuration**: a new endpoint host and a new
token. Your event names, your properties, your `identify` calls and your batching all keep
working as written.

What changes is what you can *do* with the events afterwards: because they land next to your
logs, traces and deployments, an error can tell you what users were doing when it happened.

---

## 1. Create a ZipLogger workspace

Sign up at [ziplogger.ai](https://ziplogger.ai). The free plan includes event ingestion; no
card is charged.

## 2. Get an ingestion key

**Settings → API keys → New key.** Copy it — it looks like `zk_...`. This is the key you will use
wherever your code currently passes a Mixpanel project token.

Like a Mixpanel project token, this key is write-only: it can send events and nothing else. It is
safe in a browser bundle. It cannot read your data.

## 3. Point your SDK at ZipLogger

Every Mixpanel client library lets you override the API host. Set the host to
`https://app.ziplogger.ai/ingest/v1/mp` and use your ZipLogger key as the token.

**JavaScript (mixpanel-browser)**

```js
mixpanel.init('zk_your_ziplogger_key', {
  api_host: 'https://app.ziplogger.ai/ingest/v1/mp',
})
```

**Python (mixpanel-python)**

```python
from mixpanel import Mixpanel, Consumer

mp = Mixpanel(
    'zk_your_ziplogger_key',
    consumer=Consumer(api_host='app.ziplogger.ai/ingest/v1/mp'),
)
```

**Anything else** — point `/track`, `/import` and `/engage` at
`https://app.ziplogger.ai/ingest/v1/mp/...`. You can send the key in the payload's `token`
property (what the SDKs already do) or as an `X-Api-Key` header; the header wins when both are
present.

That is the whole change. Nothing about your `mixpanel.track(...)` call sites needs to move.

## 4. Keep your event names and properties

They are stored as you send them. Two details worth knowing:

- **Names are normalized** so one event cannot split into three: `Checkout Started`,
  `checkout-started` and `checkout_started` all become `checkout_started`. Your existing names
  keep working; they just canonicalize.
- **Reserved Mixpanel properties become first-class fields** rather than staying as custom
  properties: `distinct_id`, `$user_id`, `$device_id`, `$insert_id`, `time`, `$current_url` and
  `token`. Everything else you send is kept verbatim and is filterable.

### How identity maps

| Mixpanel | ZipLogger |
|---|---|
| `distinct_id` (post-login) | `userId` |
| `distinct_id` of the form `$device:abc` | `anonymousId` |
| `$user_id` + `$device_id` (Simplified ID Merge) | `userId` + `anonymousId` |
| `$identify` event | an identity link, plus a visible `$identify` event in the journey |
| `$insert_id` | the document id, so a retried batch overwrites instead of double-counting |

Identity merges are reversible in ZipLogger: a user's profile page lists the anonymous profiles
linked to them, and an Editor can un-merge one without touching the events themselves.

## 5. Verify events are arriving

Open **Events** in the app. Within a few seconds of your first call you should see the volume
chart move and your event names in "Top events". If nothing arrives:

- a `401` means the key is wrong or revoked — check **Settings → API keys**;
- a `429` means the plan's daily event cap is reached (the response carries `Retry-After`);
- events with no `distinct_id` and no `$device_id` are rejected, because an event attributable to
  nobody cannot answer any question the product exists to answer.

## 6. Verify users

Open any event and click through to a user, or search a known `distinct_id` under
**Events → Explore → User**. A user page shows their events, sessions, linked anonymous profiles,
and the errors their requests hit.

## 7. Rebuild your dashboards

ZipLogger dashboards are not events-only: the same board holds event widgets, log and error
widgets, alerts, service health, deployments and AI summaries. Start from **Dashboards → + New**,
then **+ Widget**.

The Mixpanel equivalents:

| Mixpanel report | ZipLogger widget |
|---|---|
| Insights (event volume over time) | **Event trend** — with group-by service, country, device, version |
| Funnels | **Funnel** |
| Unique users / DAU | **Unique users** |
| Breakdown by property | **Top events**, **Users by country**, **Events by device/browser** |
| Numeric property sums | **Event property total** |
| — (no equivalent) | **Event → errors**: how often the requests carrying an event fail, and with which errors |

## 8. Historical data

Point your existing Mixpanel export/import job at `/ingest/v1/mp/import` instead of Mixpanel's
`/import`. The payload format is the same, `time` may be epoch seconds or milliseconds, and
`$insert_id` makes re-runs safe — an interrupted import can simply be run again without
duplicating what already landed.

Two limits to plan around:

- **Imported events count against your daily event quota**, so a large backfill is best run in
  chunks. The response tells you what was accepted and what was rejected.
- **Events older than 30 days are stamped with the arrival time** rather than their original
  timestamp, and events fall out of the index at your plan's retention. Import the window you
  actually query, not your entire history.

---

## What stays ZipLogger's, not Mixpanel's

The compatibility is in the payload format only. Everything underneath is ZipLogger's:

- **Tenant isolation** — a key resolves to one workspace, and every query is scoped to it.
- **Per-plan quotas** — enforced server-side at ingest, with a graceful `429`.
- **Privacy** — raw IPs are never stored (location is an approximate in-process lookup), raw
  User-Agent strings are classified then discarded, URLs lose their query strings, and
  credential-shaped values are redacted before indexing. This applies to Mixpanel-shaped payloads
  exactly as it does to native ones.
- **Profiles** — ZipLogger derives user profiles from the event stream rather than storing a
  mutable profile document. `/engage` `$set` calls are accepted and recorded as a `$profile_set`
  event carrying the same properties, so the data stays queryable and attributable. There is no
  separate profile object to keep in sync.

See [events.md](events.md) for the native API and the .NET SDK.
