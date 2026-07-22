/**
 * Public adapter receipts with the bounded, content-free error-category
 * taxonomy owned by the TypeScript client (fixture
 * `ts-public-receipt-error-category-v1`).
 *
 * Free text is never allowed in `error_category`: unknown failures map to
 * `"other"`. The sanitized error TEXT stays on the internal
 * `openbrain.runtime_receipt.v1` shape only.
 */

import type { Json } from "./client.ts";
import { OpenBrainHTTPError, OpenBrainError } from "./client.ts";
import { ValidationError } from "./policy.ts";
import { SpoolFullError } from "./spool.ts";
import { ScopeProofError, type RuntimeReceipt } from "./runtime.ts";

export const PUBLIC_RECEIPT_SCHEMA = "openbrain.public_receipt.v1";

export const PUBLIC_ERROR_CATEGORIES = [
  "scope-proof-failed",
  "http-auth",
  "http-error",
  "network",
  "spool-full",
  "invalid-request",
  "other",
] as const;
export type PublicErrorCategory = (typeof PUBLIC_ERROR_CATEGORIES)[number];

/** Receipt statuses that carry an error_category on the public shape. */
export const PUBLIC_ERROR_STATUSES = ["spooled", "failed", "lost"] as const;

const CATEGORY_SET: ReadonlySet<string> = new Set(PUBLIC_ERROR_CATEGORIES);

/** Map any failure to the bounded public taxonomy; unknown maps to "other". */
export function errorCategory(error: unknown): PublicErrorCategory {
  if (error instanceof ScopeProofError) {
    return "scope-proof-failed";
  }
  if (error instanceof SpoolFullError) {
    return "spool-full";
  }
  if (error instanceof ValidationError) {
    return "invalid-request";
  }
  if (error instanceof OpenBrainHTTPError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "http-auth";
    }
    return error.statusCode === undefined ? "network" : "http-error";
  }
  if (error instanceof OpenBrainError) {
    return "http-error";
  }
  return "other";
}

/** Coerce an untrusted category string into the bounded taxonomy. */
export function coerceErrorCategory(value: unknown): PublicErrorCategory {
  return typeof value === "string" && CATEGORY_SET.has(value)
    ? (value as PublicErrorCategory)
    : "other";
}

export interface PublicReceipt extends Json {
  schema: typeof PUBLIC_RECEIPT_SCHEMA;
  operation: string;
  status: string;
  durable: boolean;
}

/**
 * Build the content-free public receipt for adapter surfaces. Non-saved
 * statuses (`spooled` / `failed` / `lost`) carry a bounded `error_category`;
 * no free-text error ever leaves the internal runtime receipt.
 */
export function publicReceipt(
  receipt: RuntimeReceipt,
  error?: unknown,
): PublicReceipt {
  const value: PublicReceipt = {
    schema: PUBLIC_RECEIPT_SCHEMA,
    operation: receipt.operation,
    status: receipt.status,
    durable: receipt.durable,
  };
  if (receipt.spoolKey !== null) {
    value["spool_key"] = receipt.spoolKey;
  }
  if ((PUBLIC_ERROR_STATUSES as readonly string[]).includes(receipt.status)) {
    value["error_category"] =
      error !== undefined ? errorCategory(error) : coerceErrorCategory(null);
  }
  return value;
}
