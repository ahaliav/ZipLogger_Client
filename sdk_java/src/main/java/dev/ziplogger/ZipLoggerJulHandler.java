package dev.ziplogger;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;

/**
 * java.util.logging handler for ZipLogger:
 *
 * <pre>{@code
 * var client = new ZipLoggerClient(new ZipLoggerClient.Options(
 *     "https://app.ziplogger.dev", "zk_..."));
 * Logger.getLogger("").addHandler(new ZipLoggerJulHandler(client));
 * }</pre>
 *
 * SLF4J/Logback users: route through {@code jul-to-slf4j}'s inverse or log via the
 * {@link ZipLoggerClient} directly; a native Logback appender is on the roadmap.
 */
public final class ZipLoggerJulHandler extends Handler {

    private final ZipLoggerClient client;
    private final boolean ownsClient;

    public ZipLoggerJulHandler(ZipLoggerClient client) {
        this(client, false);
    }

    public ZipLoggerJulHandler(ZipLoggerClient client, boolean closeClientOnShutdown) {
        this.client = client;
        this.ownsClient = closeClientOnShutdown;
    }

    @Override
    public void publish(LogRecord record) {
        if (record == null || !isLoggable(record)) return;

        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("category", record.getLoggerName());
        Object[] parameters = record.getParameters();
        if (parameters != null) {
            for (int i = 0; i < parameters.length; i++) fields.put("param" + i, String.valueOf(parameters[i]));
        }

        ZipLoggerClient.Entry entry = new ZipLoggerClient.Entry()
                .message(formatMessage(record))
                .severity(mapLevel(record.getLevel()));
        entry.timestamp = record.getInstant();
        entry.fields = fields;
        if (record.getThrown() != null) entry.error(record.getThrown());
        client.log(entry);
    }

    private static String formatMessage(LogRecord record) {
        try {
            return new java.util.logging.SimpleFormatter().formatMessage(record);
        } catch (Exception e) {
            return String.valueOf(record.getMessage());
        }
    }

    private static String mapLevel(Level level) {
        int value = level.intValue();
        if (value >= Level.SEVERE.intValue()) return "error";
        if (value >= Level.WARNING.intValue()) return "warn";
        if (value >= Level.INFO.intValue()) return "info";
        return "debug";
    }

    @Override
    public void flush() { /* delivery is asynchronous; close() flushes */ }

    @Override
    public void close() {
        if (ownsClient) client.close();
    }
}
