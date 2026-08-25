// Northwind Coffee — inventory sync (Go).
//
// A background job that reconciles warehouse stock against the roastery feed and
// logs through log/slog. The slog handler ships every record to ZipLogger, so the
// standard library stays the logging interface and nothing in the job's code has
// to know where logs go.
//
// The feed occasionally returns a malformed row. Parsing it produces a real
// error, which is logged with the stack context ZipLogger uses to attribute the
// failure to a commit.
package main

import (
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	ziplogger "github.com/ahaliav/ZipLogger_Client/sdk_go"
)

type warehouse struct {
	Code string
	City string
}

var warehouses = []warehouse{
	{"AMS-1", "Amsterdam"},
	{"BER-2", "Berlin"},
	{"TLV-1", "Tel Aviv"},
}

var skus = []string{"ETH-YIRG-250", "COL-HUILA-1K", "KEN-AA-250", "BRZ-SANTOS-500", "DECAF-SWP-250"}

// ErrMalformedRow is returned when the roastery feed sends a row we cannot parse.
var ErrMalformedRow = errors.New("malformed feed row")

// parseFeedRow reads one "SKU,QUANTITY" line from the roastery feed.
func parseFeedRow(row string) (string, int, error) {
	parts := strings.Split(row, ",")
	if len(parts) != 2 {
		return "", 0, fmt.Errorf("%w: expected 2 columns, got %d in %q", ErrMalformedRow, len(parts), row)
	}
	quantity, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil {
		return "", 0, fmt.Errorf("%w: quantity %q is not a number", ErrMalformedRow, parts[1])
	}
	return strings.TrimSpace(parts[0]), quantity, nil
}

// nextFeedRow simulates the roastery feed. Roughly one row in twelve is corrupt,
// which is what makes this demo produce real errors rather than fake ones.
func nextFeedRow() string {
	sku := skus[rand.Intn(len(skus))]
	if rand.Intn(12) == 0 {
		return sku + ",n/a"
	}
	return fmt.Sprintf("%s,%d", sku, rand.Intn(120))
}

func syncOnce(log *slog.Logger) {
	site := warehouses[rand.Intn(len(warehouses))]
	row := nextFeedRow()
	started := time.Now()

	sku, quantity, err := parseFeedRow(row)
	elapsed := time.Since(started)

	if err != nil {
		log.Error("Inventory sync failed",
			"warehouse", site.Code,
			"city", site.City,
			"row", row,
			// Passing the error value (not err.Error()) is what fills ZipLogger's
			// stackTrace and exception fields.
			"error", err,
		)
		return
	}

	if quantity == 0 {
		log.Warn("Warehouse reports zero stock",
			"warehouse", site.Code, "city", site.City, "sku", sku)
	}

	log.Info("Inventory synced",
		"warehouse", site.Code,
		"city", site.City,
		"sku", sku,
		"quantity", quantity,
		"durationMs", elapsed.Milliseconds(),
	)
}

func main() {
	endpoint := envOr("ZIPLOGGER_ENDPOINT", "https://app.ziplogger.dev")
	apiKey := os.Getenv("ZIPLOGGER_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "ZIPLOGGER_API_KEY is required")
		os.Exit(1)
	}

	interval := 6 * time.Second
	if raw := os.Getenv("DEMO_INTERVAL_SECONDS"); raw != "" {
		if seconds, err := strconv.ParseFloat(raw, 64); err == nil {
			interval = time.Duration(seconds * float64(time.Second))
		}
	}

	client, err := ziplogger.New(ziplogger.Options{
		Endpoint:    endpoint,
		APIKey:      apiKey,
		Source:      "inventory",
		Environment: envOr("ZIPLOGGER_ENVIRONMENT", "production"),
		Tags:        []string{"demo", "go"},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "ziplogger:", err)
		os.Exit(1)
	}
	defer client.Close(5 * time.Second)

	log := slog.New(ziplogger.NewSlogHandler(client, slog.LevelInfo))
	log.Info("Inventory sync started", "warehouses", len(warehouses), "skus", len(skus))

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	for {
		select {
		case <-ticker.C:
			syncOnce(log)
		case <-stop:
			log.Info("Inventory sync stopping")
			return
		}
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
