package dev.ziplogger;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * ZipLogger Java SDK — JDK-only client (Java 17+).
 *
 * Mirrors the delivery semantics of every ZipLogger SDK:
 * log() never blocks and never throws; a bounded queue drops on backpressure (counted);
 * NDJSON batches ship over HTTP with retry + exponential backoff honoring 429 Retry-After;
 * every entry is enriched with source, release, commit SHA, environment, and hostname.
 */
public final class ZipLoggerClient implements AutoCloseable {

    /** One log event. Message is the only required field. */
    public static final class Entry {
        public Instant timestamp;
        public String severity = "info";
        public String message = "";
        public String source;
        public String release;
        public String commitSha;
        public String stackTrace;
        public Throwable error;
        public Map<String, Object> fields;
        public List<String> tags;

        public Entry message(String value) { this.message = value; return this; }
        public Entry severity(String value) { this.severity = value; return this; }
        public Entry error(Throwable value) { this.error = value; return this; }
        public Entry field(String key, Object value) {
            if (fields == null) fields = new LinkedHashMap<>();
            fields.put(key, value);
            return this;
        }
    }

    /** Client configuration. endpoint + apiKey are required; everything else has defaults. */
    public static final class Options {
        public String endpoint;
        public String apiKey;
        public String source = firstNonEmpty(System.getenv("ZIPLOGGER_SOURCE"), "java");
        public String release = System.getenv("ZIPLOGGER_RELEASE");
        public String commitSha = firstNonEmpty(
                System.getenv("ZIPLOGGER_COMMIT_SHA"), System.getenv("GIT_COMMIT"), System.getenv("COMMIT_SHA"));
        public String environment = firstNonEmpty(System.getenv("ZIPLOGGER_ENVIRONMENT"), "production");
        public List<String> tags;
        public int queueCapacity = 10_000;
        public int batchSize = 100;
        public Duration flushInterval = Duration.ofSeconds(2);
        public int maxRetries = 5;
        public Duration retryBaseDelay = Duration.ofMillis(500);
        public Duration retryMaxDelay = Duration.ofSeconds(30);
        public Duration timeout = Duration.ofSeconds(10);

        public Options(String endpoint, String apiKey) {
            this.endpoint = endpoint;
            this.apiKey = apiKey;
        }
    }

    private static final Set<String> SEVERITIES = Set.of("debug", "info", "warn", "error", "fatal");

    private final Options options;
    private final URI url;
    private final HttpClient http;
    private final BlockingQueue<Map<String, Object>> queue;
    private final Thread worker;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicLong dropped = new AtomicLong();
    private final String hostname;

    public ZipLoggerClient(Options options) {
        if (options.endpoint == null || options.endpoint.isBlank())
            throw new IllegalArgumentException("ZipLogger: endpoint is required");
        if (options.apiKey == null || options.apiKey.isBlank())
            throw new IllegalArgumentException("ZipLogger: apiKey is required");
        this.options = options;

        String trimmed = options.endpoint.replaceAll("/+$", "");
        this.url = URI.create(trimmed.toLowerCase().endsWith("/logs") ? trimmed : trimmed + "/ingest/v1/logs");
        this.http = HttpClient.newBuilder().connectTimeout(options.timeout).build();
        this.queue = new ArrayBlockingQueue<>(Math.max(1, options.queueCapacity));
        this.hostname = resolveHostname();

        this.worker = new Thread(this::pump, "ziplogger-shipper");
        this.worker.setDaemon(true);
        this.worker.start();
    }

    /** Entries lost to backpressure or exhausted retries. */
    public long dropped() { return dropped.get(); }

    /** Queue an entry for background delivery. Never blocks, never throws. */
    public void log(Entry entry) {
        if (closed.get() || !queue.offer(toRecord(entry))) dropped.incrementAndGet();
    }

