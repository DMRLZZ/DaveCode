/** Placeholder printed instead of a sensitive value. */
export const REDACTED = '[redacted]';

/**
 * Keys whose values are credentials: `server.authToken`, any `apiKey`, `password`, `secret`…
 * Matched on the end of the key so counters such as `maxTokens` or `tokens5h` stay visible.
 */
const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[-_]?key|credentials?|cookies?|authorization|private[-_]?key)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Hide the password in `scheme://user:password@host` URLs. */
export function redactUrlCredentials(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@\s]*):[^@/\s]*@/i, `$1:${REDACTED}@`);
}

/**
 * Deep copy of `value` with sensitive values replaced by `[redacted]`. Empty or missing values
 * stay as they are, so `config show` still tells you whether a token is set.
 */
export function redact<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isSensitiveKey(key) && value !== undefined && value !== null) {
    if (value === '' || (typeof value === 'object' && Object.keys(value).length === 0)) {
      return value;
    }
    return REDACTED;
  }
  if (typeof value === 'string') return redactUrlCredentials(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, undefined));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}

/** Read `a.b.c` from a plain object. Returns `{ found: false }` for missing paths. */
export function getPath(
  value: unknown,
  path: string,
): { found: true; value: unknown } | { found: false } {
  let current: unknown = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return { found: false };
    const record = current as Record<string, unknown>;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = (current as unknown[])[Number(segment)];
    } else if (Object.hasOwn(record, segment)) {
      current = record[segment];
    } else {
      return { found: false };
    }
    if (current === undefined) return { found: false };
  }
  return { found: true, value: current };
}
