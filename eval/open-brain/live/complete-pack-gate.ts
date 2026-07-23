import type { LiveEvalConfig } from "./config.ts";
import {
  LiveTransportError,
  type ContextPackPayload,
  type ContextPackScope,
  type OpenBrainLiveClient,
} from "./transport.ts";
import { withTeardownFailedCount } from "./gate.ts";
import {
  COMPLETE_PACK_SECTION_NAMES,
  type BudgetVerdict,
  type CitationVerdict,
  type CompletePackFixture,
  type CompletePackReceipt,
  type CompletePackSeededRecord,
  type CompletePackSectionName,
  type IsolationVerdict,
  type NegativeControlVerdict,
  type SectionVerdict,
} from "./complete-pack-types.ts";

// Live COMPLETE CONTEXT PACK gate orchestrator (EVAL-3, issue #330).
//
// One run: seed a unique throwaway namespace (and a sibling negative namespace)
// with the sealed synthetic corpus, call the real `agent_context_pack` tool
// under the primary namespace requesting ALL NINE sections and one whole-pack
// budget, verify the assembled pack against six functional properties, and
// ALWAYS tear down exactly the records this run created -- even when the pack
// call or a verification fails partway through.
//
// The six properties, all functional (no assertions about SQL shape or
// internal call counts):
//   1. Presence-or-defined-emptiness: every requested section either carries
//      items or is in its DEFINED-EMPTY state (a recognized empty/denial marker,
//      or a legitimately-empty RAM-only section, or a defined scope-denial).
//   2. Exact-scope isolation: durable_lane_context reports its exact-scope
//      defined-empty for the fresh throwaway scope, no negative-namespace record
//      surfaces in any section item, lane, event, source_ref, or citation, and
//      the expected primary recall IS present (a hollow empty recall would
//      otherwise hide a broken predicate).
//   3. Citation truth: the top-level citations array is a bijection of the
//      emitted item citation_ids (durable_memory/pointer items, the lane, AND
//      each durable_lane_context event) -- no dangling citation, no uncited item.
//   4. Serialized budget: JSON.stringify(sections) stays within the reported
//      whole-pack content_char_limit, and an allocation order covering all nine
//      sections is present.
//   5. Per-section contribution: the serialized-character contribution and item
//      count of every section is recorded in the receipt.
//   6. Explicit cross-namespace denial: the PRIMARY caller attempts a
//      primary-identity read against the NEGATIVE namespace and the server MUST
//      deny it. A leak-scan over the emitted pack only catches a forbidden id
//      that happened to surface; a forbidden record ranked below the result cut
//      would still pass. The denial probe proves the boundary REFUSES the read
//      outright -- an allowed-but-empty read (which looks identical to a working
//      boundary) is NOT proof and fails the gate. Reuses the recall gate's
//      attemptRead probe transport.
//
// Teardown reuses the recall gate's discipline: per-record, namespace-scoped
// archive_entry only, never a bulk or query-shaped delete, so it can only touch
// records this run created. The receipt is content-free: labels, ids, counts,
// booleans -- never a memory body.

export interface CompletePackGateClients {
  /** Reads/writes/archives the primary throwaway namespace and builds the pack. */
  primary: OpenBrainLiveClient;
  /** Seeds/archives the negative sibling namespace (mandatory isolation control). */
  negative: OpenBrainLiveClient;
}

export interface RunCompletePackGateOptions {
  fixture: CompletePackFixture;
  config: LiveEvalConfig;
  clients: CompletePackGateClients;
  /** Whole-pack budget in tokens for the single pack build. */
  budgetMaxTokens: number;
  /** Exact non-namespace scope coordinates for the pack call. */
  scope: {
    agent: string;
    platform: string;
    server_id: string;
    channel_id: string;
    thread_id?: string | null;
    session_key: string;
  };
  commit: string;
  generatedAt: string;
}

export interface CompletePackGateOutcome {
  receipt: CompletePackReceipt;
  passed: boolean;
}

interface TeardownTally {
  attempted: number;
  archived: number;
  already_absent: number;
  failed: number;
}

/**
 * Seed one entry with the owning client for its namespace role. Both clients
 * always exist (the negative control is mandatory), so seeding never silently
 * skips a corpus entry. Mirrors the recall gate's seedEntry.
 */
async function seedEntry(
  entry: CompletePackFixture["corpus"][number],
  config: LiveEvalConfig,
  clients: CompletePackGateClients,
): Promise<CompletePackSeededRecord> {
  const isNegative = entry.namespace_role === "negative";
  const client = isNegative ? clients.negative : clients.primary;
  const namespace = isNegative
    ? config.negativeNamespace
    : config.primaryNamespace;

  const result = await client.logMemory({
    table: entry.table,
    content: entry.content,
    tags: entry.tags,
    namespace,
  });
  return {
    fixture_id: entry.id,
    table: entry.table,
    server_id: result.id,
    namespace,
    namespace_role: entry.namespace_role,
  };
}

