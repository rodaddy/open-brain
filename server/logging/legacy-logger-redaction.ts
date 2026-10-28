import { SECRET_PATTERNS } from "../security/secret-patterns.ts";

/**
 * Strip known secret material from a string bound for a log entry.
 *
 * Applies `SECRET_PATTERNS` — the same detector set that gates shared-kb
 * promotion and the Python client's `policy.py` — rather than a second, weaker
 * redaction fork.
 *
 * `redactText()` is deliberately NOT reused here: it emits a `logger.warn` when
 * it changes something, and this function runs *inside* the log path, so that
 * would recurse. The patterns are applied directly and the substitution is
 * silent; the redaction marker in the output is the evidence.
 *
 * Lives here, not in `observability/with-logging.ts` where it started, because
 * review found it was applied only to `error_name`/`error_message`/`error_stack`
 * — so the identical DSN went out redacted in `error_message` and in clear in a
 * caller-supplied field on the same line. Redaction belongs at the envelope,
 * which is here, and that also covers `contextFields()` output. `with-logging`
 * imports it from this module; the reverse would be a cycle.
 *
 * The input is bounded first: `PRIVATE_KEY_BLOCK_RE` is quadratic on repeated
 * `-----BEGIN` markers with no `END` (measured 625 KB -> 3.9 s of blocked event
 * loop), and an unbounded string in a log line is its own problem regardless.
 */
const MAX_REDACT_INPUT_CHARS = 16_384;

export function redactForLog(value: string): string {
  if (!value) return value;

  // Redact FIRST, truncate second. The original order truncated first, which
  // manufactured the leak it was meant to bound: a DSN straddling the 16 KB
  // boundary was cut mid-credential, so no pattern matched the surviving head
  // and `postgres://user:supe` went out in clear. Cutting a string cannot
  // create a secret, but it can destroy the evidence that one is present.
  //
  // The quadratic `PRIVATE_KEY_BLOCK_RE` risk that motivated the bound still
  // has to be handled, so the pathological input is capped before matching --
  // see `boundForMatching` below -- rather than by truncating every input.
  let redacted = boundForMatching(value);
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    redacted = redacted.replace(new RegExp(pattern.source, flags), "[REDACTED]");
  }
  return redacted.length > MAX_REDACT_INPUT_CHARS
    ? `${redacted.slice(0, MAX_REDACT_INPUT_CHARS)}…[truncated ${redacted.length - MAX_REDACT_INPUT_CHARS} chars]`
    : redacted;
}

/**
 * Neutralize the one input shape that makes redaction itself expensive.
 *
 * `PRIVATE_KEY_BLOCK_RE` is quadratic on repeated `-----BEGIN` markers with no
 * matching `-----END` (measured: 625 KB -> 3.9 s of blocked event loop). That
 * is the only measured pathology, and it is driven by the *count of unmatched
 * BEGIN markers*, not by length — so it is bounded directly instead of by
 * truncating every long string, which is what split credentials before.
 *
 * Inputs with more BEGIN markers than could plausibly be real key blocks are
 * collapsed to a marker-free summary; everything else is matched in full.
 */
const MAX_PRIVATE_KEY_MARKERS = 8;

function boundForMatching(value: string): string {
  if (value.length <= MAX_REDACT_INPUT_CHARS) return value;
  const beginMarkers = value.match(/-----BEGIN /g)?.length ?? 0;
  const endMarkers = value.match(/-----END /g)?.length ?? 0;
  if (beginMarkers <= MAX_PRIVATE_KEY_MARKERS || beginMarkers === endMarkers) {
    return value;
  }
  // Unbalanced and marker-dense: the quadratic case. Strip the markers so the
  // block pattern cannot backtrack, and say so in the output.
  return `${value.replace(/-----BEGIN /g, "[BEGIN] ")}…[key-marker dense input: ${beginMarkers} unmatched markers neutralized]`;
}
