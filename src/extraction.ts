import { z } from "zod";
import { createHash } from "node:crypto";
import type pg from "pg";
import { logger } from "./logger.ts";

export interface ExtractedMetadata {
  topics: string[];
  people: string[];
  action_items: string[];
  dates: string[];
  // Deterministic, zero-network structural metadata computed here (never by an
  // injected provider): a bounded human-facing title derived from the text, and
  // a content-free digest envelope of the exact text. These make representative
  // approved inputs produce stable metadata WITHOUT any model or network, so the
  // ingestion path no longer depends on an empty stub. All optional so a
  // provider-only result (no deterministic pass) still type-checks.
  title?: string;
  content_hash?: string;
  hash_version?: typeof CONTENT_HASH_VERSION;
  byte_length?: number;
}

// Version tag for the deterministic content-hash algorithm. Bumped only if the
// canonicalization or digest changes, so a stored hash's provenance is
// unambiguous. Kept local to the extraction path; the source-registry envelope
// carries its own independently-versioned tag.
export const CONTENT_HASH_VERSION = "sha256.v1" as const;

// Minimum text length worth extracting from. Below this, extraction is skipped
// (returns null) rather than run against a fragment.
const MIN_EXTRACT_LENGTH = 10;
// Hard caps so a provider (or a deterministic pass over adversarial input)
// cannot inflate an unbounded tags array. Applied AFTER normalize + dedupe.
const MAX_ITEMS_PER_FIELD = 32;
const MAX_ITEM_LENGTH = 120;
// Bound on the derived title. A title is a label, not the body: an adversarial
// or huge first line can never inflate the durable write.
const MAX_TITLE_LENGTH = 200;
// Matches an ISO-8601 date (optionally with a time). Deterministic, zero-network
// timestamp extraction; only well-formed calendar-shaped tokens are surfaced.
const ISO_DATE_RE =
  /\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

// Strict schema for provider output. Anything a provider returns is treated as
// untrusted: unknown keys are stripped, non-strings dropped, and each field is
// normalized/deduped/capped before it can influence a durable write.
// Field values are validated as arrays at the shape level; element-level
// cleanup (non-strings, blanks, casing, caps) is deterministic and lives in
// normalizeField, so one malformed element never discards the whole result.
const extractionOutputSchema = z
  .object({
    topics: z.array(z.unknown()).optional(),
    people: z.array(z.unknown()).optional(),
    action_items: z.array(z.unknown()).optional(),
    dates: z.array(z.unknown()).optional(),
  })
  .passthrough();

// A metadata provider turns source text into structured metadata. It is the
// single bounded seam for any future model- or heuristic-backed extractor. A
// provider may return null (no metadata) and MUST NOT throw for control flow;
// extraction fails open regardless. Providers must never log source text.
export interface MetadataProvider {
  extract(text: string): Promise<unknown> | unknown;
}

// Default provider for the model-ish fields (topics/people/action_items/dates).
// These genuinely need a model or heuristic, so the DEFAULT contributes none of
// them -- it returns an empty object, not null, so the deterministic structural
// pass (title/content_hash/dates below) still runs and produces stable metadata.
// A real semantic extractor is injected via setMetadataProvider; its output is
// always re-validated and capped here and can never assert the structural
// fields. Deterministic, zero-network, no source-text logging.
const defaultProvider: MetadataProvider = {
  extract(): Record<string, never> {
    return {};
  },
};

let activeProvider: MetadataProvider = defaultProvider;

// Inject a bounded provider (e.g. in a collector or a test). The provider's
// output is always re-validated and normalized here, so an injected provider
// can never bypass the strict schema, the caps, or the fail-open guarantee, and
// can never set the deterministic structural fields (those are computed here).
export function setMetadataProvider(provider: MetadataProvider): void {
  activeProvider = provider;
}

export function resetMetadataProvider(): void {
  activeProvider = defaultProvider;
}

// Deterministic, content-free digest envelope of the exact text. Zero-network,
// stable across processes/machines. Never logs or returns the content itself.
function hashText(text: string): {
  content_hash: string;
  hash_version: typeof CONTENT_HASH_VERSION;
  byte_length: number;
} {
  const bytes = new TextEncoder().encode(text);
  return {
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    hash_version: CONTENT_HASH_VERSION,
    byte_length: bytes.byteLength,
  };
}

// Deterministic title: the first non-empty line, trimmed and bounded. A label,
// never the body. Returns undefined when no usable line exists.
function deriveTitle(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    return trimmed.length > MAX_TITLE_LENGTH
      ? trimmed.slice(0, MAX_TITLE_LENGTH)
      : trimmed;
  }
  return undefined;
}

// Deterministic ISO-date extraction: order-preserving, deduped, capped. These
// are the timestamps referenced in the text, computed with no model or network.
function deriveDates(text: string): string[] {
  const matches = text.match(ISO_DATE_RE);
  if (!matches) return [];
  return normalizeField(matches);
}

// Normalize a single field: trim, drop empties, cap length, case-insensitive
// dedupe (first spelling wins), cap count. Deterministic and order-preserving.
function normalizeField(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const bounded =
      trimmed.length > MAX_ITEM_LENGTH
        ? trimmed.slice(0, MAX_ITEM_LENGTH)
        : trimmed;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bounded);
    if (out.length >= MAX_ITEMS_PER_FIELD) break;
  }
  return out;
}