/**
 * Archive every seeded record through its owning client, tolerating individual
 * failures so one bad archive never strands the rest. Identical discipline to
 * the recall gate's teardown.
 */
async function teardown(
  seeded: CompletePackSeededRecord[],
  clients: CompletePackGateClients,
): Promise<TeardownTally> {
  const tally: TeardownTally = {
    attempted: 0,
    archived: 0,
    already_absent: 0,
    failed: 0,
  };
  for (const record of seeded) {
    const client =
      record.namespace_role === "negative" ? clients.negative : clients.primary;
    tally.attempted += 1;
    try {
      const outcome = await client.archive({
        table: record.table,
        id: record.server_id,
      });
      if (outcome === "archived") tally.archived += 1;
      else tally.already_absent += 1;
    } catch {
      // Content-free: the count is the only signal the receipt needs.
      tally.failed += 1;
    }
  }
  return tally;
}

/** A recognized non-empty item container: has an integer item_count > 0. */
function itemCountOf(section: Record<string, unknown>): number {
  const count = section.item_count;
  return typeof count === "number" && Number.isFinite(count) && count >= 0
    ? count
    : Array.isArray(section.items)
      ? section.items.length
      : 0;
}

/**
 * The set of content-free empty/denial markers each section is allowed to carry
 * when it holds zero items. A section with zero items is DEFINED-EMPTY only when
 * it carries one of these (or, for the RAM-only sections, is simply empty on a
 * fresh scope). This is what turns "empty" into "defined-empty" -- an empty
 * section with no recognized marker is a defect, not a pass.
 */
const RECOGNIZED_EMPTY_REASONS = new Set<string>([
  // durable_memory
  "no_query",
  "no_readable_tables",
  "recall_failed",
  "no_matches",
  "all_suppressed",
  "content_unavailable",
  // candidate_memory
  "candidate_predicate_unavailable",
  // whole-pack starvation stamped by the fitter on any trimmed-to-empty section
  "whole_pack_budget",
]);

/**
 * The finite allowlist of scope-denial reasons the gate recognizes, keyed by the
 * section that is permitted to report each one. A `scope_denials[]` entry is a
 * DEFINED denial only when its `source` is a real section AND every reason it
 * carries is in that section's allowlist -- an arbitrary server-supplied reason
 * string (or a reason attributed to the wrong section) is NOT a recognized
 * denial and must not turn an otherwise-undefined section into defined-empty.
 * These are the exact reasons the production builders emit
 * (src/tools/agent-context-pack-*.ts): durable_lane_context -> exact_scope,
 * repo_facts -> no_active_repo (optionally namespace_bound), and the guidance
 * loaders -> no_promoted_guidance.
 */
const ALLOWED_SCOPE_DENIAL_REASONS: Partial<
  Record<CompletePackSectionName, ReadonlySet<string>>
> = {
  durable_lane_context: new Set(["exact_scope"]),
  repo_facts: new Set(["no_active_repo", "namespace_bound"]),
  profile_guidance: new Set(["no_promoted_guidance"]),
  process_guidance: new Set(["no_promoted_guidance"]),
};

/**
 * The finite allowlist of degraded-source reasons, keyed by the section allowed
 * to report each one. A `degraded_sources[]` entry is a DEFINED degrade only
 * when its `source` is a real section AND its `reason` is in that section's
 * allowlist. durable_memory degrades to a recognized recall failure; a
 * database_unavailable degrade may be stamped on any recall/pointer section by
 * the fitter when the store is unreachable.
 */
const ALLOWED_DEGRADE_REASONS: Partial<
  Record<CompletePackSectionName, ReadonlySet<string>>
> = {
  durable_memory: new Set([
    "recall_failed",
    "no_readable_tables",
    "database_unavailable",
  ]),
  pointers: new Set(["database_unavailable"]),
  candidate_memory: new Set([
    "candidate_predicate_unavailable",
    "database_unavailable",
  ]),
};

/** Fixed generic label substituted for any unrecognized server-controlled reason. */
const GENERIC_REASON = "unrecognized_reason";

/** Fixed generic label substituted for any unrecognized server-controlled status. */
const GENERIC_STATUS = "unrecognized";

/** The finite allowlist of pack `status` values the gate will name verbatim. */
const ALLOWED_STATUSES = new Set<string>([
  "ok",
  "degraded",
  "partial",
  "error",
]);

