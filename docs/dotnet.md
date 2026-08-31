# .NET

Your application code never references ZipLogger. It logs through the standard abstractions
(`ILogger` or Serilog), and the provider or sink ships entries in the background.

| Package | Use it for |
|---|---|
| `ZipLogger.Extensions.Logging` | `Microsoft.Extensions.Logging` provider. The default choice for ASP.NET Core, worker services, and anything using the generic host. |
| `ZipLogger.Serilog` | Serilog sink, for apps already standardized on Serilog. |
| `ZipLogger.Client` | The core transport on its own, for code with no logging framework. |
| `ZipLogger.Metrics.AspNetCore` | Request metrics (APM). See [metrics](metrics.md). |

All target `net8.0` and `net10.0`.

## ILogger (Microsoft.Extensions.Logging)

```bash
dotnet add package ZipLogger.Extensions.Logging
```

```csharp
// Program.cs
builder.Logging.AddZipLogger(options =>
{
    options.Endpoint = "https://app.ziplogger.ai";
    options.ApiKey   = "zk_...";
});
```

Or configure from `appsettings.json` and call `builder.Logging.AddZipLogger();` with no arguments:

```json
{
  "Logging": {
    "ZipLogger": {
      "Endpoint": "https://app.ziplogger.ai",
      "ApiKey": "zk_...",
      "LogLevel": {
        "Default": "Information",
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning"
      }
    }
  }
}
```

The `LogLevel` section is a per-provider filter, so you can ship warnings and above to ZipLogger
while the console still shows everything. Filtering here is the right lever for volume: anything the
provider accepts counts toward your quota.

Keep the key out of source control. It binds from any configuration source, so
`ZIPLOGGER_API_KEY`-style secrets work through the standard providers:

```bash
# environment variable, double underscore is the section separator
Logging__ZipLogger__ApiKey=zk_...
```

```bash
dotnet user-secrets set "Logging:ZipLogger:ApiKey" "zk_..."
```

### Logging as usual

Structured values, scopes, and exceptions all flow through:

```csharp
logger.LogWarning("Payment {Status} for {Customer}", "declined", "acme");
// severity=warn, fields: { Status: "declined", Customer: "acme", messageTemplate: "...", category: "..." }

logger.LogError(ex, "Sync failed");
// stackTrace = ex.ToString() (feeds git regression attribution), fields: exceptionType, exceptionMessage
```

Use named placeholders, not interpolation. `LogWarning($"Payment {status}")` produces a unique
message every time, which defeats pattern clustering and makes the alert rule you wanted to write
impossible. `logger.LogWarning("Payment {Status}", status)` gives you one template with a count.

Scopes become fields on every entry inside them, which is the cheapest way to attach request
context:

```csharp
using (logger.BeginScope(new Dictionary<string, object>
       {
           ["orderId"] = order.Id,
           ["tenantId"] = tenant.Id,
           ["traceId"] = Activity.Current?.TraceId.ToString() ?? "",
       }))
{
    logger.LogInformation("Reserving stock");   // carries all three fields
    await ReserveAsync(order);
}
```

