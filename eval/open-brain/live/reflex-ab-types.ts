// Types for the live Open Brain REFLEX A/B suppression gate (REFLEX-4, #335).
//
// This gate exercises the already-landed complete reflex (`agent_reflex_pointers`,
// #334) end-to-end under ONE per-run throwaway namespace, calling it TWICE over
// the SAME seeded evidence:
//
//   - suppression ENABLED: the already-known seeds' citation ids are echoed back
//     as `prior_context`, so the shared durable_memory recall drops records
//     already represented before any pointer is emitted.
//   - suppression DISABLED: no `prior_context` is sent, so every net-new
//     authorized durable record is emitted as a pointer.
//
// The comparison is the whole point: suppression ENABLED must return
// DEMONSTRABLY FEWER already-known items (zero redundant resurfacings), while
// still surfacing the net-new evidence. Both arms must independently clear the
// established EVAL-3 functional bar: every pointer cited (citation bijection),
// whole-pack budget respected, exact-scope authorized, and a cross-namespace
// denial control proven.
//
// Nothing here carries a secret, token, or memory body off-box: the corpus is
// synthetic and the receipt is content-free (labels, ids, counts, booleans).

/** Brain tables the reflex A/B gate seeds and archives. */
export type ReflexAbTable = "thoughts" | "decisions";

/**
 * One sealed synthetic seed for the reflex A/B corpus.
 *
 * `id` is a fixture-local handle, mapped to the server-assigned UUID at seed
 * time. `namespace_role` decides which caller seeds it and where:
 *  - "primary": seeded under the primary throwaway namespace; a
 *    durable_memory-eligible record the reflex recall can surface as a pointer.
 *  - "negative": seeded into the sibling namespace the reflex caller cannot
 *    read; it must never appear in any pointer or citation.
 *
 * `prior_known` marks a PRIMARY-role seed the model is treated as having ALREADY
 * been given this turn. Its emitted citation id is echoed back as
 * `prior_context` on the suppression-ON arm, so a correct reflex must suppress
 * it there while still emitting it on the suppression-OFF arm. It is meaningless
 * (and rejected) on a negative-role seed.
 */
export interface ReflexAbCorpusEntry {
  id: string;
  table: ReflexAbTable;
  namespace_role: "primary" | "negative";
  /**
   * True when this primary-role seed is "already-known" prior context. Suppressed
   * on the ON arm, resurfaced on the OFF arm. Defaults false.
   */
  prior_known?: boolean;
  content: string;
  tags: string[];
}

export interface ReflexAbFixture {
  schema_version: 1;
  fixture_id: string;
  description: string;
  /** The recall query the reflex is built around (drives the pointer pool). */
  query: string;
  corpus: ReflexAbCorpusEntry[];
  /**
   * Fixture-local ids of primary-role, prior-known seeds that must:
   *  - be emitted as pointers on the suppression-OFF arm (redundant resurfacing),
   *  - and be ABSENT on the suppression-ON arm (suppressed as prior context).
   * Non-empty: the A/B contrast has no meaning without at least one known item.
   */
  prior_known_ids: string[];
  /**
   * Fixture-local ids of primary-role, NET-NEW seeds that must be emitted as
   * pointers on BOTH arms (suppression never drops a net-new item). Non-empty: a
   * gate that only ever suppressed everything would trivially "return fewer".
   */
  net_new_ids: string[];
  /**
   * Fixture-local ids of negative-role seeds that must never appear as a pointer
   * or citation on EITHER arm (isolation).
   */
  forbidden_ids: string[];
}

/**
 * A resolved seeded record: fixture handle, table, server UUID, physical
 * namespace, role, and prior-known flag. Teardown only ever archives records
 * described by this shape, exactly like the recall/complete-pack gates.
 */
export interface ReflexAbSeededRecord {
  fixture_id: string;
  table: ReflexAbTable;
  server_id: string;
  namespace: string;
  namespace_role: "primary" | "negative";
  prior_known: boolean;
}

/**
 * The functional outcome of ONE reflex arm (suppression on or off). Content-free:
 * only ids/counts/booleans, never a pointer body. The pointer identity sets are
 * derived from the emitted pointers' SERVER ids (mapped back to fixture ids), so
 * relevance and resurfacing are measured against the seeded ground truth without
 * inspecting any memory body.
 */
