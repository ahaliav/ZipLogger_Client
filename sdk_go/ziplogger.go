// Package ziplogger is the official Go SDK for ZipLogger.
//
// It mirrors the delivery semantics of the other ZipLogger SDKs:
//   - Log never blocks and never panics — delivery is fully asynchronous;
//   - a bounded channel with drop-on-backpressure (counted, never unbounded memory);
//   - NDJSON batches over HTTP with retry + exponential backoff, honoring 429 Retry-After;
//   - automatic enrichment: source, release, commit SHA, environment, hostname.
//
// Standard library only.
package ziplogger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Options configures a Client. Endpoint and APIKey are required.
type Options struct {
	// Endpoint is the ZipLogger base URL, e.g. "https://app.ziplogger.ai".
	Endpoint string
	// APIKey is the tenant ingestion key (zk_...).
	APIKey string

	// Enrichment (auto-detected when empty).
	Source      string   // default: executable name or ZIPLOGGER_SOURCE
	Release     string   // default: ZIPLOGGER_RELEASE
	CommitSha   string   // default: ZIPLOGGER_COMMIT_SHA / GIT_COMMIT / COMMIT_SHA
	Environment string   // default: ZIPLOGGER_ENVIRONMENT / "production"
	Tags        []string // added to every entry

	// Delivery behavior (zero values take the documented defaults).
	QueueCapacity  int           // default 10000; new entries drop when full
	BatchSize      int           // default 100
	FlushInterval  time.Duration // default 2s
	MaxRetries     int           // default 5
	RetryBaseDelay time.Duration // default 500ms
	RetryMaxDelay  time.Duration // default 30s
	Timeout        time.Duration // default 10s per request

	// HTTPClient overrides the default client (useful for tests/proxies).
	HTTPClient *http.Client
}

// Entry is one log event. Message is the only required field.
type Entry struct {
	Timestamp  time.Time
	Severity   string // debug | info | warn | error | fatal (default info)
	Message    string
	Source     string
	Release    string
	CommitSha  string
	StackTrace string
	Err        error // convenience: fills StackTrace/exception fields
	Fields     map[string]any
	Tags       []string
}

// Client ships log entries to a ZipLogger server in the background.
type Client struct {
	opts     Options
	url      string
	http     *http.Client
	queue    chan map[string]any
	done     chan struct{}
	wg       sync.WaitGroup
	dropped  atomic.Int64
	hostname string
	closed   atomic.Bool
}

// New validates the options and starts the background shipper.
func New(opts Options) (*Client, error) {
	if opts.Endpoint == "" {
		return nil, fmt.Errorf("ziplogger: Endpoint is required")
	}
	if opts.APIKey == "" {
		return nil, fmt.Errorf("ziplogger: APIKey is required")
	}
	setDefaults(&opts)

	trimmed := strings.TrimRight(opts.Endpoint, "/")
	url := trimmed
	if !strings.HasSuffix(strings.ToLower(trimmed), "/logs") {
		url = trimmed + "/ingest/v1/logs"
	}

	hostname, _ := os.Hostname()
	client := &Client{
		opts:     opts,
		url:      url,
		http:     opts.HTTPClient,
		queue:    make(chan map[string]any, opts.QueueCapacity),
		done:     make(chan struct{}),
		hostname: hostname,
	}
	if client.http == nil {
		client.http = &http.Client{Timeout: opts.Timeout}
	}
	client.wg.Add(1)
	go client.pump()
	return client, nil
}

// Dropped reports entries lost to backpressure or exhausted retries.
func (c *Client) Dropped() int64 { return c.dropped.Load() }

// Log queues an entry for background delivery. It never blocks and never panics.
func (c *Client) Log(entry Entry) {
	if c.closed.Load() {
		c.dropped.Add(1)
		return
	}
	select {
	case c.queue <- c.toRecord(entry):
	default:
		c.dropped.Add(1)
	}
}

func (c *Client) toRecord(entry Entry) map[string]any {
	fields := map[string]any{
		"environment": c.opts.Environment,
		"machineName": c.hostname,
	}
	for key, value := range entry.Fields {
		fields[key] = value
	}
	if entry.Err != nil {
		if entry.StackTrace == "" {
			entry.StackTrace = entry.Err.Error()
		}
		fields["exceptionType"] = fmt.Sprintf("%T", entry.Err)
		fields["exceptionMessage"] = entry.Err.Error()
	}

	severity := entry.Severity
	switch severity {
	case "debug", "info", "warn", "error", "fatal":
	case "warning":
		severity = "warn"
	default:
		severity = "info"
	}
	timestamp := entry.Timestamp
	if timestamp.IsZero() {
		timestamp = time.Now().UTC()
	}

	record := map[string]any{
		"timestamp": timestamp.Format(time.RFC3339Nano),
		"severity":  severity,
		"message":   entry.Message,
		"source":    firstNonEmpty(entry.Source, c.opts.Source),
		"fields":    fields,
	}
	if release := firstNonEmpty(entry.Release, c.opts.Release); release != "" {
		record["release"] = release
	}
	if sha := firstNonEmpty(entry.CommitSha, c.opts.CommitSha); sha != "" {
		record["commitSha"] = sha
	}
	if entry.StackTrace != "" {
		record["stackTrace"] = entry.StackTrace
	}
	if tags := entry.Tags; len(tags) > 0 {
		record["tags"] = tags
	} else if len(c.opts.Tags) > 0 {
		record["tags"] = c.opts.Tags
	}
	return record
}