/**
 * Reduce a server-controlled `status` to a finite label: the value verbatim only
 * when it is in the allowlist, else a fixed generic. Keeps a raw server string
 * (which could carry an injected sentinel or body) out of the receipt/failures.
 */
function sanitizeStatus(status: unknown): string {
  return typeof status === "string" && ALLOWED_STATUSES.has(status)
    ? status
    : GENERIC_STATUS;
}

/**
 * A scope-denial for `section` is DEFINED only when its reasons array is present,
 * non-empty, and every reason is in that section's allowlist. Returns the joined
 * allowlisted reasons (a finite, content-free label) when defined, else null.
 * An arbitrary or wrong-section reason yields null so it cannot mark a section
 * defined-empty. A partially-recognized denial (one bad reason among good ones)
 * is rejected whole -- a mixed denial is not a trustworthy definition.
 */
function definedScopeDenialReasons(
  section: CompletePackSectionName,
  denial: Record<string, unknown> | undefined,
): string | null {
  if (!denial) return null;
  const allowed = ALLOWED_SCOPE_DENIAL_REASONS[section];
  if (!allowed) return null;
  const reasons = denial.reasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const labels: string[] = [];
  for (const raw of reasons) {
    if (typeof raw !== "string" || !allowed.has(raw)) return null;
    labels.push(raw);
  }
  return labels.join(",");
}

/**
 * A degraded-source for `section` is DEFINED only when its reason is a string in
 * that section's allowlist. Returns the allowlisted reason (finite label) when
 * defined, else null so an arbitrary server reason cannot mark a section
 * defined-empty.
 */
function definedDegradeReason(
  section: CompletePackSectionName,
  degrade: Record<string, unknown> | undefined,
): string | null {
  if (!degrade) return null;
  const allowed = ALLOWED_DEGRADE_REASONS[section];
  if (!allowed) return null;
  const reason = degrade.reason;
  return typeof reason === "string" && allowed.has(reason) ? reason : null;
}

/** RAM-only sections that are legitimately empty on a fresh remote scope. */
const RAM_ONLY_SECTIONS = new Set<CompletePackSectionName>([
  "working_set",
  "recovery",
]);

/**
 * Opt-in sections the pack only emits when their explicit opt-in was requested.
 * `recovery` is only assembled when `include_unreviewed_recovery: true` is sent
 * (requesting the section name alone is not enough), so on a pack built without
 * that flag `recovery` is legitimately ABSENT — not a missing-section defect.
 * The gate treats an absent opt-in section as defined-empty; a present-empty one
 * still flows through the normal present-empty checks (RAM_ONLY).
 */
const OPT_IN_ABSENT_OK = new Set<CompletePackSectionName>(["recovery"]);

/**
 * Sections whose production builders emit a TRUTHFUL empty body carrying NO
 * `empty_reason` when they are genuinely empty: the guidance loaders
 * (no promoted user_preference / process_rule) and the pointer builder (no
 * surplus durable pool after dedupe). Their defined-empty state is declared by
 * construction via a namespace-binding flag (`namespace_scoped` /
 * `namespace_bound: true`) and an empty items array, not an empty_reason string.
 * durable_memory is deliberately EXCLUDED: it is a recall section that always
 * stamps a recognized `empty_reason` (no_matches/no_query/...) when empty, so a
 * marker-less empty durable_memory stays a defect.
 */
const DEFINED_EMPTY_WITHOUT_MARKER = new Set<CompletePackSectionName>([
  "profile_guidance",
  "process_guidance",
  "pointers",
]);

/** True only for the exact truthful namespace-bound empty envelope. */
function isNamespaceBoundEmpty(section: Record<string, unknown>): boolean {
  return section.namespace_scoped === true || section.namespace_bound === true;
}

/**
 * Classify one requested section's disposition against the emitted pack. A
 * section passes when it is PRESENT-with-items, or in a recognized DEFINED-EMPTY
 * state (empty items + a recognized marker, or a legitimately-empty RAM-only
 * section), or reported through a defined scope-denial / degraded-source in the
 * warnings channel (durable_lane_context exact_scope, repo_facts no_active_repo,
 * a database_unavailable degrade). Everything else fails the present-or-empty
 * check. Records the serialized-character contribution either way.
 */
