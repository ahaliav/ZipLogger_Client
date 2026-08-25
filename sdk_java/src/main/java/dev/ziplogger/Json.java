package dev.ziplogger;

import java.util.List;
import java.util.Map;

/** Minimal JSON writer (JDK-only; the SDK carries no dependencies). Write-only, string keys. */
final class Json {
    private Json() {}

    static String write(Object value) {
        StringBuilder out = new StringBuilder(64);
        append(out, value);
        return out.toString();
    }

    private static void append(StringBuilder out, Object value) {
        if (value == null) { out.append("null"); return; }
        if (value instanceof String text) { appendString(out, text); return; }
        if (value instanceof Number || value instanceof Boolean) { out.append(value); return; }
        if (value instanceof Map<?, ?> map) {
            out.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!first) out.append(',');
                first = false;
                appendString(out, String.valueOf(entry.getKey()));
                out.append(':');
                append(out, entry.getValue());
            }
            out.append('}');
            return;
        }
        if (value instanceof List<?> list) {
            out.append('[');
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) out.append(',');
                append(out, list.get(i));
            }
            out.append(']');
            return;
        }
        appendString(out, String.valueOf(value)); // dates, enums, anything else
    }

    private static void appendString(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        out.append('"');
    }
}
