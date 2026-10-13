import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  assertForbiddenIdsResolve,
  assertRelevantIdsResolve,
  indexCorpusById,
} from "./fixtures-parse.ts";
import type { LiveFixture } from "./types.ts";

// Zod validation for the live recall fixture. Loading is fail-closed: a
// malformed fixture aborts the gate before any live write happens.

const gradedRelevanceSchema = z.object({
  id: z.string().min(1),
  grade: z.number().int().min(0),
});

const corpusEntrySchema = z.object({
  id: z.string().min(1),
  table: z.enum(["thoughts", "decisions"]),
  namespace_role: z.enum(["primary", "negative"]),
  content: z.string().min(1),
  tags: z.array(z.string()),
});

const probeSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  relevant: z.array(gradedRelevanceSchema),
  forbidden_ids: z.array(z.string()),
});

export const liveFixtureSchema: z.ZodType<LiveFixture> = z.object({
  schema_version: z.literal(1),
  fixture_id: z.string().min(1),
  description: z.string(),
  corpus: z.array(corpusEntrySchema).min(1),
  probes: z.array(probeSchema).min(1),
});

/**
 * Parse and structurally validate a live fixture, then check referential
 * integrity: every id referenced by a probe (relevant or forbidden) must exist
 * in the corpus, corpus ids are unique, and forbidden ids point at negative-role
 * entries while relevant ids point at primary-role entries. Throws on any gap.
 */
export function parseLiveFixture(raw: unknown): LiveFixture {
  const fixture = liveFixtureSchema.parse(raw);

  // The individual checks live in ./fixtures-parse.ts (issue 752); the order
  // here is unchanged, so the first gap in a malformed fixture is still the one
  // reported.
  const byId = indexCorpusById(fixture.corpus);

  const probeIds = new Set<string>();
  for (const probe of fixture.probes) {
    if (probeIds.has(probe.id)) {
      throw new Error(`duplicate probe id: ${probe.id}`);
    }
    probeIds.add(probe.id);

    assertRelevantIdsResolve(probe, byId);
    assertForbiddenIdsResolve(probe, byId);
  }

  return fixture;
}

/** Load and validate a live fixture from disk. */
export async function loadLiveFixture(path: string): Promise<LiveFixture> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read live recall fixture ${path}: ${message}`);
  }
  try {
    return parseLiveFixture(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid live recall fixture ${path}: ${message}`);
  }
}