function classifySection(
  name: CompletePackSectionName,
  payload: ContextPackPayload,
): SectionVerdict {
  const body = payload.sections[name];
  const present = body !== undefined;
  const section =
    present && body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  const serializedChars = present ? JSON.stringify(body).length : 0;

  // A defined scope-denial or degraded-source for this section is itself a
  // defined-empty disposition even when the section body is omitted.
  const scopeDenial = payload.warnings.scope_denials.find(
    (d) => d.source === name,
  );
  const degraded = payload.warnings.degraded_sources.find(
    (d) => d.source === name,
  );

  // A defined scope-denial / degraded-source for this section carries a finite
  // ALLOWLISTED reason attributed to this exact section, or it is not a defined
  // disposition at all. An arbitrary server-supplied reason, or one attributed
  // to the wrong section, returns null and cannot mark the section defined-empty.
  const deniedReasons = definedScopeDenialReasons(name, scopeDenial);
  const degradeReason = definedDegradeReason(name, degraded);

  if (!section) {
    // Body omitted. Legitimate ONLY when a defined (allowlisted) denial/degrade
    // explains it, OR the whole-pack budget starved it out (recorded as a
    // truncation marker with starved:true on this source). An omitted body IS an
    // empty section, so a denial/degrade here trivially agrees with emptiness.
    const starved = payload.warnings.truncation.some(
      (t) => t.source === name && t.starved === true,
    );
    if (deniedReasons !== null) {
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: deniedReasons,
        serialized_chars: 0,
      };
    }
    if (degradeReason !== null) {
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: degradeReason,
        serialized_chars: 0,
      };
    }
    if (starved) {
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: "whole_pack_budget",
        serialized_chars: 0,
      };
    }
    if (OPT_IN_ABSENT_OK.has(name)) {
      // Opt-in section legitimately absent: the pack only assembles it when its
      // explicit opt-in was requested (recovery -> include_unreviewed_recovery).
      // Its absence is the defined state, not a dropped section.
      return {
        section: name,
        present: false,
        has_items: false,
        defined_empty: true,
        item_count: 0,
        disposition: "opt_in_absent",
        serialized_chars: 0,
      };
    }
    return {
      section: name,
      present: false,
      has_items: false,
      defined_empty: false,
      item_count: 0,
      disposition: "missing",
      serialized_chars: 0,
      failure: `${name}: not present and no defined scope-denial/degrade/starve`,
    };
  }

  const itemCount = itemCountOf(section);
  if (itemCount > 0) {
    // A scope-denial or degrade claims this section is empty/unavailable, yet the
    // section is POPULATED: the denial contradicts the body. A defined empty
    // disposition must agree with an actually empty or omitted section, so a
    // populated section that ALSO carries a denial/degrade for itself is a forged
    // or stale denial and fails -- never accepted as defined-empty on the
    // strength of a warning the body contradicts.
    if (deniedReasons !== null || degradeReason !== null) {
      return {
        section: name,
        present: true,
        has_items: true,
        defined_empty: false,
        item_count: itemCount,
        disposition: "items",
        serialized_chars: serializedChars,
        failure: `${name}: reports a scope-denial/degrade but the section is populated (${itemCount} item(s))`,
      };
    }
    return {
      section: name,
      present: true,
      has_items: true,
      defined_empty: false,
      item_count: itemCount,
      disposition: "items",
      serialized_chars: serializedChars,
    };
  }

  // Present with zero items: must be a recognized defined-empty. `empty_reason`
  // is already gated to the finite RECOGNIZED_EMPTY_REASONS allowlist, so a raw
  // server-controlled reason string can never become the disposition here.
  const emptyReason =
    typeof section.empty_reason === "string" ? section.empty_reason : null;
  if (emptyReason && RECOGNIZED_EMPTY_REASONS.has(emptyReason)) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: emptyReason,
      serialized_chars: serializedChars,
    };
  }
  // A present-but-empty section reported through its own scope-denial is
  // defined-empty. The disposition is the ACTUAL allowlisted denial reason(s),
  // not a hardcoded label: durable_lane_context reports `exact_scope`, but
  // repo_facts is present-empty with `no_active_repo` (a
  // `{repo: null, repo_bound: false}` body plus a `no_active_repo` denial --
  // src/tools/agent-context-pack-repo-facts.ts), and hardcoding `exact_scope`
  // would mislabel it. definedScopeDenialReasons returns only allowlisted,
  // section-attributed reasons (or null), so an arbitrary server reason cannot
  // mark this section defined-empty.
  if (deniedReasons !== null) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: deniedReasons,
      serialized_chars: serializedChars,
    };
  }
  // A present-but-empty section reported through an allowlisted degrade reason is
  // likewise defined-empty (e.g. durable_memory present-empty with a
  // database_unavailable degrade).
  if (degradeReason !== null) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: degradeReason,
      serialized_chars: serializedChars,
    };
  }
  // Guidance loaders and the pointer builder emit a truthful empty body with NO
  // empty_reason when genuinely empty; their defined-empty state is declared by
  // construction through the namespace-binding flag on an empty items array.
  // Require the binding flag so a body that merely dropped its marker (a real
  // defect) is not silently accepted.
  if (
    DEFINED_EMPTY_WITHOUT_MARKER.has(name) &&
    isNamespaceBoundEmpty(section)
  ) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: "namespace_bound_empty",
      serialized_chars: serializedChars,
    };
  }
  // RAM-only sections are legitimately empty on a fresh remote scope: an empty
  // items array with no reason is their defined state, not a defect.
  if (RAM_ONLY_SECTIONS.has(name)) {
    return {
      section: name,
      present: true,
      has_items: false,
      defined_empty: true,
      item_count: 0,
      disposition: "ram_only_empty",
      serialized_chars: serializedChars,
    };
  }
  // Present, empty, no recognized marker: a defect (an empty section that does
  // not truthfully state WHY it is empty). The disposition is a fixed label --
  // never the raw `empty_reason` string, which is server-controlled and could
  // carry an injected sentinel or body -- so an unrecognized reason is reported
  // as the generic marker rather than echoed verbatim.
  return {
    section: name,
    present: true,
    has_items: false,
    defined_empty: false,
    item_count: 0,
    disposition: emptyReason ? GENERIC_REASON : "unmarked_empty",
    serialized_chars: serializedChars,
    failure: `${name}: present but empty with no recognized empty marker`,
  };
}

