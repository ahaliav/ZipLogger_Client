# Java

A JDK-only client (Java 17+) with a `java.util.logging` handler. Batching, retry with backoff
(429-aware), drop-on-backpressure, automatic enrichment. **Zero dependencies**, so it adds nothing
to your dependency tree and cannot conflict with your logging stack.

```xml
<dependency>
  <groupId>dev.ziplogger</groupId>
  <artifactId>ziplogger</artifactId>
  <version>0.4.0</version>
</dependency>
```

```kotlin
// Gradle
implementation("dev.ziplogger:ziplogger:0.4.0")
```

## Direct client

```java
var client = new ZipLoggerClient(new ZipLoggerClient.Options(
    "https://app.ziplogger.dev", System.getenv("ZIPLOGGER_API_KEY")));

client.log(new ZipLoggerClient.Entry()
    .message("order created")
    .field("orderId", 83112).field("customer", "acme"));

client.log(new ZipLoggerClient.Entry()
    .severity("error").message("payment failed").error(exception)); // fills stackTrace

client.close(); // flush on shutdown
```

`Entry` is a mutable builder with chainable `message`, `severity`, `error`, and `field` methods, plus
public fields for `timestamp`, `source`, `release`, `commitSha`, `stackTrace`, `fields`, and `tags`
when you need them.

Configure enrichment and delivery on `Options` before constructing the client:

```java
var options = new ZipLoggerClient.Options("https://app.ziplogger.dev", apiKey);
options.source = "orders-api";
options.release = "2026.8.1";
options.tags = List.of("payments");
options.batchSize = 200;
var client = new ZipLoggerClient(options);
```

Hold the client as a singleton for the life of the process. It owns a background thread, so creating
one per request would be expensive and would defeat batching.

## java.util.logging

```java
Logger.getLogger("").addHandler(new ZipLoggerJulHandler(client, true));

var log = Logger.getLogger("app.orders");
log.info("hello");
log.log(Level.SEVERE, "it failed", exception);
```

The second constructor argument decides whether the handler closes the client when the handler is
closed. Pass `true` when the handler owns the client (the common case), `false` when you share one
client across several handlers and close it yourself.

The handler sets `fields.category` from the logger name, and message parameters land as `param0`,
`param1`, and so on. Messages are formatted with `SimpleFormatter` semantics, so
`log.log(Level.INFO, "Order {0} created", orderId)` keeps a stable template rather than a unique
message per order.

### Level mapping

| JUL level | ZipLogger severity |
|---|---|
| `SEVERE` | `error` |
| `WARNING` | `warn` |
| `INFO`, `CONFIG` | `info` |
| `FINE`, `FINER`, `FINEST` | `debug` |

Mapping is by numeric value, so custom levels land in the band they sit in. There is no JUL level
that maps to `fatal`; set `severity("fatal")` on a direct `Entry` when you need it.

## SLF4J, Logback, and Log4j2

There are no native appenders yet. Two options that work today:

**1. Bridge to JUL.** If your stack already routes through `java.util.logging`, or you can add a
bridge, the handler above captures everything with no per-call changes. For SLF4J, `jul-to-slf4j`
routes the other way, so use SLF4J's `slf4j-jdk14` binding instead when you want JUL as the sink.

**2. Write a thin appender over the client.** The client is the whole integration surface, so an
appender is about twenty lines. Logback:

```java
public final class ZipLoggerAppender extends AppenderBase<ILoggingEvent> {
    private ZipLoggerClient client;
    private String endpoint, apiKey, source;   // set from logback.xml

    @Override public void start() {
        var options = new ZipLoggerClient.Options(endpoint, apiKey);
        if (source != null) options.source = source;
        client = new ZipLoggerClient(options);
        super.start();
    }

    @Override protected void append(ILoggingEvent event) {
        var entry = new ZipLoggerClient.Entry()
            .message(event.getFormattedMessage())
            .severity(switch (event.getLevel().toInt()) {
                case Level.ERROR_INT -> "error";
                case Level.WARN_INT  -> "warn";
                case Level.DEBUG_INT, Level.TRACE_INT -> "debug";
                default -> "info";
            });
        entry.timestamp = Instant.ofEpochMilli(event.getTimeStamp());
        entry.field("category", event.getLoggerName());
        event.getMDCPropertyMap().forEach(entry::field);   // MDC becomes searchable fields
        var proxy = event.getThrowableProxy();
        if (proxy instanceof ThrowableProxy tp) entry.error(tp.getThrowable());
        client.log(entry);
    }

    @Override public void stop() { if (client != null) client.close(); super.stop(); }

    public void setEndpoint(String v) { this.endpoint = v; }
    public void setApiKey(String v) { this.apiKey = v; }
    public void setSource(String v) { this.source = v; }
}
```

```xml
<appender name="ZIPLOGGER" class="com.yourco.logging.ZipLoggerAppender">
  <endpoint>https://app.ziplogger.dev</endpoint>
  <apiKey>${ZIPLOGGER_API_KEY}</apiKey>
  <source>orders-api</source>
</appender>
<root level="INFO">
  <appender-ref ref="ZIPLOGGER"/>
</root>
```

