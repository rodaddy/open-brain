/**
 * Check shapes -- schema and inferred types, no behaviour.
 *
 * WHY ZOD AND NOT A BARE `interface`
 *
 * An `interface` is erased at runtime. It describes what you HOPE arrives and
 * checks nothing when it does not, so a malformed API response or a hand-edited
 * config file flows straight in and surfaces two hundred lines later as
 * "cannot read property of undefined" -- far from the boundary that let it in.
 *
 * Zod validates at the boundary and `z.infer` gives the static type from the
 * same declaration, so the runtime check and the compile-time type cannot drift.
 * One source, both guarantees. This is the direct counterpart of Pydantic in
 * `_DOCS/python-exemplar/src/exemplar/models/`.
 *
 * WHY THERE IS NO LOGIC IN THIS FILE
 *
 * Same rule as the Python side: models declare shape. A model that knows how to
 * fetch itself couples the schema to the transport and makes both untestable
 * without the other.
 *
 * @see _DOCS/STANDARDS-typescript.md ## Typing
 */

import { z } from "zod";

/**
 * What a check concluded.
 *
 * A string-literal union via `z.enum`, NOT a TypeScript `enum`: a TS `enum`
 * emits a runtime object, does not narrow structurally, and `const enum` breaks
 * under `isolatedModules` (which this repo sets). The union gives the same
 * exhaustiveness checking at zero runtime cost.
 *
 * @see _DOCS/STANDARDS-typescript.md ## Control flow
 */
export const CheckStatus = z.enum(["up", "down", "degraded", "unknown"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

/**
 * One target to watch.
 *
 * Every constraint here is one the code would otherwise have to check by hand
 * at each use, and would eventually forget at one of them.
 */
export const CheckTarget = z.object({
  /** Stable identity. Used as a log field and a database key. */
  name: z
    .string()
    .min(1)
    .max(128)
    // Anchored so it matches the WHOLE string. An unanchored /[a-z]/ would
    // accept "Bad Name!" because it finds one lowercase letter somewhere --
    // a regex that looks like validation and is not.
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase alphanumeric, dot, dash, underscore"),

  /** Absolute URL. `z.string().url()` rejects a relative path outright. */
  url: z.string().url(),

  /** Milliseconds before the attempt is abandoned. */
  timeoutMs: z.number().int().positive().max(60_000).default(5_000),

  /**
   * Statuses treated as healthy.
   *
   * A set rather than a single value: a health endpoint legitimately answers
   * 200 or 204, and encoding "or" as a list beats a special case in the
   * evaluator.
   */
  expectStatus: z.array(z.number().int().min(100).max(599)).nonempty().default([200]),

  /** Consecutive failures before the target is called down. */
  failureThreshold: z.number().int().positive().max(100).default(3),
});
export type CheckTarget = z.infer<typeof CheckTarget>;

/**
 * The outcome of one attempt against one target.
 *
 * `statusCode` and `durationMs` are nullable because a request that never
 * completed has neither. Encoding that as 0 or -1 would make every consumer
 * remember the sentinel; null makes the type system enforce the check.
 */
export const CheckResult = z.object({
  targetName: z.string().min(1),
  status: CheckStatus,
  statusCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** Present only on failure. */
  error: z.string().nullable(),
  /** ISO-8601 with offset. Always. */
  recordedAt: z.string().datetime({ offset: true }),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** Current state of one target, as held by the monitor's store. */
export const TargetState = z.object({
  targetName: z.string().min(1),
  status: CheckStatus,
  /** Reset to 0 by any success. */
  consecutiveFailures: z.number().int().nonnegative(),
  lastCheckedAt: z.string().datetime({ offset: true }).nullable(),
  lastOkAt: z.string().datetime({ offset: true }).nullable(),
});
export type TargetState = z.infer<typeof TargetState>;