/** Tally one record's `citation_id` occurrence into the multiset when present. */
function addCitationId(counts: Map<string, number>, record: unknown): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const cid = (record as Record<string, unknown>).citation_id;
  if (typeof cid === "string" && cid.length > 0) {
    counts.set(cid, (counts.get(cid) ?? 0) + 1);
  }
}

/**
 * Tally every emitted citable unit's `citation_id` across all sections as a
 * MULTISET (id -> occurrence count), not a set. A unit is any record the pack
 * emits with its own citation: durable_memory / pointer items (in `items[]`),
 * and -- for durable_lane_context -- the lane object AND each event in
 * `events[]`. A populated lane emits a `session_lane:<id>` citation for the lane
 * and a `session_event:<id>` citation for each event
 * (src/tools/agent-context-pack-durable-lane.ts).
 *
 * Counting OCCURRENCES rather than distinct ids is what makes the bijection
 * real: two DISTINCT emitted units that share one citation_id, or one unit
 * emitted twice, are a truth defect (the shared id cannot cite both) that a set
 * would silently collapse to a single member and pass. Content-free: only the id
 * strings and their counts, never a body.
 */
function tallyEmittedItemCitationIds(
  payload: ContextPackPayload,
): Map<string, number> {
  const counts = new Map<string, number>();
  const addFrom = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) addCitationId(counts, item);
  };
  for (const name of COMPLETE_PACK_SECTION_NAMES) {
    const body = payload.sections[name];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const section = body as Record<string, unknown>;
    addFrom(section.items);
    // durable_lane_context carries its lane citation_id on the lane object, not
    // in an items array; the lane is an emitted, citable unit too.
    addCitationId(counts, section.lane);
    // durable_lane_context also emits its events in an events[] array, each with
    // its own session_event citation_id -- a populated lane cites every event.
    addFrom(section.events);
  }
  return counts;
}

/** Sum a multiset's occurrence counts (total emitted citable units). */
function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/**
 * Verify the top-level citations array is a strict bijection of the emitted
 * citable units, comparing OCCURRENCE COUNTS rather than set membership so
 * duplicate occurrences on either side are caught:
 *
 *  - EXACTLY ONE emitted unit and ONE top-level citation per identity. Two
 *    distinct units sharing one citation_id are ambiguous even if the top-level
 *    array repeats that id twice; matching duplicate counts must still fail.
 *  - A top-level citation occurrence with no emitted occurrence is dangling; an
 *    emitted occurrence with no citation is uncited. Any occurrence beyond the
 *    first on either side is also a defect for that side.
 *
 * dangling + uncited are occurrence counts, so the bijection holds only when
 * every id appears exactly once on both sides.
 */
function verifyCitations(payload: ContextPackPayload): CitationVerdict {
  const emitted = tallyEmittedItemCitationIds(payload);
  const citationCounts = new Map<string, number>();
  for (const citation of payload.citations) {
    const id = citation.id;
    if (typeof id === "string" && id.length > 0) {
      citationCounts.set(id, (citationCounts.get(id) ?? 0) + 1);
    }
  }
  const ids = new Set<string>([...emitted.keys(), ...citationCounts.keys()]);
  let dangling = 0;
  let uncited = 0;
  for (const id of ids) {
    const emittedN = emitted.get(id) ?? 0;
    const citedN = citationCounts.get(id) ?? 0;
    // A bijection requires ONE emitted unit and ONE top-level citation for each
    // id. Matching duplicate counts are still ambiguous (two units cannot share
    // one citation identity), so count every occurrence beyond the first as a
    // defect on its own side. If the opposite side is absent, every occurrence is
    // unmatched rather than treating one as the allowed representative.
    dangling += emittedN === 0 ? citedN : Math.max(citedN - 1, 0);
    uncited += citedN === 0 ? emittedN : Math.max(emittedN - 1, 0);
  }
  return {
    citations_total: payload.citations.length,
    emitted_item_citations: sumCounts(emitted),
    dangling_citations: dangling,
    uncited_items: uncited,
    bijective: dangling === 0 && uncited === 0,
  };
}