    private Map<String, Object> toRecord(Entry entry) {
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("environment", options.environment);
        fields.put("machineName", hostname);
        if (entry.fields != null) fields.putAll(entry.fields);

        String stackTrace = entry.stackTrace;
        if (entry.error != null) {
            if (stackTrace == null) stackTrace = stackTraceOf(entry.error);
            fields.put("exceptionType", entry.error.getClass().getName());
            fields.put("exceptionMessage", String.valueOf(entry.error.getMessage()));
        }

        Map<String, Object> record = new LinkedHashMap<>();
        record.put("timestamp", (entry.timestamp != null ? entry.timestamp : Instant.now()).toString());
        record.put("severity", SEVERITIES.contains(entry.severity) ? entry.severity
                : "warning".equals(entry.severity) ? "warn" : "info");
        record.put("message", entry.message == null ? "" : entry.message);
        record.put("source", firstNonEmpty(entry.source, options.source));
        String release = firstNonEmpty(entry.release, options.release);
        if (release != null) record.put("release", release);
        String sha = firstNonEmpty(entry.commitSha, options.commitSha);
        if (sha != null) record.put("commitSha", sha);
        if (stackTrace != null) record.put("stackTrace", stackTrace);
        record.put("fields", fields);
        List<String> tags = entry.tags != null ? entry.tags : options.tags;
        if (tags != null && !tags.isEmpty()) record.put("tags", tags);
        return record;
    }

    private void pump() {
        List<Map<String, Object>> batch = new ArrayList<>(options.batchSize);
        while (true) {
            try {
                Map<String, Object> first = queue.poll(
                        batch.isEmpty() ? Long.MAX_VALUE : options.flushInterval.toMillis(), TimeUnit.MILLISECONDS);
                if (first != null) batch.add(first);
                queue.drainTo(batch, options.batchSize - batch.size());
                boolean lingerElapsed = first == null;
                if (batch.size() >= options.batchSize || lingerElapsed || closed.get()) {
                    send(batch);
                    batch = new ArrayList<>(options.batchSize);
                }
                if (closed.get() && queue.isEmpty()) return;
            } catch (InterruptedException interrupted) {
                // Close signal: drain and exit.
                queue.drainTo(batch);
                send(batch);
                return;
            }
        }
    }

    private void send(List<Map<String, Object>> batch) {
        if (batch.isEmpty()) return;
        StringBuilder payload = new StringBuilder(batch.size() * 128);
        for (Map<String, Object> record : batch) payload.append(Json.write(record)).append('\n');

        for (int attempt = 0; ; attempt++) {
            long retryAfterMs = -1;
            try {
                HttpRequest request = HttpRequest.newBuilder(url)
                        .timeout(options.timeout)
                        .header("Content-Type", "application/x-ndjson")
                        .header("X-Api-Key", options.apiKey)
                        .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
                        .build();
                HttpResponse<Void> response = http.send(request, HttpResponse.BodyHandlers.discarding());
                int status = response.statusCode();
                if (status >= 200 && status < 300) return;
                if (status != 429 && status != 408 && status < 500) {
                    dropped.addAndGet(batch.size()); // 400/401/... — retrying cannot help
                    return;
                }
                retryAfterMs = response.headers().firstValue("Retry-After")
                        .map(header -> { try { return (long) (Double.parseDouble(header) * 1000); } catch (NumberFormatException e) { return -1L; } })
                        .orElse(-1L);
            } catch (IOException transientFailure) {
                // network failure / timeout — retry below
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                dropped.addAndGet(batch.size());
                return;
            }

            if (attempt >= options.maxRetries) {
                dropped.addAndGet(batch.size());
                return;
            }
            long backoff = Math.min(options.retryBaseDelay.toMillis() << attempt, options.retryMaxDelay.toMillis());
            long delay = retryAfterMs >= 0 ? Math.min(retryAfterMs, options.retryMaxDelay.toMillis()) : backoff;
            try {
                Thread.sleep(delay);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                dropped.addAndGet(batch.size());
                return;
            }
        }
    }

    /** Flush buffered entries (bounded wait) and stop the shipper. */
    @Override
    public void close() {
        if (closed.getAndSet(true)) return;
        worker.interrupt();
        try {
            worker.join(5_000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static String stackTraceOf(Throwable error) {
        StringWriter writer = new StringWriter();
        error.printStackTrace(new PrintWriter(writer));
        return writer.toString().stripTrailing();
    }

    private static String resolveHostname() {
        String env = firstNonEmpty(System.getenv("COMPUTERNAME"), System.getenv("HOSTNAME"));
        if (env != null) return env;
        try {
            return java.net.InetAddress.getLocalHost().getHostName();
        } catch (IOException e) {
            return "unknown";
        }
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) if (value != null && !value.isBlank()) return value;
        return null;
    }
}
