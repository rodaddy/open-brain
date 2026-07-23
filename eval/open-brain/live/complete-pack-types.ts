// Types for the live Open Brain COMPLETE CONTEXT PACK gate (EVAL-3, issue #330).
//
// This gate is the live counterpart of the offline pack tests: it seeds a unique
// throwaway namespace with a sealed synthetic corpus, calls the real
// `agent_context_pack` tool requesting ALL NINE sections under ONE whole-pack
// budget, and verifies functional outcomes:
//
//   - every requested section is PRESENT or in its DEFINED-EMPTY state,
//   - exact-scope isolation (seven coordinates + negative namespace) holds,
//   - citation truth (citations are a bijection of emitted item citation_ids),
//   - the serialized `sections` object stays within the whole-pack budget,
//   - per-section contribution (serialized chars + item counts) is recorded.
//
// Nothing here carries a secret, token, or memory body off-box: the corpus is
// synthetic and the receipt is content-free (labels, ids, counts, booleans).

/** Brain tables the complete-pack gate seeds and archives. */
export type CompletePackTable = "thoughts" | "decisions";

/**
 * The nine context-pack sections, in the tool's canonical priority order. The
 * gate requests exactly these and verifies each one lands present-or-empty.
 * Kept as a literal here (not imported from src) so the eval declares the exact
 * contract it asserts against and a production reshuffle is caught, not masked.
 */
export const COMPLETE_PACK_SECTION_NAMES = [
  "working_set",
  "recovery",
  "durable_lane_context",
  "durable_memory",
  "profile_guidance",
  "process_guidance",
  "repo_facts",
  "pointers",
  "candidate_memory",
] as const;

export type CompletePackSectionName =
  (typeof COMPLETE_PACK_SECTION_NAMES)[number];

/**
 * One sealed synthetic seed for the complete-pack corpus.
 *
 * `id` is a fixture-local handle, mapped to the server-assigned UUID at seed
 * time. `namespace_role` decides which caller seeds it and where:
 *  - "primary": seeded under the primary throwaway namespace; a
 *    durable_memory-eligible record the pack recall should be able to surface.
 *  - "negative": seeded into the sibling namespace the pack caller cannot read;
 *    it must never appear in any pack section item or citation.
 */
export interface CompletePackCorpusEntry {
  id: string;
  table: CompletePackTable;
  namespace_role: "primary" | "negative";
  content: string;
  tags: string[];
}

export interface CompletePackFixture {
  schema_version: 1;
  fixture_id: string;
  description: string;
  /** The recall query the pack is built around (drives durable_memory/pointers). */
  query: string;
  corpus: CompletePackCorpusEntry[];
  /**
   * Fixture-local ids of primary-role seeds the durable_memory recall is
   * expected to be able to surface for `query` (so a completely empty recall on
   * a namespace we just seeded is caught as a defect, not passed as "empty").
   */
  expected_recall_ids: string[];
  /**
   * Fixture-local ids of negative-role seeds that must never appear in any pack
   * section item or citation (isolation).
   */
  forbidden_ids: string[];
}

/**
 * A resolved seeded record: fixture handle, table, server UUID, physical
 * namespace, and role. Teardown only ever archives records described by this
 * shape, exactly like the recall gate's SeededRecord.
 */
export interface CompletePackSeededRecord {
  fixture_id: string;
  table: CompletePackTable;
  server_id: string;
  namespace: string;
  namespace_role: "primary" | "negative";
}

/**
 * One section's disposition after the pack is assembled. Content-free: only the
 * section name, a present/empty classification, a defined-empty reason label
 * (never a body), the item count, and the serialized-character contribution the
 * section made to the whole pack.
 */
export interface SectionVerdict {
  section: CompletePackSectionName;
  /** True when the section appeared in the emitted `sections` object at all. */
  present: boolean;
  /** True when the section had at least one emitted item. */
  has_items: boolean;
  /**
   * True when the section is in a DEFINED-EMPTY state: present with zero items
   * and a recognized empty/denial marker (or a legitimately-empty RAM-only
   * section), OR reported through a defined scope-denial / degraded-source.
   */
  defined_empty: boolean;
  /** Emitted item count (0 for empty/RAM-only sections). */
  item_count: number;
  /**
   * Content-free empty/denial classification, e.g. "items" (had items),
   * "candidate_predicate_unavailable", "exact_scope", "no_matches",
   * "ram_only_empty", "whole_pack_budget". Never a body.
   */
  disposition: string;
  /** Serialized characters this section contributed to the whole pack. */
  serialized_chars: number;
  /** Set only when the section failed its present-or-defined-empty check. */
  failure?: string;
}