/** Verify the serialized whole-pack budget was respected. */
function verifyBudget(payload: ContextPackPayload): BudgetVerdict {
  const serialized = JSON.stringify(payload.sections).length;
  const wholePack =
    payload.budget.whole_pack &&
    typeof payload.budget.whole_pack === "object" &&
    !Array.isArray(payload.budget.whole_pack)
      ? (payload.budget.whole_pack as Record<string, unknown>)
      : null;
  const limit =
    wholePack && typeof wholePack.content_char_limit === "number"
      ? wholePack.content_char_limit
      : null;
  const order = wholePack?.allocation_order;
  const orderComplete =
    Array.isArray(order) &&
    COMPLETE_PACK_SECTION_NAMES.every((s) => order.includes(s));
  return {
    content_char_limit: limit,
    serialized_sections_chars: serialized,
    within_budget: limit === null ? false : serialized <= limit,
    allocation_order_complete: orderComplete,
  };
}

/**
 * Collect one record's structural identity strings (never a body): its own `id`,
 * and its `source_ref` -- which the pack emits either as an OBJECT carrying an
 * `id` (durable_memory / pointer items) OR as a plain STRING pointer such as
 * `ob_session_events/<id>` (durable_lane_context lane + events). Both forms are
 * captured: object source_refs contribute their `id`, string source_refs the
 * whole pointer string (so an embedded forbidden id is caught by containment).
 */
function collectIdentityStrings(record: unknown, into: Set<string>): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  const rec = record as Record<string, unknown>;
  if (typeof rec.id === "string" && rec.id.length > 0) into.add(rec.id);
  const ref = rec.source_ref;
  if (typeof ref === "string" && ref.length > 0) {
    into.add(ref);
  } else if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const refId = (ref as Record<string, unknown>).id;
    if (typeof refId === "string" && refId.length > 0) into.add(refId);
  }
}

/**
 * Verify isolation: durable_lane_context reports its exact-scope defined-empty,
 * no forbidden (negative-namespace) server id surfaces anywhere in the pack, and
 * the expected primary recall ids surfaced in durable_memory items or pointers.
 *
 * Forbidden ids are checked by their SERVER ids (the ids this run seeded into the
 * negative namespace), matched against every emitted identity string across the
 * pack -- item ids and item source_ref ids, AND the durable_lane_context lane id
 * plus every event id and event source_ref pointer. A forbidden id is a leak
 * whether it appears as an exact identity id or is embedded in a string
 * source_ref pointer (e.g. `ob_session_events/<forbidden-id>`), so leaks are
 * detected structurally without inspecting any body.
 */
function verifyIsolation(
  payload: ContextPackPayload,
  seeded: CompletePackSeededRecord[],
  fixture: CompletePackFixture,
): IsolationVerdict {
  const forbiddenServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "negative" &&
          fixture.forbidden_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );
  const expectedServerIds = new Set(
    seeded
      .filter(
        (r) =>
          r.namespace_role === "primary" &&
          fixture.expected_recall_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );

  // Walk every emitted identity string across all sections: item ids +
  // source_refs, and durable_lane_context's lane id + each event id/source_ref.
  const emittedIds = new Set<string>();
  const collectIds = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) collectIdentityStrings(item, emittedIds);
  };
  for (const name of COMPLETE_PACK_SECTION_NAMES) {
    const body = payload.sections[name];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const section = body as Record<string, unknown>;
    collectIds(section.items);
    // durable_lane_context: the lane object and each event are emitted, citable
    // units with their own identity -- walk them for leaks too.
    collectIdentityStrings(section.lane, emittedIds);
    collectIds(section.events);
  }

  // A forbidden id is a leak whether it is an exact emitted id OR is embedded in
  // a string source_ref pointer (ob_session_events/<forbidden-id>).
  let leaks = 0;
  for (const forbidden of forbiddenServerIds) {
    for (const id of emittedIds) {
      if (id === forbidden || id.includes(forbidden)) {
        leaks += 1;
        break;
      }
    }
  }
  // Require EVERY expected server id to surface, not merely one of them. Any one
  // seed appearing anywhere would pass a "some" check while the other expected
  // seeds silently never recalled -- a partial-recall defect that hides a broken
  // predicate for the missing ids. The recall is proven only when the whole
  // expected set is present. An empty expected set (a fixture that expects
  // nothing) cannot prove recall reached the seeded namespace, so it fails too.
  let expectedPresent = expectedServerIds.size > 0;
  for (const expected of expectedServerIds) {
    if (!emittedIds.has(expected)) {
      expectedPresent = false;
      break;
    }
  }

  // durable_lane_context exact-scope defined-empty: reported through its
  // scope-denial (exact_scope) on a fresh throwaway scope.
  const exactScopeDenied = payload.warnings.scope_denials.some(
    (d) =>
      d.source === "durable_lane_context" &&
      Array.isArray(d.reasons) &&
      d.reasons.map(String).includes("exact_scope"),
  );

  return {
    exact_scope_denied: exactScopeDenied,
    namespace_leaks: leaks,
    expected_recall_present: expectedPresent,
  };
}

