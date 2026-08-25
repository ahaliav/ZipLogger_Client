# ziplogger (Java)

Java SDK for [ZipLogger](https://ziplogger.dev) — a JDK-only client (Java 17+)
with a `java.util.logging` handler. Batching, retry with backoff (429-aware),
drop-on-backpressure, automatic enrichment. **Zero dependencies.**

```xml
<dependency>
  <groupId>dev.ziplogger</groupId>
  <artifactId>ziplogger</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Direct client

```java
var client = new ZipLoggerClient(new ZipLoggerClient.Options(
    "https://logs.yourcompany.com", "zk_..."));

client.log(new ZipLoggerClient.Entry()
    .message("order created")
    .field("orderId", 83112).field("customer", "acme"));

client.log(new ZipLoggerClient.Entry()
    .severity("error").message("payment failed").error(exception)); // → stackTrace

client.close(); // flush on shutdown
```

## java.util.logging

```java
Logger.getLogger("").addHandler(new ZipLoggerJulHandler(client, true));
log.info("hello");
log.log(Level.SEVERE, "it failed", exception);
```

SLF4J/Logback and Log4j2 users can log through the client directly today; native appenders are
on the roadmap.

## Behavior

`log()` never blocks and never throws. Entries buffer in a bounded queue (default 10,000), ship
as NDJSON batches (default 100 per request, 2s linger) to `/ingest/v1/logs`, retry transient
failures (429 honoring `Retry-After`, 5xx, network) with exponential backoff, and drop with a
counter (`client.dropped()`) when the queue overflows or retries exhaust. Enrichment —
`environment`, `machineName`, `release`, `commitSha` (from `Options` or the standard
`ZIPLOGGER_*` / `GIT_COMMIT` env vars) — feeds ZipLogger's git regression detection.

## Test

```bash
javac -d out src/main/java/dev/ziplogger/*.java src/test/java/dev/ziplogger/SmokeTest.java
java -cp out dev.ziplogger.SmokeTest
```
