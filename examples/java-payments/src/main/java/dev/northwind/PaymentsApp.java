package dev.northwind;

import dev.ziplogger.ZipLoggerClient;
import dev.ziplogger.ZipLoggerJulHandler;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ThreadLocalRandom;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Northwind Coffee — payments service (Java).
 *
 * Captures payments for placed orders and logs through java.util.logging. The
 * ZipLogger handler attaches to JUL, so an existing service adopts ZipLogger by
 * adding one handler rather than by changing logging calls.
 *
 * Two things go wrong on purpose. Cards decline, which is an expected business
 * outcome logged as a warning. Currency conversion for an unlisted currency
 * throws a real IllegalStateException, which is a defect and is logged with the
 * throwable so ZipLogger receives the stack trace.
 */
public final class PaymentsApp {

    private static final Logger LOG = Logger.getLogger("payments");

    private static final List<String> CURRENCIES = List.of("EUR", "USD", "GBP", "ILS", "CHF");

    /** Rates against EUR. CHF is deliberately missing: the roastery added it without updating this table. */
    private static final Map<String, BigDecimal> RATES = Map.of(
            "EUR", new BigDecimal("1.00"),
            "USD", new BigDecimal("1.09"),
            "GBP", new BigDecimal("0.85"),
            "ILS", new BigDecimal("4.02"));

    private static final Random RANDOM = new Random();

    private PaymentsApp() {
    }

    /** Converts an amount into EUR for the ledger. */
    static BigDecimal toEuros(BigDecimal amount, String currency) {
        BigDecimal rate = RATES.get(currency);
        if (rate == null) {
            throw new IllegalStateException("No exchange rate configured for " + currency);
        }
        return amount.divide(rate, 2, RoundingMode.HALF_UP);
    }

    static void capturePayment() {
        String orderId = "NW-" + (100000 + RANDOM.nextInt(899999));
        String currency = CURRENCIES.get(RANDOM.nextInt(CURRENCIES.size()));
        BigDecimal amount = BigDecimal.valueOf(ThreadLocalRandom.current().nextDouble(12, 240))
                .setScale(2, RoundingMode.HALF_UP);
        String last4 = String.format("%04d", RANDOM.nextInt(10000));

        try {
            BigDecimal euros = toEuros(amount, currency);

            // Roughly one card in eight declines. That is business as usual, not a defect.
            if (RANDOM.nextInt(8) == 0) {
                LOG.log(Level.WARNING, "Card declined for order " + orderId
                        + " (" + amount + " " + currency + ", card ending " + last4 + ")");
                return;
            }

            LOG.log(Level.INFO, "Captured " + amount + " " + currency + " (" + euros + " EUR)"
                    + " for order " + orderId + ", card ending " + last4);

            if (euros.compareTo(new BigDecimal("180")) > 0) {
                LOG.log(Level.WARNING, "High-value capture held for review: order " + orderId
                        + " at " + euros + " EUR");
            }
        } catch (IllegalStateException ex) {
            // Logging the throwable is what gives ZipLogger the stack trace behind
            // "which commit broke this?".
            LOG.log(Level.SEVERE, "Payment capture failed for order " + orderId
                    + " in " + currency, ex);
        }
    }

    public static void main(String[] args) throws Exception {
        String endpoint = envOr("ZIPLOGGER_ENDPOINT", "https://app.ziplogger.dev");
        String apiKey = System.getenv("ZIPLOGGER_API_KEY");
        if (apiKey == null || apiKey.isBlank()) {
            System.err.println("ZIPLOGGER_API_KEY is required");
            System.exit(1);
        }

        long intervalMs = (long) (Double.parseDouble(envOr("DEMO_INTERVAL_SECONDS", "7")) * 1000);

        ZipLoggerClient.Options options = new ZipLoggerClient.Options(endpoint, apiKey);
        options.source = "payments";
        options.environment = envOr("ZIPLOGGER_ENVIRONMENT", "production");
        options.tags = List.of("demo", "java");

        ZipLoggerClient client = new ZipLoggerClient(options);
        LOG.addHandler(new ZipLoggerJulHandler(client));
        LOG.setLevel(Level.INFO);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.log(Level.INFO, "Payments service stopping");
            client.close();
        }));

        LOG.log(Level.INFO, "Payments service started with " + RATES.size() + " configured rates");

        while (true) {
            capturePayment();
            Thread.sleep(intervalMs);
        }
    }

    private static String envOr(String key, String fallback) {
        String value = System.getenv(key);
        return (value == null || value.isBlank()) ? fallback : value;
    }
}