// Merge the (untrusted) provider output with the deterministic structural pass
// over `text`. Provider fields are strictly validated/capped; the structural
// fields (title, content_hash, byte_length, and deterministic ISO dates) are
// computed here from the actual text and can never be supplied by a provider.
// Provider-supplied dates and deterministic dates are unioned, then deduped/
// capped by normalizeField so the union stays bounded and order-stable.
function normalizeExtraction(
  raw: unknown,
  text: string,
): ExtractedMetadata | null {
  const parsed = extractionOutputSchema.safeParse(raw);
  if (!parsed.success) return null;

  const digest = hashText(text);
  const title = deriveTitle(text);
  const providerDates = normalizeField(parsed.data.dates);
  const dates = normalizeField([...providerDates, ...deriveDates(text)]);

  const result: ExtractedMetadata = {
    topics: normalizeField(parsed.data.topics),
    people: normalizeField(parsed.data.people),
    action_items: normalizeField(parsed.data.action_items),
    dates,
    content_hash: digest.content_hash,
    hash_version: digest.hash_version,
    byte_length: digest.byte_length,
  };
  if (title !== undefined) result.title = title;
  // The deterministic pass always yields a content_hash for real text, so a
  // valid input never collapses to null: ingestion no longer relies on an
  // empty stub. Null is reserved for a schema-invalid provider result (handled
  // above) or below-threshold/empty text (handled in extractMetadata).
  return result;
}

// Extract structured metadata from source text via the active provider. Always
// fails open: a null/invalid provider result, or any provider throw, yields
// null and never blocks the caller's durable write. Never logs source text --
// only the length and an error class/name.
export async function extractMetadata(
  text: string,
): Promise<ExtractedMetadata | null> {
  if (!text || text.length < MIN_EXTRACT_LENGTH) return null;
  let raw: unknown;
  try {
    raw = await activeProvider.extract(text);
  } catch (err) {
    // Fail open on a provider throw, but DO NOT lose the deterministic metadata:
    // the structural pass is model-free and cannot fail here, so representative
    // approved inputs still produce a stable content_hash/title even when the
    // injected semantic provider is unavailable.
    logger.warn("extraction_provider_error", {
      text_length: text.length,
      error: extractionErrorLabel(err),
    });
    raw = {};
  }
  // A null/undefined provider result is treated as "no semantic fields", not as
  // "no metadata": the deterministic structural pass still runs. Only a
  // schema-invalid (wrong-shape) provider result yields null, inside
  // normalizeExtraction.
  return normalizeExtraction(raw ?? {}, text);
}

// Content-free error label: class/name only, never the raw message, so provider
// or driver error strings can never smuggle source text into logs.
function extractionErrorLabel(err: unknown): string {
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown_error";
}

/**
 * Merge extracted topics and people into existing tags array.
 * People are prefixed with "person:" for filtering.
 * Deduplicates against existing tags (case-insensitive).
 */
export function mergeTags(
  existingTags: string[],
  extracted: ExtractedMetadata | null,
): string[] {
  if (!extracted) return existingTags;

  const seen = new Set(existingTags.map((t) => t.toLowerCase()));
  const merged = [...existingTags];

  for (const topic of extracted.topics) {
    const key = topic.toLowerCase();
    if (!seen.has(key)) {
      merged.push(topic);
      seen.add(key);
    }
  }

  for (const person of extracted.people) {
    const tagged = `person:${person}`;
    const key = tagged.toLowerCase();
    if (!seen.has(key)) {
      merged.push(tagged);
      seen.add(key);
    }
  }

  return merged;
}

// Tables eligible for background metadata enrichment. Explicit allowlist so the
// interpolated UPDATE target below can never be an arbitrary caller-supplied
// string; callers pass one of these literals.
const EXTRACTION_TABLES = new Set([
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
]);

/**
 * Fire-and-forget background extraction: fetch metadata, merge tags, update DB.
 * Shared by log-thought and log-decision to avoid duplicated extraction blocks.
 * Fails open: extraction never blocks or reverses the durable write that
 * already happened. The table is validated against an allowlist before it is
 * interpolated into SQL.
 *
 * The enrichment UPDATE is bound to the exact effective namespace of the row it
 * just wrote and restricted to live (non-archived) rows. Without the namespace
 * predicate a UUID collision or a caller-supplied id could enrich a row in
 * another namespace, crossing the isolation boundary; the archived_at guard
 * keeps background enrichment from touching rows a caller archived in the
 * interim. `namespace` here is the physical namespace already resolved and
 * authorized by the caller at write time.
 */
export function backgroundExtract(
  pool: pg.Pool,
  table: string,
  entryId: string,
  namespace: string,
  text: string,
  existingTags: string[],
): void {
  if (!EXTRACTION_TABLES.has(table)) {
    logger.warn("extraction_table_rejected", { table, id: entryId });
    return;
  }
  extractMetadata(text)
    .then((extracted) => {
      if (!extracted) return;
      const enrichedTags = mergeTags(existingTags, extracted);
      pool
        .query(
          `UPDATE ${table} SET tags = $1, extracted_metadata = $2
           WHERE id = $3 AND namespace = $4 AND archived_at IS NULL`,
          [enrichedTags, JSON.stringify(extracted), entryId, namespace],
        )
        .catch((err: unknown) => {
          logger.warn("extraction_update_error", {
            table,
            id: entryId,
            error: extractionErrorLabel(err),
          });
        });
    })
    .catch((err) =>
      logger.warn("extraction_background_error", {
        table,
        id: entryId,
        error: extractionErrorLabel(err),
      }),
    );
}
