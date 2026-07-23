import { z } from "zod";
import type { CompletePackFixture } from "./complete-pack-types.ts";

// Zod validation for the complete-pack fixture. Loading is fail-closed: a
// malformed fixture aborts the gate before any live write happens, exactly like
// the recall gate's parseLiveFixture.

const corpusEntrySchema = z.object({
  id: z.string().min(1),
  table: z.enum(["thoughts", "decisions"]),
  namespace_role: z.enum(["primary", "negative"]),
  content: z.string().min(1),
  tags: z.array(z.string()),
});

export const completePackFixtureSchema: z.ZodType<CompletePackFixture> =
  z.object({
    schema_version: z.literal(1),
    fixture_id: z.string().min(1),
    description: z.string(),
    query: z.string().min(1),
    corpus: z.array(corpusEntrySchema).min(1),
    expected_recall_ids: z.array(z.string().min(1)).min(1),
    forbidden_ids: z.array(z.string().min(1)).min(1),
  });

/**
 * Parse and structurally validate a complete-pack fixture, then check
 * referential integrity: every expected/forbidden id must exist in the corpus,
 * corpus ids are unique, expected ids point at primary-role entries, and
 * forbidden ids point at negative-role entries. Throws on any gap so the gate
 * can never seed a fixture whose expectations do not match its corpus.
 */
export function parseCompletePackFixture(raw: unknown): CompletePackFixture {
  const fixture = completePackFixtureSchema.parse(raw);

  const byId = new Map<string, (typeof fixture.corpus)[number]>();
  for (const entry of fixture.corpus) {
    if (byId.has(entry.id)) {
      throw new Error(`duplicate corpus id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  for (const id of fixture.expected_recall_ids) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`expected_recall_ids references unknown id ${id}`);
    }
    if (entry.namespace_role !== "primary") {
      throw new Error(`expected_recall id ${id} must be a primary-role entry`);
    }
  }
  for (const id of fixture.forbidden_ids) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`forbidden_ids references unknown id ${id}`);
    }
    if (entry.namespace_role !== "negative") {
      throw new Error(`forbidden id ${id} must be a negative-role entry`);
    }
  }

  return fixture;
}

/** Load and validate a complete-pack fixture from disk. */
export async function loadCompletePackFixture(
  path: string,
): Promise<CompletePackFixture> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read complete-pack fixture ${path}: ${message}`);
  }
  try {
    return parseCompletePackFixture(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid complete-pack fixture ${path}: ${message}`);
  }
}
