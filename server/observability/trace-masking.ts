/**
 * Credential masking for the tracing lane, applied at the final emitter
 * boundary per #561's masking-before-widening ruling.
 *
 * MASKING IS REPLACEMENT, NEVER FIELD REMOVAL. The operator still receives
 * every field and its surrounding content; only the credential-shaped span
 * inside a value is rewritten. That is the whole difference from
 * `server/logging/sanitize.ts`, which redacts for the local log envelope and is
 * free to drop and depth-clamp — the two are separate concerns and neither
 * substitutes for the other.
 *
 * Detection itself is NOT owned here: `src/secret-patterns.ts` owns the
 * detector set and the sensitive-key rule. This module is the application layer
 * over it, recursing structures the detectors never see.
 */
import { isSensitiveKey, SECRET_DETECTORS } from "../../src/secret-patterns.ts";

/**
 * The shared detectors, recompiled with the global flag.
 *
 * `String.replace` only rewrites every occurrence when the pattern is global,
 * and a detector authored without `g` would otherwise mask the first match in a
 * string and leave the rest in the clear.
 */
const COMPILED_SECRET_DETECTORS = SECRET_DETECTORS.map((detector) => ({
  kind: detector.kind,
  pattern: new RegExp(
    detector.pattern.source,
    detector.pattern.flags.includes("g")
      ? detector.pattern.flags
      : `${detector.pattern.flags}g`,
  ),
}));

function maskDetectorMatch(kind: string, match: string): string {
  const replacement = `[MASKED:${kind}]`;
  if (kind === "json_labeled_secret") {
    return match.replace(/"[^"]+"$/, `"${replacement}"`);
  }
  if (kind === "labeled_secret") {
    return match.replace(/([:=]\s*)[^\s,;]+$/, `$1${replacement}`);
  }
  return replacement;
}

/** Replace every detector match while retaining the rest of the string. */
function maskTraceString(value: string): string {
  let masked = value;
  for (const detector of COMPILED_SECRET_DETECTORS) {
    masked = masked.replace(detector.pattern, (match) =>
      maskDetectorMatch(detector.kind, match),
    );
  }
  return masked;
}

function binaryViewMarker(value: ArrayBufferView): {
  type: string;
  byteLength: number;
} {
  return {
    type: value.constructor.name || "ArrayBufferView",
    byteLength: value.byteLength,
  };
}

/**
 * Mask an array, returning the ORIGINAL when nothing changed.
 *
 * Identity on a clean value is deliberate throughout this module: a healthy
 * corpus is the common case, and returning the input unchanged keeps masking
 * from doubling the retained payload for every trace that had nothing to mask.
 */
function maskTraceArray(value: unknown[]): unknown {
  const masked = value.map(maskTraceValue);
  return masked.some((child, index) => child !== value[index]) ? masked : value;
}

/**
 * Normalize the built-in container types the detectors cannot walk.
 *
 * Returns `undefined` when `value` is not one of them, which is how the caller
 * distinguishes "handled here" from "fall through to plain-object masking" —
 * no built-in normalization of these types ever legitimately yields undefined.
 */
function maskBuiltinContainer(value: object): unknown | undefined {
  if (ArrayBuffer.isView(value)) return binaryViewMarker(value);
  if (value instanceof Map) {
    return maskTraceValue(
      Object.fromEntries(
        Array.from(value, ([key, child]) => [String(key), child]),
      ),
    );
  }
  if (value instanceof Set) return maskTraceValue(Array.from(value));
  if (value instanceof Error) {
    return maskTraceValue({ name: value.name, message: value.message });
  }
  return undefined;
}

/** Mask a plain object's own entries, copying only once a child changed. */
function maskTraceObject(value: object): unknown {
  let masked: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(value)) {
    const maskedChild =
      isSensitiveKey(key) && child !== null && child !== undefined
        ? "[MASKED:sensitive_key]"
        : maskTraceValue(child);
    if (maskedChild === child) continue;
    masked ??= { ...(value as Record<string, unknown>) };
    masked[key] = maskedChild;
  }
  return masked ?? value;
}

/** Recursively normalize and mask values without removing fields or array items. */
export function maskTraceValue(value: unknown): unknown {
  if (typeof value === "string") return maskTraceString(value);
  if (Array.isArray(value)) return maskTraceArray(value);
  if (!value || typeof value !== "object") return value;
  const builtin = maskBuiltinContainer(value);
  if (builtin !== undefined) return builtin;
  return maskTraceObject(value);
}
