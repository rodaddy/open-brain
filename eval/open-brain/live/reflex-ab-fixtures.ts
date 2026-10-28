import {
  assertFlaggedPriorKnownAreDeclared,
  assertNetNewIdsResolve,
  assertPriorKnownIdsResolve,
  assertReflexAbForbiddenIdsResolve,
  indexReflexAbCorpusById,
} from "./reflex-ab-fixtures-parse.ts";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ReflexAbFixture } from "./reflex-ab-types.ts";

// Zod validation for the reflex A/B fixture. Loading is fail-closed: a malformed
// fixture aborts the gate before any live write happens, exactly like the
// recall/complete-pack gates' fixture loaders.

const corpusEntrySchema = z.object({
  id: z.string().min(1),
  table: z.enum(["thoughts", "decisions"]),
  namespace_role: z.enum(["primary", "negative"]),
  prior_known: z.boolean().optional(),
  content: z.string().min(1),
  tags: z.array(z.string()),
});

export const reflexAbFixtureSchema: z.ZodType<ReflexAbFixture> = z.object({
  schema_version: z.literal(1),
  fixture_id: z.string().min(1),
  description: z.string(),
  query: z.string().min(1),
  corpus: z.array(corpusEntrySchema).min(1),
  prior_known_ids: z.array(z.string().min(1)).min(1),
  net_new_ids: z.array(z.string().min(1)).min(1),
  forbidden_ids: z.array(z.string().min(1)).min(1),
});

/**
 * Parse and structurally validate a reflex A/B fixture, then check referential
 * integrity so the gate can never seed a fixture whose expectations do not match
 * its corpus:
 *  - corpus ids are unique;
 *  - every prior_known id exists, is a primary-role entry, AND is flagged
 *    `prior_known: true` (the flag and the list must agree, so the suppression
 *    references the gate sends match the ground-truth known set exactly);
 *  - every net_new id exists, is a primary-role entry, and is NOT prior_known
 *    (a seed cannot be both already-known and net-new);
 *  - prior_known and net_new are disjoint;
 *  - every forbidden id exists and is a negative-role entry;
 *  - every `prior_known: true` corpus entry is listed in prior_known_ids (no
 *    silently-known seed the gate would fail to send as prior context).
 */
export function parseReflexAbFixture(raw: unknown): ReflexAbFixture {
  const fixture = reflexAbFixtureSchema.parse(raw);

  // The individual checks live in ./reflex-ab-fixtures-parse.ts (issue 752);
  // the order here is unchanged, so the first gap in a malformed fixture is
  // still the one reported.
  const byId = indexReflexAbCorpusById(fixture.corpus);

  const priorKnownSet = new Set(fixture.prior_known_ids);
  const netNewSet = new Set(fixture.net_new_ids);

  assertPriorKnownIdsResolve(fixture, byId, netNewSet);
  assertNetNewIdsResolve(fixture, byId, priorKnownSet);
  assertReflexAbForbiddenIdsResolve(fixture, byId);
  assertFlaggedPriorKnownAreDeclared(fixture, priorKnownSet);

  return fixture;
}

/** Load and validate a reflex A/B fixture from disk. */
export async function loadReflexAbFixture(path: string): Promise<ReflexAbFixture> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read reflex A/B fixture ${path}: ${message}`);
  }
  try {
    return parseReflexAbFixture(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid reflex A/B fixture ${path}: ${message}`);
  }
}
