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

  const byId = new Map<string, (typeof fixture.corpus)[number]>();
  for (const entry of fixture.corpus) {
    if (byId.has(entry.id)) {
      throw new Error(`duplicate corpus id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  const priorKnownSet = new Set(fixture.prior_known_ids);
  const netNewSet = new Set(fixture.net_new_ids);

  for (const id of fixture.prior_known_ids) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`prior_known_ids references unknown id ${id}`);
    }
    if (entry.namespace_role !== "primary") {
      throw new Error(`prior_known id ${id} must be a primary-role entry`);
    }
    if (entry.prior_known !== true) {
      throw new Error(
        `prior_known id ${id} must carry prior_known: true on its corpus entry`,
      );
    }
    if (netNewSet.has(id)) {
      throw new Error(`id ${id} cannot be both prior_known and net_new`);
    }
  }

  for (const id of fixture.net_new_ids) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`net_new_ids references unknown id ${id}`);
    }
    if (entry.namespace_role !== "primary") {
      throw new Error(`net_new id ${id} must be a primary-role entry`);
    }
    if (entry.prior_known === true || priorKnownSet.has(id)) {
      throw new Error(`net_new id ${id} must not be prior_known`);
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

  // Every corpus entry flagged prior_known must be declared in prior_known_ids,
  // so the gate always sends a prior_context reference for it. A silently-flagged
  // seed the gate never suppresses would let the ON arm resurface it and the gate
  // would not even know it was supposed to be suppressed.
  for (const entry of fixture.corpus) {
    if (entry.prior_known === true && !priorKnownSet.has(entry.id)) {
      throw new Error(
        `corpus entry ${entry.id} is prior_known but missing from prior_known_ids`,
      );
    }
  }

  return fixture;
}

/** Load and validate a reflex A/B fixture from disk. */
export async function loadReflexAbFixture(
  path: string,
): Promise<ReflexAbFixture> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
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
