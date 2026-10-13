import type { ReflexAbFixture } from "./reflex-ab-types.ts";

// Referential-integrity checks for the reflex A/B fixture.
//
// Split out of reflex-ab-fixtures.ts (issue 752) so `parseReflexAbFixture` stays
// under the repo complexity rule value. Each helper is a verbatim lift of one
// check group out of the original function body: same thrown message text, same
// order, same fail-closed behavior. `parseReflexAbFixture` is now composition
// over these.
//
// These are internal helpers of the fixture module. reflex-ab-fixtures.ts does
// NOT re-export them, so no import specifier anywhere in the repo moves.

type ReflexAbCorpusEntry = ReflexAbFixture["corpus"][number];

/**
 * Index the corpus by id, refusing a duplicate. A duplicate id would let one
 * entry silently shadow another, so the reference checks below could validate
 * against an entry the gate never seeds.
 */
export function indexReflexAbCorpusById(
  corpus: ReflexAbFixture["corpus"],
): Map<string, ReflexAbCorpusEntry> {
  const byId = new Map<string, ReflexAbCorpusEntry>();
  for (const entry of corpus) {
    if (byId.has(entry.id)) {
      throw new Error(`duplicate corpus id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

/**
 * Every prior_known id must exist, be a primary-role entry, AND be flagged
 * `prior_known: true` -- the flag and the list must agree, so the suppression
 * references the gate sends match the ground-truth known set exactly. It must
 * also be disjoint from net_new: a seed cannot be both already-known and new.
 */
export function assertPriorKnownIdsResolve(
  fixture: ReflexAbFixture,
  byId: Map<string, ReflexAbCorpusEntry>,
  netNewSet: Set<string>,
): void {
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
}

/**
 * Every net_new id must exist, be a primary-role entry, and NOT be prior_known
 * by either the corpus flag or the declared list.
 */
export function assertNetNewIdsResolve(
  fixture: ReflexAbFixture,
  byId: Map<string, ReflexAbCorpusEntry>,
  priorKnownSet: Set<string>,
): void {
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
}

/** Every forbidden id must exist and be a negative-role entry. */
export function assertReflexAbForbiddenIdsResolve(
  fixture: ReflexAbFixture,
  byId: Map<string, ReflexAbCorpusEntry>,
): void {
  for (const id of fixture.forbidden_ids) {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`forbidden_ids references unknown id ${id}`);
    }
    if (entry.namespace_role !== "negative") {
      throw new Error(`forbidden id ${id} must be a negative-role entry`);
    }
  }
}

/**
 * Every corpus entry flagged prior_known must be declared in prior_known_ids, so
 * the gate always sends a prior_context reference for it. A silently-flagged
 * seed the gate never suppresses would let the ON arm resurface it and the gate
 * would not even know it was supposed to be suppressed.
 */
export function assertFlaggedPriorKnownAreDeclared(
  fixture: ReflexAbFixture,
  priorKnownSet: Set<string>,
): void {
  for (const entry of fixture.corpus) {
    if (entry.prior_known === true && !priorKnownSet.has(entry.id)) {
      throw new Error(
        `corpus entry ${entry.id} is prior_known but missing from prior_known_ids`,
      );
    }
  }
}
