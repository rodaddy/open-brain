import type { ContextPackPayload } from "./transport.ts";
import type { CompletePackSectionName, SectionVerdict } from "./complete-pack-types.ts";

// Section classification for the complete-pack gate, extracted from
// complete-pack-gate.ts (issue 752 lint sweep). Behavior-identical: the same
// dispositions, the same `defined_empty` decisions, the same failure strings.

/** A recognized non-empty item container: has an integer item_count > 0. */
export function itemCountOf(section: Record<string, unknown>): number {
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
 * (server/tools/context-pack-*.ts): durable_lane_context -> exact_scope,
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
const ALLOWED_STATUSES = new Set<string>(["ok", "degraded", "partial", "error"]);

/**
 * Reduce a server-controlled `status` to a finite label: the value verbatim only
 * when it is in the allowlist, else a fixed generic. Keeps a raw server string
 * (which could carry an injected sentinel or body) out of the receipt/failures.
 */
export function sanitizeStatus(status: unknown): string {
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
export function definedScopeDenialReasons(
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
export function definedDegradeReason(
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
const RAM_ONLY_SECTIONS = new Set<CompletePackSectionName>(["working_set", "recovery"]);

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

/** Build a defined-empty verdict with the given disposition label. */
function definedEmptyVerdict(
  name: CompletePackSectionName,
  present: boolean,
  disposition: string,
  serializedChars: number,
): SectionVerdict {
  return {
    section: name,
    present,
    has_items: false,
    defined_empty: true,
    item_count: 0,
    disposition,
    serialized_chars: serializedChars,
  };
}

/** The allowlisted denial/degrade labels attributed to one section, if any. */
interface DefinedDispositions {
  deniedReasons: string | null;
  degradeReason: string | null;
}

/**
 * Classify a section whose body was OMITTED. Legitimate ONLY when a defined
 * (allowlisted) denial/degrade explains it, OR the whole-pack budget starved it
 * out (recorded as a truncation marker with starved:true on this source), OR the
 * section is an opt-in one that was never requested. An omitted body IS an empty
 * section, so a denial/degrade here trivially agrees with emptiness.
 */
function classifyAbsentSection(
  name: CompletePackSectionName,
  payload: ContextPackPayload,
  defined: DefinedDispositions,
): SectionVerdict {
  if (defined.deniedReasons !== null) {
    return definedEmptyVerdict(name, false, defined.deniedReasons, 0);
  }
  if (defined.degradeReason !== null) {
    return definedEmptyVerdict(name, false, defined.degradeReason, 0);
  }
  const starved = payload.warnings.truncation.some(
    (t) => t.source === name && t.starved === true,
  );
  if (starved) {
    return definedEmptyVerdict(name, false, "whole_pack_budget", 0);
  }
  if (OPT_IN_ABSENT_OK.has(name)) {
    // Opt-in section legitimately absent: the pack only assembles it when its
    // explicit opt-in was requested (recovery -> include_unreviewed_recovery).
    // Its absence is the defined state, not a dropped section.
    return definedEmptyVerdict(name, false, "opt_in_absent", 0);
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

/**
 * Classify a section that is PRESENT with items. A scope-denial or degrade that
 * claims this section is empty/unavailable while the section is POPULATED is a
 * forged or stale denial and fails -- never accepted as defined-empty on the
 * strength of a warning the body contradicts.
 */
function classifyPopulatedSection(
  name: CompletePackSectionName,
  itemCount: number,
  serializedChars: number,
  defined: DefinedDispositions,
): SectionVerdict {
  const contradicted = defined.deniedReasons !== null || defined.degradeReason !== null;
  return {
    section: name,
    present: true,
    has_items: true,
    defined_empty: false,
    item_count: itemCount,
    disposition: "items",
    serialized_chars: serializedChars,
    ...(contradicted
      ? {
          failure: `${name}: reports a scope-denial/degrade but the section is populated (${itemCount} item(s))`,
        }
      : {}),
  };
}

/**
 * Classify a section that is PRESENT with zero items: it must be a recognized
 * defined-empty. `empty_reason` is already gated to the finite
 * RECOGNIZED_EMPTY_REASONS allowlist, so a raw server-controlled reason string
 * can never become the disposition here.
 */
function classifyEmptySection(
  name: CompletePackSectionName,
  section: Record<string, unknown>,
  serializedChars: number,
  defined: DefinedDispositions,
): SectionVerdict {
  const emptyReason =
    typeof section.empty_reason === "string" ? section.empty_reason : null;
  if (emptyReason && RECOGNIZED_EMPTY_REASONS.has(emptyReason)) {
    return definedEmptyVerdict(name, true, emptyReason, serializedChars);
  }
  // A present-but-empty section reported through its own scope-denial is
  // defined-empty. The disposition is the ACTUAL allowlisted denial reason(s),
  // not a hardcoded label: durable_lane_context reports `exact_scope`, but
  // repo_facts is present-empty with `no_active_repo` (a
  // `{repo: null, repo_bound: false}` body plus a `no_active_repo` denial --
  // server/tools/context-pack-repo-facts.ts), and hardcoding `exact_scope`
  // would mislabel it. definedScopeDenialReasons returns only allowlisted,
  // section-attributed reasons (or null), so an arbitrary server reason cannot
  // mark this section defined-empty.
  if (defined.deniedReasons !== null) {
    return definedEmptyVerdict(name, true, defined.deniedReasons, serializedChars);
  }
  // A present-but-empty section reported through an allowlisted degrade reason is
  // likewise defined-empty (e.g. durable_memory present-empty with a
  // database_unavailable degrade).
  if (defined.degradeReason !== null) {
    return definedEmptyVerdict(name, true, defined.degradeReason, serializedChars);
  }
  // Guidance loaders and the pointer builder emit a truthful empty body with NO
  // empty_reason when genuinely empty; their defined-empty state is declared by
  // construction through the namespace-binding flag on an empty items array.
  // Require the binding flag so a body that merely dropped its marker (a real
  // defect) is not silently accepted.
  if (DEFINED_EMPTY_WITHOUT_MARKER.has(name) && isNamespaceBoundEmpty(section)) {
    return definedEmptyVerdict(name, true, "namespace_bound_empty", serializedChars);
  }
  // RAM-only sections are legitimately empty on a fresh remote scope: an empty
  // items array with no reason is their defined state, not a defect.
  if (RAM_ONLY_SECTIONS.has(name)) {
    return definedEmptyVerdict(name, true, "ram_only_empty", serializedChars);
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

/**
 * Classify one requested section's disposition against the emitted pack. A
 * section passes when it is PRESENT-with-items, or in a recognized DEFINED-EMPTY
 * state (empty items + a recognized marker, or a legitimately-empty RAM-only
 * section), or reported through a defined scope-denial / degraded-source in the
 * warnings channel (durable_lane_context exact_scope, repo_facts no_active_repo,
 * a database_unavailable degrade). Everything else fails the present-or-empty
 * check. Records the serialized-character contribution either way.
 */
export function classifySection(
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

  // A defined scope-denial / degraded-source for this section carries a finite
  // ALLOWLISTED reason attributed to this exact section, or it is not a defined
  // disposition at all. An arbitrary server-supplied reason, or one attributed
  // to the wrong section, returns null and cannot mark the section defined-empty.
  const defined: DefinedDispositions = {
    deniedReasons: definedScopeDenialReasons(
      name,
      payload.warnings.scope_denials.find((d) => d.source === name),
    ),
    degradeReason: definedDegradeReason(
      name,
      payload.warnings.degraded_sources.find((d) => d.source === name),
    ),
  };

  if (!section) return classifyAbsentSection(name, payload, defined);

  const itemCount = itemCountOf(section);
  if (itemCount > 0) {
    return classifyPopulatedSection(name, itemCount, serializedChars, defined);
  }
  return classifyEmptySection(name, section, serializedChars, defined);
}