/** Fixed top-k for the cross-namespace denial probe read. */
const NEGATIVE_CONTROL_PROBE_TOP_K = 10;

/**
 * Explicit cross-namespace denial proof, mirroring the recall gate's
 * probeNegativeControl. The PRIMARY caller attempts a primary-identity read of
 * the NEGATIVE namespace (which the negative control seeded), and the server
 * must DENY it. An allowed-but-empty read is NOT proof: the namespace being
 * empty for the primary caller looks identical to a working isolation boundary,
 * so we require an actual permission denial. This closes the gap the emitted-pack
 * leak walk leaves open -- a forbidden record ranked below the result cut never
 * surfaces in the pack, so the walk passes, but the denial probe still fails
 * closed because the read is refused outright.
 *
 * The probe reuses the pack's recall `query` (the query the forbidden negative
 * records are most likely to match if isolation were broken). Runs after seeding
 * (records exist) and before teardown. Content-free: only booleans, a count, and
 * a redacted failure label -- never a hit body.
 */
async function probeNegativeControl(
  fixture: CompletePackFixture,
  config: LiveEvalConfig,
  clients: CompletePackGateClients,
): Promise<NegativeControlVerdict> {
  const proof: NegativeControlVerdict = {
    ran: true,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
  };

  let result;
  try {
    result = await clients.primary.attemptRead({
      query: fixture.query,
      namespace: config.negativeNamespace,
      limit: NEGATIVE_CONTROL_PROBE_TOP_K,
      searchMode: config.searchMode,
    });
  } catch (error) {
    // A non-denial transport error means we could not establish the proof.
    const label =
      error instanceof LiveTransportError ? error.label : "attempt-read-error";
    proof.denied = false;
    proof.failure = `negative-control read failed: ${label}`;
    return proof;
  }

  proof.observed_hit_count = result.hitCount;
  // Isolation is proven ONLY by an actual denial. A successful read -- empty or
  // not -- fails: allowed-empty proves nothing and allowed-nonempty is a breach.
  proof.denied = result.denied;
  if (!proof.denied) {
    proof.failure =
      result.hitCount > 0
        ? "primary caller was permitted to read the negative namespace (non-empty)"
        : "primary caller's read of the negative namespace was allowed (empty), not denied";
  }
  return proof;
}

/**
 * Run the full complete-pack gate. Seeding, the pack call, and the
 * cross-namespace denial probe are wrapped so teardown always runs; a thrown
 * error is re-raised only AFTER teardown, with the content-free teardown failed
 * count preserved (shared with the recall gate via withTeardownFailedCount).
 * PASS requires all six properties AND clean teardown.
 */