/** Whole-pack serialized-budget accounting captured from the emitted pack. */
export interface BudgetVerdict {
  /** The whole-pack serialized char limit the tool reported. */
  content_char_limit: number | null;
  /** Serialized characters the whole `sections` object actually used. */
  serialized_sections_chars: number;
  /** True when serialized `sections` is within the reported limit. */
  within_budget: boolean;
  /** True when the tool reported a whole-pack allocation order for all nine. */
  allocation_order_complete: boolean;
}

/** Citation-truth accounting: citations must be a bijection of emitted items. */
export interface CitationVerdict {
  /** Total citations in the top-level citations array. */
  citations_total: number;
  /** Distinct emitted item citation_ids across all sections. */
  emitted_item_citations: number;
  /** Citation ids that reference no emitted item (dangling). */
  dangling_citations: number;
  /** Emitted item citation_ids with no matching top-level citation. */
  uncited_items: number;
  /** True when citations and emitted item citation_ids are a clean bijection. */
  bijective: boolean;
}

/** Isolation accounting for the complete pack. */
export interface IsolationVerdict {
  /** True when durable_lane_context reported its exact-scope defined-empty. */
  exact_scope_denied: boolean;
  /** Count of forbidden (negative-namespace) ids that surfaced anywhere. */
  namespace_leaks: number;
  /**
   * True when the expected primary recall ids surfaced in durable_memory items
   * (or as pointers), proving the recall actually reached the seeded namespace
   * rather than returning a hollow empty that would hide a broken predicate.
   */
  expected_recall_present: boolean;
}

/**
 * Explicit cross-namespace denial proof for the complete-pack gate, mirroring
 * the recall gate's NegativeControlProof. The PRIMARY caller attempts a
 * primary-identity read against the NEGATIVE namespace, and the server MUST deny
 * it. A denial is the ONLY proof of isolation the gate trusts: an
 * allowed-but-empty read looks identical to a working boundary but proves
 * nothing, so `allowed-empty` and `allowed-nonempty` both fail here. This is
 * distinct from the leak walk over the emitted pack (which only catches a
 * forbidden id that happened to surface below the result cut); the denial probe
 * proves the boundary refuses the read at all. Content-free: only booleans, a
 * count, and a redacted failure label.
 */
export interface NegativeControlVerdict {
  /** True when the cross-namespace read was actually attempted this run. */
  ran: boolean;
  /** True when the primary caller's read of the negative namespace was denied. */
  denied: boolean;
  /**
   * Hit count observed if the read unexpectedly SUCCEEDED; 0 on denial. Lets the
   * receipt distinguish "denied" from "allowed but empty" content-free.
   */
  observed_hit_count: number;
  /** True when a distinct negative token also exercised cross-token denial. */
  cross_token: boolean;
  /** Content-free reason the proof did not establish isolation, if any. */
  failure?: string;
}

/** Content-free structured baseline receipt for the complete-pack gate. */
export interface CompletePackReceipt {
  schema: "openbrain.complete_pack_gate.v1";
  generated_at: string;
  commit: string;
  fixture_id: string;
  primary_namespace: string;
  negative_namespace: string;
  requested_sections: CompletePackSectionName[];
  seeded: { primary: number; negative: number };
  sections: SectionVerdict[];
  budget: BudgetVerdict;
  citations: CitationVerdict;
  isolation: IsolationVerdict;
  negative_control: NegativeControlVerdict;
  /**
   * Composite verdict. PASS requires ALL of: every requested section present or
   * defined-empty, citation bijection, serialized budget respected with a
   * complete allocation order, exact-scope isolation with zero namespace leaks
   * and the expected recall present, the cross-namespace denial probe ran and
   * was denied, and teardown left nothing behind.
   */
  passed: boolean;
  failures: string[];
  teardown: {
    attempted: number;
    archived: number;
    already_absent: number;
    failed: number;
  };
}
