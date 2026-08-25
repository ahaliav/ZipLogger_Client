package dev.ziplogger;

import com.sun.net.httpserver.HttpServer;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Dependency-free smoke test (no JUnit needed):
 *   javac -d out src/main/java/dev/ziplogger/*.java src/test/java/dev/ziplogger/SmokeTest.java
 *   java -cp out dev.ziplogger.SmokeTest
 * Exits non-zero on failure.
 */
public final class SmokeTest {

    record Received(String path, String apiKey, List<String> lines, int status) {}

    static final CopyOnWriteArrayList<Received> requests = new CopyOnWriteArrayList<>();
    static final List<Integer> responses = new CopyOnWriteArrayList<>();
    static int failures = 0;

    public static void main(String[] args) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String body;
            try (InputStream in = exchange.getRequestBody()) {
                body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            int status = responses.isEmpty() ? 202 : responses.remove(0);
            requests.add(new Received(
                    exchange.getRequestURI().getPath(),
                    exchange.getRequestHeaders().getFirst("X-Api-Key"),
                    List.of(body.split("\n")),
                    status));
            if (status == 429) exchange.getResponseHeaders().set("Retry-After", "0");
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        server.start();
        String endpoint = "http://127.0.0.1:" + server.getAddress().getPort();

        testBatchingAndEnrichment(endpoint);
        testRetryOn429(endpoint);
        testDropAfterMaxRetries(endpoint);
        testJulHandler(endpoint);

        server.stop(0);
        if (failures > 0) {
            System.err.println("FAILED: " + failures + " assertion(s)");
            System.exit(1);
        }
        System.out.println("OK: all Java SDK smoke tests passed");
    }

    static ZipLoggerClient.Options options(String endpoint) {
        var opts = new ZipLoggerClient.Options(endpoint, "zk_test");
        opts.source = "unit-test";
        opts.flushInterval = Duration.ofMillis(30);
        opts.retryBaseDelay = Duration.ofMillis(10);
        return opts;
    }

    static void testBatchingAndEnrichment(String endpoint) throws Exception {
        requests.clear();
        var opts = options(endpoint);
        opts.release = "1.2.3";
        opts.commitSha = "abc1234";
        try (var client = new ZipLoggerClient(opts)) {
            for (int i = 0; i < 5; i++)
                client.log(new ZipLoggerClient.Entry().message("event " + i).field("i", i));
            Thread.sleep(300);
        }
        waitFor(() -> !requests.isEmpty());
        Received received = requests.get(0);
        check("path", received.path().equals("/ingest/v1/logs"), received.path());
        check("apiKey", "zk_test".equals(received.apiKey()), received.apiKey());
        check("5 lines", received.lines().size() == 5, received.lines().size());
        String first = received.lines().get(0);
        check("message", first.contains("\"message\":\"event 0\""), first);
        check("release", first.contains("\"release\":\"1.2.3\""), first);
        check("commitSha", first.contains("\"commitSha\":\"abc1234\""), first);
        check("machineName", first.contains("machineName"), first);
    }

    static void testRetryOn429(String endpoint) throws Exception {
        requests.clear();
        responses.addAll(List.of(429, 429, 202));
        try (var client = new ZipLoggerClient(options(endpoint))) {
            client.log(new ZipLoggerClient.Entry().message("retry me"));
            waitFor(() -> requests.size() >= 3);
            check("no drops after recovery", client.dropped() == 0, client.dropped());
        }
    }

    static void testDropAfterMaxRetries(String endpoint) throws Exception {
        requests.clear();
        responses.addAll(List.of(500, 500, 500));
        var opts = options(endpoint);
        opts.maxRetries = 2;
        var client = new ZipLoggerClient(opts);
        client.log(new ZipLoggerClient.Entry().message("doomed"));
        waitFor(() -> client.dropped() >= 1);
        check("3 attempts", requests.size() == 3, requests.size());
        client.close();
    }

    static void testJulHandler(String endpoint) throws Exception {
        requests.clear();
        var client = new ZipLoggerClient(options(endpoint));
        Logger logger = Logger.getLogger("smoke.jul");
        logger.setUseParentHandlers(false);
        logger.addHandler(new ZipLoggerJulHandler(client));
        logger.info("hello from jul");
        logger.log(Level.SEVERE, "it failed", new IllegalStateException("boom"));
        Thread.sleep(200);
        client.close();

        waitFor(() -> !requests.isEmpty());
        var lines = new ArrayList<String>();
        requests.forEach(r -> lines.addAll(r.lines()));
        check("2 entries", lines.size() == 2, lines.size());
        check("info severity", lines.get(0).contains("\"severity\":\"info\""), lines.get(0));
        check("error severity", lines.get(1).contains("\"severity\":\"error\""), lines.get(1));
        check("stack trace", lines.get(1).contains("IllegalStateException"), "missing stackTrace");
        check("category", lines.get(0).contains("smoke.jul"), lines.get(0));
    }

    static void waitFor(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5_000;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() > deadline) { check("timeout waiting", false, "timeout"); return; }
            Thread.sleep(10);
        }
    }

    static void check(String name, boolean ok, Object context) {
        if (!ok) {
            failures++;
            System.err.println("FAIL " + name + " — " + context);
        }
    }
}