export async function runCompletePackGate(
  opts: RunCompletePackGateOptions,
): Promise<CompletePackGateOutcome> {
  const { fixture, config, clients, budgetMaxTokens, scope, commit } = opts;

  const seeded: CompletePackSeededRecord[] = [];
  let deferredError: unknown = null;
  let payload: ContextPackPayload | null = null;
  // Default proof: did-not-run. Only replaced by a real probe result when
  // seeding + the pack call complete without a deferred error.
  let negativeControl: NegativeControlVerdict = {
    ran: false,
    denied: false,
    observed_hit_count: 0,
    cross_token: config.negativeTokenIsDistinct,
    failure: "negative-control proof did not run",
  };

  const packScope: ContextPackScope = {
    namespace: config.primaryNamespace,
    agent: scope.agent,
    platform: scope.platform,
    server_id: scope.server_id,
    channel_id: scope.channel_id,
    thread_id: scope.thread_id ?? null,
    session_key: scope.session_key,
  };

  try {
    for (const entry of fixture.corpus) {
      seeded.push(await seedEntry(entry, config, clients));
    }

    payload = await clients.primary.contextPack({
      scope: packScope,
      query: fixture.query,
      requestedSections: COMPLETE_PACK_SECTION_NAMES,
      budgetMaxTokens,
    });

    // --- Explicit cross-namespace denial proof (after seeding, before teardown) ---
    negativeControl = await probeNegativeControl(fixture, config, clients);
  } catch (error) {
    deferredError = error;
  }

  const teardownTally = await teardown(seeded, clients);

  if (deferredError) {
    throw withTeardownFailedCount(deferredError, teardownTally.failed);
  }
  // Unreachable when deferredError is null: payload is set. Guard for the type.
  if (!payload) {
    throw new LiveTransportError("agent_context_pack:no-payload", false);
  }

  // --- Verify the five functional properties ---
  const sections = COMPLETE_PACK_SECTION_NAMES.map((name) =>
    classifySection(name, payload as ContextPackPayload),
  );
  const citations = verifyCitations(payload);
  const budget = verifyBudget(payload);
  const isolation = verifyIsolation(payload, seeded, fixture);

  const primarySeeded = seeded.filter(
    (r) => r.namespace_role === "primary",
  ).length;
  const negativeSeeded = seeded.filter(
    (r) => r.namespace_role === "negative",
  ).length;

  const failures: string[] = [];
  // 1. Presence-or-defined-emptiness for all nine. A section fails when it is
  // neither present-with-items nor defined-empty, OR when it recorded any other
  // classification defect (e.g. a POPULATED section that also claims a
  // scope-denial for itself -- a forged/contradictory denial carries a `failure`
  // even though it has items). Surface a recorded `failure` regardless of
  // has_items so the populated-denial contradiction is not swallowed.
  for (const verdict of sections) {
    if (verdict.failure) {
      failures.push(verdict.failure);
    } else if (!verdict.has_items && !verdict.defined_empty) {
      failures.push(`${verdict.section}: not defined-empty`);
    }
  }
  if (payload.status !== "ok") {
    // The raw status is server-controlled and could carry an injected sentinel
    // or body, so it is sanitized to a finite allowlisted label (or a fixed
    // generic) before it enters the content-free failures list.
    failures.push(
      `pack status is '${sanitizeStatus(payload.status)}', expected 'ok'`,
    );
  }
  // 3. Citation truth.
  if (!citations.bijective) {
    failures.push(
      `citations not bijective: dangling=${citations.dangling_citations} uncited=${citations.uncited_items}`,
    );
  }
  // 4. Serialized budget.
  if (!budget.within_budget) {
    failures.push(
      `serialized sections ${budget.serialized_sections_chars} exceed whole-pack limit ${budget.content_char_limit ?? "none"}`,
    );
  }
  if (!budget.allocation_order_complete) {
    failures.push(
      "whole-pack allocation order missing or does not cover all nine sections",
    );
  }
  // 2. Exact-scope isolation.
  if (!isolation.exact_scope_denied) {
    failures.push(
      "durable_lane_context did not report its exact-scope defined-empty",
    );
  }
  if (isolation.namespace_leaks > 0) {
    failures.push(
      `namespace isolation breach: ${isolation.namespace_leaks} forbidden record(s) surfaced in the pack`,
    );
  }
  if (!isolation.expected_recall_present) {
    failures.push(
      "expected primary recall did not surface in durable_memory/pointers (hollow recall would hide a broken predicate)",
    );
  }
  // 6. Explicit cross-namespace denial. A leak-free emitted pack is NOT enough:
  // the boundary must actually REFUSE the primary caller's read of the negative
  // namespace. An allowed read -- empty or not -- fails.
  if (!negativeControl.ran) {
    failures.push(
      `negative-control proof did not run: ${negativeControl.failure ?? "unknown"}`,
    );
  } else if (!negativeControl.denied) {
    failures.push(
      `negative-control not denied: ${negativeControl.failure ?? "isolation not proven"}`,
    );
  }
  // Teardown discipline.
  const teardownClean = teardownTally.failed === 0;
  if (!teardownClean) {
    failures.push(
      `teardown failed to archive ${teardownTally.failed} of ${teardownTally.attempted} seeded records`,
    );
  }

  const passed = failures.length === 0;

  const receipt: CompletePackReceipt = {
    schema: "openbrain.complete_pack_gate.v1",
    generated_at: opts.generatedAt,
    commit,
    fixture_id: fixture.fixture_id,
    primary_namespace: config.primaryNamespace,
    negative_namespace: config.negativeNamespace,
    requested_sections: [...COMPLETE_PACK_SECTION_NAMES],
    seeded: { primary: primarySeeded, negative: negativeSeeded },
    sections,
    budget,
    citations,
    isolation,
    negative_control: negativeControl,
    passed,
    failures,
    teardown: teardownTally,
  };

  return { receipt, passed };
}