`traceId` in particular earns its keep: it turns every log line into a link to the trace waterfall.
See [tracing](tracing.md#correlating-logs-with-traces).

### Provider options

| Option | Default | Purpose |
|---|---|---|
| `IncludeScopes` | `true` | Flatten `BeginScope` state into fields |
| `IncludeCategory` | `true` | Add `fields.category` (the logger name) |

Plus everything in `ZipLoggerClientOptions` below.

## Serilog

```bash
dotnet add package ZipLogger.Serilog
```

```csharp
Log.Logger = new LoggerConfiguration()
    .WriteTo.ZipLogger("https://app.ziplogger.ai", "zk_...")
    .CreateLogger();
```

The sink takes the same options plus Serilog's own level filter:

```csharp
Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.ZipLogger(
        endpoint: "https://app.ziplogger.ai",
        apiKey: "zk_...",
        configure: o =>
        {
            o.Source = "orders-api";
            o.Tags.Add("payments");
            o.BatchSize = 200;
        },
        restrictedToMinimumLevel: LogEventLevel.Information)
    .CreateLogger();
```

Serilog properties become ZipLogger fields, and `LogContext` pushes ride along:

```csharp
using (LogContext.PushProperty("orderId", order.Id))
{
    Log.Information("Reserving stock for {Customer}", customer);
}
```

Call `Log.CloseAndFlush()` on shutdown, as with any Serilog sink.

## Core client, no logging framework

For code with nothing to hook into (a small utility, a custom pipeline stage):

```bash
dotnet add package ZipLogger.Client
```

```csharp
await using ILogShipper shipper = new ZipLoggerShipper(new ZipLoggerClientOptions
{
    Endpoint = "https://app.ziplogger.ai",
    ApiKey   = "zk_...",
    Source   = "import-tool",
});

shipper.Enqueue(new ClientLogEntry
{
    Severity = "info",
    Message  = "Import finished",
    Fields   = new() { ["rows"] = 12_403, ["durationMs"] = 8_921 },
});

if (shipper.DroppedCount > 0)
    Console.Error.WriteLine($"ZipLogger dropped {shipper.DroppedCount} entries");
```

`Enqueue` never blocks and never throws. Disposal flushes, bounded by `ShutdownTimeout`.

## What the client does for you

- **Never blocks, never throws.** Entries go into a bounded in-memory channel; a background worker
  batches them (default 100/batch, 2 s linger) and POSTs NDJSON to `/ingest/v1/logs`.
- **Drop over grow.** When the queue is full (default 10,000) new entries are dropped and counted
  (`ILogShipper.DroppedCount`) instead of growing memory unboundedly.
- **Retry with exponential backoff plus jitter** on 429 (honoring `Retry-After`), 408, 5xx, and
  network failures. Non-transient errors (401, 400) drop the batch immediately.
- **Automatic enrichment.** Every entry gets:
  - `source`, from the entry assembly name (or `Source` / `ZIPLOGGER_SOURCE`)
  - `release`, from the assembly informational version (or `Release` / `ZIPLOGGER_RELEASE`)
  - `commitSha`, from the SourceLink `+sha` version suffix (or `CommitSha` /
    `ZIPLOGGER_COMMIT_SHA` / `GIT_COMMIT` / `COMMIT_SHA`), which powers regression attribution
  - `fields.environment`, from `DOTNET_ENVIRONMENT` or `ASPNETCORE_ENVIRONMENT`
  - `fields.machineName`, from the machine name
- **Graceful shutdown.** Disposal flushes the buffer, bounded by `ShutdownTimeout` (default 5 s).

### Getting the commit SHA for free

`commitSha` is what turns "this error is happening" into "this commit caused it". SourceLink puts
it in the informational version, and the client reads it from there, so this is the whole setup:

```xml
<PropertyGroup>
  <PublishRepositoryUrl>true</PublishRepositoryUrl>
  <IncludeSourceRevisionInInformationalVersion>true</IncludeSourceRevisionInInformationalVersion>
</PropertyGroup>
```

In containers built without git metadata, pass it explicitly instead:

```dockerfile
ARG GIT_COMMIT
ENV ZIPLOGGER_COMMIT_SHA=$GIT_COMMIT
```

## Options

`ZipLoggerClientOptions`, shared by all three packages:

| Option | Default | Purpose |
|---|---|---|
| `Endpoint` | required | Server origin. `/ingest/v1/logs` is appended unless the URL already ends in `/logs` |
| `ApiKey` | required | Ingestion key, sent as `X-Api-Key` |
| `Source`, `Release`, `CommitSha`, `Environment`, `MachineName` | auto | Enrichment overrides |
| `Tags` | empty | Tags added to every entry |
| `QueueCapacity` | 10,000 | Max buffered entries before dropping |
| `BatchSize` | 100 | Max entries per request |
| `FlushInterval` | 2 s | Linger before flushing a partial batch |
| `MaxRetries` | 5 | Retry attempts per batch |
| `RetryBaseDelay` / `RetryMaxDelay` | 500 ms / 30 s | Backoff bounds (doubling, with jitter) |
| `HttpTimeout` | 10 s | Per-request HTTP timeout |
| `ShutdownTimeout` | 5 s | Flush budget on disposal |

## Recipes

### ASP.NET Core

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Logging.AddZipLogger();                                   // from appsettings
builder.Services.AddZipLoggerMetrics(builder.Configuration, service: "orders-api");

var app = builder.Build();
app.UseZipLoggerMetrics();
```

Nothing else is needed: the generic host disposes the provider on shutdown, which flushes.

### Worker service and background jobs

```csharp
public sealed class ReconcileWorker(ILogger<ReconcileWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            using var scope = logger.BeginScope(new Dictionary<string, object>
                { ["runId"] = Guid.NewGuid() });
            try
            {
                await ReconcileAsync(ct);
                logger.LogInformation("Reconcile finished");
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Reconcile failed");    // stack trace ships
            }
            await Task.Delay(TimeSpan.FromMinutes(15), ct);
        }
    }
}
```

### Console app or CLI

Short-lived processes need a shorter linger and an explicit flush, otherwise the process exits
before the batch ships:

```csharp
using var factory = LoggerFactory.Create(b => b.AddZipLogger(o =>
{
    o.Endpoint = "https://app.ziplogger.ai";
    o.ApiKey = "zk_...";
    o.FlushInterval = TimeSpan.FromMilliseconds(250);
}));
var logger = factory.CreateLogger("migrate");
logger.LogInformation("Migration complete");
// disposing the factory disposes the provider, which flushes
```

### Local development and tests

Register the provider only when it is configured, so a developer machine with no key does nothing:

```csharp
if (!string.IsNullOrEmpty(builder.Configuration["Logging:ZipLogger:ApiKey"]))
    builder.Logging.AddZipLogger();