export interface ReflexArmVerdict {
  /** "on" (prior_context sent) or "off" (no prior_context). */
  arm: "on" | "off";
  /** Total pointers emitted by this arm. */
  pointer_count: number;
  /** Count of expected net-new seeds surfaced as pointers (relevance signal). */
  net_new_present: number;
  /** Count of expected net-new seeds MISSING from pointers (relevance defect). */
  net_new_missing: number;
  /**
   * Count of already-known (prior-context) seeds that surfaced as pointers on
   * this arm. On the OFF arm this is the redundant-resurfacing baseline; on the
   * ON arm it MUST be zero (suppression removed them).
   */
  redundant_resurfacing: number;
  /** Count of forbidden (negative-namespace) ids that leaked into pointers. */
  namespace_leaks: number;
  /** True when the emitted pointers/citations form a clean bijection. */
  citations_bijective: boolean;
  /** Dangling citations (a citation with no emitted pointer). */
  dangling_citations: number;
  /** Uncited pointers (an emitted pointer with no citation). */
  uncited_pointers: number;
  /** True when the reflex kept every pointer body-free (identity/source_ref only). */
  body_free: boolean;
  /** True when placement is client-owned (no implicit _meta injection). */
  placement_client_owned: boolean;
  /** Whole-pack serialized budget accounting for this arm. */
  budget: {
    content_char_limit: number | null;
    serialized_pointers_chars: number;
    within_budget: boolean;
    allocation_order_complete: boolean;
  };
  /** Content-free reasons this arm failed its own functional bar, if any. */
  failures: string[];
}

/**
 * The A/B contrast between the two arms. This is the REFLEX-4 acceptance signal:
 * suppression ENABLED must return demonstrably fewer already-known items and no
 * redundant resurfacing, while preserving the net-new evidence both arms share.
 */
export interface ReflexAbComparison {
  /** Already-known items resurfaced with suppression OFF (baseline > 0). */
  known_resurfaced_off: number;
  /** Already-known items resurfaced with suppression ON (must be 0). */
  known_resurfaced_on: number;
  /** off - on: net already-known items suppression removed (must be > 0). */
  known_suppressed_delta: number;
  /** True when ON returned strictly fewer already-known items than OFF. */
  fewer_known_when_enabled: boolean;
  /** Net-new pointers common to both arms (suppression preserved the evidence). */
  net_new_preserved: number;
  /** True when every expected net-new seed survived on BOTH arms. */
  net_new_preserved_on_both: boolean;
}

/**
 * Explicit cross-namespace denial proof, mirroring the recall/complete-pack
 * gates' negative control. The PRIMARY caller attempts a primary-identity read
 * of the NEGATIVE namespace, and the server MUST deny it. A denial is the ONLY
 * proof of isolation the gate trusts: an allowed-but-empty read looks identical
 * to a working boundary but proves nothing, so both allowed cases fail here.
 */
export interface ReflexAbNegativeControl {
  ran: boolean;
  denied: boolean;
  observed_hit_count: number;
  cross_token: boolean;
  failure?: string;
}

/** Content-free structured baseline receipt for the reflex A/B gate. */
export interface ReflexAbReceipt {
  schema: "openbrain.reflex_ab_gate.v1";
  generated_at: string;
  commit: string;
  fixture_id: string;
  primary_namespace: string;
  negative_namespace: string;
  seeded: {
    primary: number;
    negative: number;
    prior_known: number;
    net_new: number;
  };
  arm_off: ReflexArmVerdict;
  arm_on: ReflexArmVerdict;
  comparison: ReflexAbComparison;
  negative_control: ReflexAbNegativeControl;
  /**
   * Composite verdict. PASS requires ALL of: both arms independently clear the
   * EVAL-3 functional bar (cited, body-free, budget-bounded, no leaks), the A/B
   * contrast shows suppression ENABLED returns strictly fewer already-known items
   * with zero redundant resurfacing, the net-new evidence is preserved on both
   * arms, the cross-namespace denial control ran and was denied, and teardown
   * left nothing behind.
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
