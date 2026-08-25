package ziplogger

import (
	"context"
	"log/slog"
)

// NewSlogHandler adapts a Client to the standard library's structured logger:
//
//	client, _ := ziplogger.New(ziplogger.Options{Endpoint: "...", APIKey: "zk_..."})
//	logger := slog.New(ziplogger.NewSlogHandler(client, slog.LevelInfo))
//	logger.Info("order created", "orderId", 83112)
//
// Attributes become searchable ZipLogger fields; an attr named "err"/"error" of type
// error maps to the stack-trace/exception fields.
func NewSlogHandler(client *Client, level slog.Leveler) slog.Handler {
	return &slogHandler{client: client, level: level}
}

type slogHandler struct {
	client *Client
	level  slog.Leveler
	// fields carries WithAttrs values, keys already qualified by the groups
	// that were open when WithAttrs was called (per slog semantics).
	fields map[string]any
	group  string
}

func (h *slogHandler) Enabled(_ context.Context, level slog.Level) bool {
	minimum := slog.LevelInfo
	if h.level != nil {
		minimum = h.level.Level()
	}
	return level >= minimum
}

func (h *slogHandler) Handle(_ context.Context, record slog.Record) error {
	entry := Entry{
		Timestamp: record.Time,
		Severity:  mapSlogLevel(record.Level),
		Message:   record.Message,
		Fields:    make(map[string]any, len(h.fields)+record.NumAttrs()),
	}
	for key, value := range h.fields {
		entry.Fields[key] = value
	}
	record.Attrs(func(attr slog.Attr) bool {
		if err, ok := attr.Value.Any().(error); ok && (attr.Key == "err" || attr.Key == "error") {
			entry.Err = err
			return true
		}
		entry.Fields[h.qualify(attr.Key)] = attr.Value.Any()
		return true
	})
	h.client.Log(entry)
	return nil
}

func (h *slogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *h
	clone.fields = make(map[string]any, len(h.fields)+len(attrs))
	for key, value := range h.fields {
		clone.fields[key] = value
	}
	for _, attr := range attrs {
		clone.fields[h.qualify(attr.Key)] = attr.Value.Any()
	}
	return &clone
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	clone := *h
	if clone.group == "" {
		clone.group = name
	} else {
		clone.group += "." + name
	}
	return &clone
}

func (h *slogHandler) qualify(key string) string {
	if h.group == "" {
		return key
	}
	return h.group + "." + key
}

func mapSlogLevel(level slog.Level) string {
	switch {
	case level < slog.LevelInfo:
		return "debug"
	case level < slog.LevelWarn:
		return "info"
	case level < slog.LevelError:
		return "warn"
	case level < slog.LevelError+4:
		return "error"
	default:
		return "fatal"
	}
}