Mapping MDC into fields is the part worth copying: it is how request ids, user ids, and trace ids
become searchable without touching call sites.

## Recipes

### Spring Boot

Spring Boot uses Logback by default, so the appender above is the tidiest route. Without it,
register the JUL handler once at startup:

```java
@Configuration
public class ZipLoggerConfig {
    @Bean(destroyMethod = "close")
    ZipLoggerClient zipLoggerClient(@Value("${ziplogger.endpoint}") String endpoint,
                                    @Value("${ziplogger.api-key}") String apiKey) {
        var options = new ZipLoggerClient.Options(endpoint, apiKey);
        options.source = "orders-api";
        return new ZipLoggerClient(options);
    }

    @Bean
    ApplicationRunner attachJul(ZipLoggerClient client) {
        return args -> Logger.getLogger("").addHandler(new ZipLoggerJulHandler(client, false));
    }
}
```

Declaring `destroyMethod = "close"` makes Spring flush on shutdown. The handler is constructed with
`false` because the Spring context, not the handler, owns the client's lifecycle.

### Uncaught exceptions

```java
Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
    client.log(new ZipLoggerClient.Entry()
        .severity("fatal")
        .message("Uncaught exception in " + thread.getName())
        .error(throwable));
    client.close();   // flush before the JVM goes down
});
```

### Shutdown hook for plain applications

```java
Runtime.getRuntime().addShutdownHook(new Thread(client::close));
```

`close()` interrupts the worker and waits up to 5 seconds for the buffer to drain. It is idempotent,
so a shutdown hook plus an explicit `close()` is safe.

## Behavior

`log()` never blocks and never throws. Entries buffer in a bounded queue (default 10,000), ship as
NDJSON batches (default 100 per request, 2 s linger) to `/ingest/v1/logs`, retry transient failures
(429 honoring `Retry-After`, 5xx, network) with exponential backoff, and drop with a counter
(`client.dropped()`) when the queue overflows or retries exhaust.

Enrichment (`environment`, `machineName`, `release`, `commitSha`, from `Options` or the standard
`ZIPLOGGER_*` and `GIT_COMMIT` variables) feeds ZipLogger's git regression detection.

## Options

| Option | Default | Purpose |
|---|---|---|
| `endpoint` | required | Server origin. `/ingest/v1/logs` is appended unless it already ends in `/logs` |
| `apiKey` | required | Ingestion key, sent as `X-Api-Key` |
| `source` | `ZIPLOGGER_SOURCE` or `java` | Service name |
| `release` | `ZIPLOGGER_RELEASE` | Build version |
| `commitSha` | `ZIPLOGGER_COMMIT_SHA`, `GIT_COMMIT`, `COMMIT_SHA` | Commit of the running build |
| `environment` | `ZIPLOGGER_ENVIRONMENT` or `production` | Deployment environment |
| `tags` | none | Tags added to every entry |
| `queueCapacity` | 10,000 | Max buffered entries |
| `batchSize` | 100 | Entries per request |
| `flushInterval` | 2 s | Linger before flushing a partial batch |
| `maxRetries` | 5 | Retry attempts per batch |
| `retryBaseDelay` / `retryMaxDelay` | 500 ms / 30 s | Backoff bounds |
| `timeout` | 10 s | Per-request HTTP timeout |

Note the default `source` is the literal `java` when nothing else is set, which is rarely what you
want on a dashboard. Set it.

### Getting the commit SHA in

Maven can stamp it into the manifest, but the simplest path is the environment:

```dockerfile
ARG GIT_COMMIT
ENV ZIPLOGGER_COMMIT_SHA=$GIT_COMMIT
ENV ZIPLOGGER_SOURCE=orders-api
```

See the [configuration reference](configuration.md).

## Tracing

Use the OpenTelemetry Java agent, which needs no code change, and point it at ZipLogger:

```bash
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.exporter.otlp.endpoint=https://app.ziplogger.dev \
     -Dotel.exporter.otlp.headers=X-Api-Key=zk_... \
     -Dotel.service.name=orders-api \
     -jar app.jar
```

The agent also injects `trace_id` into MDC, so an appender that maps MDC into fields (see above)
gives you trace-linked logs for free. See [tracing](tracing.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| Service shows as `java` | Set `options.source` or `ZIPLOGGER_SOURCE`. |
| Nothing arrives | The JUL root logger's level, and that the handler is attached to `Logger.getLogger("")`. |
| Nothing arrives from a short program | Add a shutdown hook, or call `close()` before exiting. |
| Nothing arrives from Spring Boot | Boot routes through Logback, not JUL. Use the appender, or add the JUL sink binding. |
| MDC values missing | JUL has no MDC. Map it in a Logback or Log4j2 appender. |
| `client.dropped()` climbing | Queue full or endpoint unreachable. Verify the key, then raise `batchSize`. |
