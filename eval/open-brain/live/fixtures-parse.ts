import type { LiveFixture } from "./types.ts";

// Referential-integrity checks for the live recall fixture.
//
// Split out of fixtures.ts (issue 752) so `parseLiveFixture` stays under the
// repo complexity rule value. Each helper is a verbatim lift of one check out of
// the original function body: same thrown message text, same order, same
// fail-closed behavior. `parseLiveFixture` is now composition over these.
//
// These are internal helpers of the fixture module. fixtures.ts does NOT
// re-export them, so no import specifier anywhere in the repo moves.

type LiveCorpusEntry = LiveFixture["corpus"][number];
type LiveProbe = LiveFixture["probes"][number];

/**
 * Index the corpus by id, refusing a duplicate. A duplicate id would let one
 * entry silently shadow another, so the reference checks below could validate
 * against an entry the gate never seeds.
 */
export function indexCorpusById(
  corpus: LiveFixture["corpus"],
): Map<string, LiveCorpusEntry> {
  const byId = new Map<string, LiveCorpusEntry>();
  for (const entry of corpus) {
    if (byId.has(entry.id)) {
      throw new Error(`duplicate corpus id: ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

/**
 * Every id a probe declares relevant must exist in the corpus AND be a
 * primary-role entry -- a relevant id pointing at the negative namespace would
 * make the probe unsatisfiable by construction.
 */
export function assertRelevantIdsResolve(
  probe: LiveProbe,
  byId: Map<string, LiveCorpusEntry>,
): void {
  for (const rel of probe.relevant) {
    const entry = byId.get(rel.id);
    if (!entry) {
      throw new Error(`probe ${probe.id} references unknown relevant id ${rel.id}`);
    }
    if (entry.namespace_role !== "primary") {
      throw new Error(
        `probe ${probe.id} relevant id ${rel.id} must be a primary-role entry`,
      );
    }
  }
}

/**
 * Every id a probe declares forbidden must exist in the corpus AND be a
 * negative-role entry -- a forbidden id in the primary namespace would fail the
 * probe for a legitimate retrieval instead of proving isolation.
 */
export function assertForbiddenIdsResolve(
  probe: LiveProbe,
  byId: Map<string, LiveCorpusEntry>,
): void {
  for (const forbidden of probe.forbidden_ids) {
    const entry = byId.get(forbidden);
    if (!entry) {
      throw new Error(`probe ${probe.id} references unknown forbidden id ${forbidden}`);
    }
    if (entry.namespace_role !== "negative") {
      throw new Error(
        `probe ${probe.id} forbidden id ${forbidden} must be a negative-role entry`,
      );
    }
  }
}
