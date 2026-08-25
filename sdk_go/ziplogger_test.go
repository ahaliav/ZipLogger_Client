package ziplogger

import (
	"bufio"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type capture struct {
	mu        sync.Mutex
	requests  [][]map[string]any
	apiKeys   []string
	paths     []string
	responses []int          // queued status codes; default 202
	block     chan struct{}  // when set, requests hang here after being recorded
}

func (c *capture) server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var lines []map[string]any
		scanner := bufio.NewScanner(r.Body)
		for scanner.Scan() {
			var record map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &record); err == nil {
				lines = append(lines, record)
			}
		}
		c.mu.Lock()
		c.requests = append(c.requests, lines)
		c.apiKeys = append(c.apiKeys, r.Header.Get("X-Api-Key"))
		c.paths = append(c.paths, r.URL.Path)
		status := 202
		if len(c.responses) > 0 {
			status = c.responses[0]
			c.responses = c.responses[1:]
		}
		block := c.block
		c.mu.Unlock()

		if block != nil {
			<-block // hold the request in flight so tests can fill the queue deterministically
		}
		if status == 429 {
			w.Header().Set("Retry-After", "0")
		}
		w.WriteHeader(status)
	}))
}

func (c *capture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.requests)
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in time")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func testOptions(url string) Options {
	return Options{
		Endpoint:       url,
		APIKey:         "zk_test",
		Source:         "unit-test",
		FlushInterval:  30 * time.Millisecond,
		RetryBaseDelay: 10 * time.Millisecond,
	}
}

func TestBatchesNDJSONWithEnrichment(t *testing.T) {
	cap := &capture{}
	server := cap.server(t)
	defer server.Close()

	opts := testOptions(server.URL)
	opts.Release = "1.2.3"
	opts.CommitSha = "abc1234"
	client, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		client.Log(Entry{Severity: "info", Message: "event", Fields: map[string]any{"i": i}})
	}
	client.Close(5 * time.Second)

	if cap.count() != 1 {
		t.Fatalf("expected 1 request, got %d", cap.count())
	}
	if cap.paths[0] != "/ingest/v1/logs" {
		t.Fatalf("wrong path %q", cap.paths[0])
	}
	if cap.apiKeys[0] != "zk_test" {
		t.Fatalf("wrong api key %q", cap.apiKeys[0])
	}
	lines := cap.requests[0]
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d", len(lines))
	}
	first := lines[0]
	if first["source"] != "unit-test" || first["release"] != "1.2.3" || first["commitSha"] != "abc1234" {
		t.Fatalf("enrichment missing: %v", first)
	}
	fields := first["fields"].(map[string]any)
	if fields["machineName"] == "" || fields["environment"] != "production" {
		t.Fatalf("field enrichment missing: %v", fields)
	}
}

func TestErrorMapsToExceptionFields(t *testing.T) {
	cap := &capture{}
	server := cap.server(t)
	defer server.Close()

	client, _ := New(testOptions(server.URL))
	client.Log(Entry{Severity: "error", Message: "it failed", Err: errors.New("boom")})
	client.Close(5 * time.Second)

	entry := cap.requests[0][0]
	if entry["stackTrace"] != "boom" {
		t.Fatalf("stackTrace missing: %v", entry)
	}
	fields := entry["fields"].(map[string]any)
	if fields["exceptionMessage"] != "boom" {
		t.Fatalf("exception fields missing: %v", fields)
	}
}

func TestRetriesOn429ThenSucceeds(t *testing.T) {
	cap := &capture{responses: []int{429, 429, 202}}
	server := cap.server(t)
	defer server.Close()

	client, _ := New(testOptions(server.URL))
	client.Log(Entry{Message: "retry me"})
	waitFor(t, func() bool { return cap.count() >= 3 })
	client.Close(5 * time.Second)

	if client.Dropped() != 0 {
		t.Fatalf("expected no drops, got %d", client.Dropped())
	}
}

func TestDropsAfterMaxRetries(t *testing.T) {
	cap := &capture{responses: []int{500, 500, 500}}
	server := cap.server(t)
	defer server.Close()

	opts := testOptions(server.URL)
	opts.MaxRetries = 2
	client, _ := New(opts)
	client.Log(Entry{Message: "doomed"})
	waitFor(t, func() bool { return client.Dropped() >= 1 })
	if cap.count() != 3 { // initial + 2 retries
		t.Fatalf("expected 3 attempts, got %d", cap.count())
	}
	client.Close(time.Second)
}

func TestNonTransientErrorsDoNotRetry(t *testing.T) {
	cap := &capture{responses: []int{401}}
	server := cap.server(t)
	defer server.Close()

	client, _ := New(testOptions(server.URL))
	client.Log(Entry{Message: "bad key"})
	waitFor(t, func() bool { return client.Dropped() >= 1 })
	if cap.count() != 1 {
		t.Fatalf("expected 1 attempt, got %d", cap.count())
	}
	client.Close(time.Second)
}

func TestQueueOverflowDropsInsteadOfBlocking(t *testing.T) {
	cap := &capture{block: make(chan struct{})}
	server := cap.server(t)
	defer server.Close()

	opts := testOptions(server.URL)
	opts.QueueCapacity = 3
	opts.BatchSize = 2
	opts.FlushInterval = 10 * time.Millisecond
	client, _ := New(opts)

	// First entries get picked up and the request hangs in flight on the block channel.
	client.Log(Entry{Message: "in-flight"})
	client.Log(Entry{Message: "in-flight"})
	waitFor(t, func() bool { return cap.count() >= 1 })

	// With the worker stuck, the queue holds 3; everything beyond drops without blocking.
	start := time.Now()
	for i := 0; i < 50; i++ {
		client.Log(Entry{Message: "burst"})
	}
	if time.Since(start) > time.Second {
		t.Fatal("Log must not block")
	}
	if client.Dropped() < 40 {
		t.Fatalf("expected drops, got %d", client.Dropped())
	}
	close(cap.block)
	client.Close(time.Second)
}

func TestSlogHandlerMapsLevelsAndAttrs(t *testing.T) {
	cap := &capture{}
	server := cap.server(t)
	defer server.Close()

	client, _ := New(testOptions(server.URL))
	logger := slog.New(NewSlogHandler(client, slog.LevelDebug))

	logger.Debug("d")
	logger.Info("order created", "orderId", 83112)
	logger.Warn("w")
	logger.Error("payment failed", "err", errors.New("card declined"))
	logger.With("service", "checkout").WithGroup("http").Info("request", "status", 500)
	client.Close(5 * time.Second)

	var lines []map[string]any
	for _, request := range cap.requests {
		lines = append(lines, request...)
	}
	if len(lines) != 5 {
		t.Fatalf("expected 5 entries, got %d", len(lines))
	}
	severities := []string{}
	for _, line := range lines {
		severities = append(severities, line["severity"].(string))
	}
	expected := []string{"debug", "info", "warn", "error", "info"}
	for i := range expected {
		if severities[i] != expected[i] {
			t.Fatalf("severities %v, expected %v", severities, expected)
		}
	}
	if fields := lines[1]["fields"].(map[string]any); fields["orderId"] != float64(83112) {
		t.Fatalf("attr mapping failed: %v", fields)
	}
	if lines[3]["stackTrace"] != "card declined" {
		t.Fatalf("err attr should map to stackTrace: %v", lines[3])
	}
	if fields := lines[4]["fields"].(map[string]any); fields["service"] != "checkout" || fields["http.status"] != float64(500) {
		t.Fatalf("With/WithGroup failed: %v", fields)
	}
}
