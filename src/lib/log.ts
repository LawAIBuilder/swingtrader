// Centralized structured logger. Writes a single JSON line per event so
// Vercel's runtime log search ("event:run_log_boot_failure") works. We
// intentionally do NOT swap in pino/winston: a 30-line helper covers every
// place we currently log, has zero dependencies, and never blocks the event
// loop on a flush.
//
// Conventions:
//  - Always write JSON. Plain console.log strings get parsed inconsistently
//    by Vercel's log viewer.
//  - Always include `event` so a query can filter by name without grepping
//    free-form messages.
//  - Never include secrets, even by accident. The redact() helper strips
//    fields named like {token, secret, key, authorization, password,
//    cookie} (case-insensitive) at any depth.

type Level = 'info' | 'warn' | 'error';

interface LogPayload {
  event: string;
  [key: string]: unknown;
}

const SECRET_KEY_RE = /^(token|secret|api[_-]?key|password|cookie|authorization|bearer)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<truncated>';
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '<redacted>';
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function emit(level: Level, payload: LogPayload): void {
  const safe = redact(payload) as LogPayload;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    ...safe
  });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields: Record<string, unknown> = {}): void {
  emit('info', { event, ...fields });
}

export function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  emit('warn', { event, ...fields });
}

export function logError(event: string, fields: Record<string, unknown> = {}): void {
  emit('error', { event, ...fields });
}

// Helpful when an Error needs to be logged without dumping the full stack
// (which Vercel renders awkwardly inside JSON). Returns a flat record.
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      // Stack is intentionally omitted from the default field set; a caller
      // can include it explicitly if useful for a specific event.
      cause: (err as { cause?: unknown }).cause != null ? String((err as { cause?: unknown }).cause) : undefined
    };
  }
  return { errorMessage: String(err) };
}

// Internal export for tests.
export const _redactForTests = redact;
