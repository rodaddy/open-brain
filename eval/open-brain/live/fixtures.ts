import { z } from "zod";
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

  const byId = new Map<string, (typeof fixture.corpus)[number]>();
  for (const entry of fixture.corpus) {
    if (byId.has(entry.id)) {
      throw new Error(`duplicate corpus id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  const probeIds = new Set<string>();
  for (const probe of fixture.probes) {
    if (probeIds.has(probe.id)) {
      throw new Error(`duplicate probe id: ${probe.id}`);
    }
    probeIds.add(probe.id);

    for (const rel of probe.relevant) {
      const entry = byId.get(rel.id);
      if (!entry) {
        throw new Error(
          `probe ${probe.id} references unknown relevant id ${rel.id}`,
        );
      }
      if (entry.namespace_role !== "primary") {
        throw new Error(
          `probe ${probe.id} relevant id ${rel.id} must be a primary-role entry`,
        );
      }
    }
    for (const forbidden of probe.forbidden_ids) {
      const entry = byId.get(forbidden);
      if (!entry) {
        throw new Error(
          `probe ${probe.id} references unknown forbidden id ${forbidden}`,
        );
      }
      if (entry.namespace_role !== "negative") {
        throw new Error(
          `probe ${probe.id} forbidden id ${forbidden} must be a negative-role entry`,
        );
      }
    }
  }

  return fixture;
}

/** Load and validate a live fixture from disk. */
export async function loadLiveFixture(path: string): Promise<LiveFixture> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
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
