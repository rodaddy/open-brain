/**
 * Safe structured log-value projection.
 *
 * Design authority: `_DOCS/STANDARDS-observability.md` defines the required
 * recursive projection shape and forbids arbitrary object stringifying.
 */
const SENSITIVE_PARTS = new Set([
  "password",
  "passphrase",
  "secret",
  "token",
  "api_key",
  "authorization",
  "cookie",
  "session",
  "credential",
  "private_key",
]);

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return [...SENSITIVE_PARTS].some((part) =>
    normalized === part || normalized.startsWith(`${part}_`) || normalized.endsWith(`_${part}`)
  );
}

function shape(value: object): Record<string, unknown> {
  if (Array.isArray(value)) return { type: "array", item_count: value.length };
  return { type: value.constructor?.name ?? "object", key_count: Object.keys(value).length };
}

function sanitizeObject(value: object, depth: number): unknown {
  if (depth >= 4) return shape(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
    return value.length > 50 ? [...items, { remaining_items: value.length - 50 }] : items;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return shape(value);
  const output: Record<string, unknown> = {};
  const keys = Object.keys(value);
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1);
  }
  if (keys.length > 50) output.remaining_keys = keys.length - 50;
  return output;
}

/** Convert an untrusted value into safe structured data. */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > 200
      ? `${value.slice(0, 200)}…[${value.length - 200} characters omitted]`
      : value;
  }
  if (value instanceof Error) return { type: value.name || "Error" };
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return { type: typeof value };
  if (typeof value !== "object" || value === null) return value;
  return sanitizeObject(value, depth);
}