func (c *Client) pump() {
	defer c.wg.Done()
	batch := make([]map[string]any, 0, c.opts.BatchSize)
	timer := time.NewTimer(c.opts.FlushInterval)
	defer timer.Stop()

	flush := func() {
		if len(batch) > 0 {
			c.send(batch)
			batch = batch[:0]
		}
	}
	for {
		select {
		case record := <-c.queue:
			batch = append(batch, record)
			if len(batch) == 1 {
				resetTimer(timer, c.opts.FlushInterval)
			}
			if len(batch) >= c.opts.BatchSize {
				flush()
			}
		case <-timer.C:
			flush()
			resetTimer(timer, c.opts.FlushInterval)
		case <-c.done:
			// Drain whatever is buffered, then exit.
			for {
				select {
				case record := <-c.queue:
					batch = append(batch, record)
					if len(batch) >= c.opts.BatchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		}
	}
}

func (c *Client) send(batch []map[string]any) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	for _, record := range batch {
		if err := encoder.Encode(record); err != nil {
			c.dropped.Add(1)
		}
	}

	for attempt := 0; ; attempt++ {
		retryAfter := time.Duration(-1)

		request, err := http.NewRequest(http.MethodPost, c.url, bytes.NewReader(buf.Bytes()))
		if err == nil {
			request.Header.Set("Content-Type", "application/x-ndjson")
			request.Header.Set("X-Api-Key", c.opts.APIKey)
			response, sendErr := c.http.Do(request)
			if sendErr == nil {
				func() {
					defer response.Body.Close()
					if response.StatusCode >= 200 && response.StatusCode < 300 {
						return
					}
					if response.StatusCode != http.StatusTooManyRequests &&
						response.StatusCode != http.StatusRequestTimeout &&
						response.StatusCode < 500 {
						retryAfter = -2 // non-transient: drop
						return
					}
					if header := response.Header.Get("Retry-After"); header != "" {
						if seconds, parseErr := strconv.ParseFloat(header, 64); parseErr == nil {
							retryAfter = time.Duration(seconds * float64(time.Second))
						}
					}
				}()
				if response.StatusCode >= 200 && response.StatusCode < 300 {
					return
				}
				if retryAfter == -2 {
					c.dropped.Add(int64(len(batch)))
					return
				}
			}
		}

		if attempt >= c.opts.MaxRetries {
			c.dropped.Add(int64(len(batch)))
			return
		}
		delay := retryAfter
		if delay < 0 {
			backoff := c.opts.RetryBaseDelay << uint(attempt)
			if backoff > c.opts.RetryMaxDelay {
				backoff = c.opts.RetryMaxDelay
			}
			delay = backoff + time.Duration(rand.Int63n(int64(backoff)/5+1))
		}
		if delay > c.opts.RetryMaxDelay {
			delay = c.opts.RetryMaxDelay
		}
		select {
		case <-time.After(delay):
		case <-c.done:
			if c.closed.Load() {
				// Shutting down: one final immediate attempt, then give up.
				if attempt >= c.opts.MaxRetries-1 {
					c.dropped.Add(int64(len(batch)))
					return
				}
			}
		}
	}
}

// Close flushes buffered entries (bounded by timeout) and stops the shipper.
func (c *Client) Close(timeout time.Duration) {
	if c.closed.Swap(true) {
		return
	}
	close(c.done)
	finished := make(chan struct{})
	go func() { c.wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(timeout):
	}
}

func setDefaults(opts *Options) {
	if opts.QueueCapacity <= 0 {
		opts.QueueCapacity = 10_000
	}
	if opts.BatchSize <= 0 {
		opts.BatchSize = 100
	}
	if opts.FlushInterval <= 0 {
		opts.FlushInterval = 2 * time.Second
	}
	if opts.MaxRetries < 0 {
		opts.MaxRetries = 0
	} else if opts.MaxRetries == 0 {
		opts.MaxRetries = 5
	}
	if opts.RetryBaseDelay <= 0 {
		opts.RetryBaseDelay = 500 * time.Millisecond
	}
	if opts.RetryMaxDelay <= 0 {
		opts.RetryMaxDelay = 30 * time.Second
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 10 * time.Second
	}
	if opts.Source == "" {
		opts.Source = envOr("ZIPLOGGER_SOURCE", executableName())
	}
	if opts.Release == "" {
		opts.Release = os.Getenv("ZIPLOGGER_RELEASE")
	}
	if opts.CommitSha == "" {
		opts.CommitSha = firstNonEmpty(
			os.Getenv("ZIPLOGGER_COMMIT_SHA"), os.Getenv("GIT_COMMIT"), os.Getenv("COMMIT_SHA"))
	}
	if opts.Environment == "" {
		opts.Environment = envOr("ZIPLOGGER_ENVIRONMENT", "production")
	}
}

func resetTimer(timer *time.Timer, interval time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(interval)
}

func executableName() string {
	path, err := os.Executable()
	if err != nil {
		return "go"
	}
	name := filepath.Base(path)
	return strings.TrimSuffix(name, filepath.Ext(name))
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