```

In tests, add no ZipLogger provider at all. There is no need to guard individual logging calls.

### Containers

```dockerfile
ENV ZIPLOGGER_SOURCE=orders-api \
    ZIPLOGGER_ENVIRONMENT=production
ARG GIT_COMMIT
ENV ZIPLOGGER_COMMIT_SHA=$GIT_COMMIT
```

See the [configuration reference](configuration.md) for the full variable list.

## Monitoring the shipper itself

`DroppedCount` only grows when something is wrong: a full queue means you are producing faster than
the network drains, and exhausted retries mean ZipLogger was unreachable or the key is bad.

The `ILogger` provider and the Serilog sink own their shipper internally, so there is nothing to
inject. To observe loss, construct the shipper yourself and register it as a singleton, which also
gives you a direct `Enqueue` path alongside `ILogger`:

```csharp
builder.Services.AddSingleton<ILogShipper>(_ => new ZipLoggerShipper(new ZipLoggerClientOptions
{
    Endpoint = builder.Configuration["Logging:ZipLogger:Endpoint"],
    ApiKey   = builder.Configuration["Logging:ZipLogger:ApiKey"],
}));

builder.Services.AddHealthChecks().AddCheck<ShipperHealthCheck>("ziplogger");

public sealed class ShipperHealthCheck(ILogShipper shipper) : IHealthCheck
{
    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext ctx, CancellationToken ct) =>
        Task.FromResult(shipper.DroppedCount == 0
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Degraded($"ZipLogger dropped {shipper.DroppedCount} entries"));
}
```

`ZipLogger.Metrics.AspNetCore` is different: its `MetricShipper` is registered in DI, so you can
inject it and read `DroppedCount` directly.

## Request metrics and tracing

- **Metrics (APM):** `ZipLogger.Metrics.AspNetCore` times every request and powers the Metrics
  page's avg/p95 latency and throughput series, plus `Record()` and `TimeJob()` for custom
  measurements. See [metrics](metrics.md).
- **Traces:** use the standard OpenTelemetry packages and point the OTLP exporter at ZipLogger.
  There is no ZipLogger-specific tracing package to learn. See [tracing](tracing.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| No logs arriving | Is `Endpoint`/`ApiKey` bound? A typo in the config section name leaves both null and the provider silent. |
| Logs stop after a while | Check `DroppedCount`. A rising count with a valid key means the queue is filling faster than it drains: raise `BatchSize`, or filter more at the `LogLevel` level. |
| Nothing from a console app | The process exited before the 2 s linger elapsed. Dispose the factory, or lower `FlushInterval`. |
| No `commitSha`, so no regression attribution | Enable `IncludeSourceRevisionInInformationalVersion`, or set `ZIPLOGGER_COMMIT_SHA` in the build. |
| Every message is a unique pattern | Interpolated strings instead of message templates. |
| Quota burning fast | Debug-level logs from a framework category. Filter under `Logging:ZipLogger:LogLevel`. |
