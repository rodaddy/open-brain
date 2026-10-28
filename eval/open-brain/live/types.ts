// Types for the live Open Brain recall gate (EVAL-1/2/3, issues #322-#324).
//
// The live gate seeds a unique throwaway namespace with a sealed synthetic
// corpus, runs recall queries through the real Open Brain client/transport,
// scores deterministic ranking metrics, compares against versioned thresholds,
// and then tears down exactly the records this run created.
//
// Nothing in this module is allowed to carry a secret, token, or live memory
// body off-box: fixtures are synthetic and receipts are content-free.

/** Brain tables that can hold a durable memory the gate seeds and archives. */
export type LiveMemoryTable = "thoughts" | "decisions";

/**
 * A single sealed synthetic memory to seed into the throwaway namespace.
 *
 * `id` is a fixture-local handle (NOT the server-assigned UUID). The seeder
 * maps each fixture id to the UUID the server returns so scoring and teardown
 * can talk about "the record the gate created for fixture id X".
 *
 * `namespace_role` decides which token seeds it:
 *  - "primary": seeded and read under the primary throwaway namespace.
 *  - "negative": seeded into a sibling namespace the query token cannot read;
 *    it must never appear in a primary-namespace search result.
 */
export interface LiveCorpusEntry {
  id: string;
  table: LiveMemoryTable;
  namespace_role: "primary" | "negative";
  content: string;
  tags: string[];
}

/**
 * A graded relevance judgment for one expected memory under a probe.
 * Grade 0 means "explicitly non-relevant" (a distractor that shares terms);
 * higher grades are more relevant. Recall/precision treat grade > 0 as relevant.
 */
export interface GradedRelevance {
  id: string;
  grade: number;
}

/**
 * A recall probe: a natural-language query plus the sealed expectation of which
 * seeded records are relevant, at what grade, and any records that must NOT be
 * returned (out-of-namespace negatives).
 */
export interface LiveProbe {
  id: string;
  query: string;
  /** Graded relevance over fixture-local corpus ids. */
  relevant: GradedRelevance[];
  /**
   * Fixture-local ids that must never appear in this probe's results.
   * Populated with negative-namespace entries to prove isolation.
   */
  forbidden_ids: string[];
}

export interface LiveFixture {
  schema_version: 1;
  fixture_id: string;
  description: string;
  /** Table used for teardown iteration and search default. */
  corpus: LiveCorpusEntry[];
  probes: LiveProbe[];
}

/** Versioned pass thresholds (thresholds.json). */
export interface LiveThresholds {
  schema_version: 1;
  thresholds_id: string;
  applies_to_fixture_id: string;
  top_k: number;
  thresholds: {
    min_recall_at_k: number;
    min_precision_at_k: number;
    min_mrr: number;
    max_namespace_leaks: number;
  };
  notes?: string;
}

/** Per-probe deterministic scores over a ranked list of retrieved ids. */
export interface ProbeMetric {
  probe_id: string;
  recall_at_k: number;
  precision_at_k: number;
  reciprocal_rank: number;
  /** Count of forbidden (out-of-namespace) ids that leaked into results. */
  namespace_leaks: number;
  retrieved_count: number;
  relevant_count: number;
}

/**
 * Result of the explicit negative-control isolation probe: the primary caller
 * attempts to read the negative namespace and the server must deny it. An empty
 * successful read is NOT proof of denial and fails the gate.
 */
export interface NegativeControlProof {
  /** True when a negative control was actually exercised this run. */
  ran: boolean;
  /** True when the primary caller's read of the negative namespace was denied. */
  denied: boolean;
  /**
   * Hit count observed if the read unexpectedly succeeded; 0 on denial. Used to
   * distinguish "denied" from "allowed but empty" content-free.
   */
  observed_hit_count: number;
  /** True when a distinct negative token also exercised cross-token denial. */
  cross_token: boolean;
  /** Content-free reason the proof did not establish isolation, if any. */
  failure?: string;
}

/** Aggregate metrics over all probes, plus the pass/fail verdict. */
export interface LiveScorecard {
  fixture_id: string;
  thresholds_id: string;
  top_k: number;
  probes_total: number;
  recall_at_k: number;
  precision_at_k: number;
  mrr: number;
  namespace_leaks: number;
  passed: boolean;
  failures: string[];
  probes: ProbeMetric[];
}

/**
 * A resolved seeded record: the fixture handle, the table it lives in, the
 * server-assigned UUID, and the exact physical namespace it was written to.
 * Teardown only ever archives records described by this shape.
 */
export interface SeededRecord {
  fixture_id: string;
  table: LiveMemoryTable;
  server_id: string;
  namespace: string;
  namespace_role: "primary" | "negative";
}

/** Content-free structured baseline receipt emitted by the gate. */
export interface LiveGateReceipt {
  schema: "openbrain.live_recall_gate.v1";
  generated_at: string;
  commit: string;
  fixture_id: string;
  thresholds_id: string;
  top_k: number;
  primary_namespace: string;
  negative_namespace: string;
  seeded: {
    primary: number;
    negative: number;
  };
  metrics: {
    recall_at_k: number;
    precision_at_k: number;
    mrr: number;
    namespace_leaks: number;
  };
  thresholds: LiveThresholds["thresholds"];
  probes: Array<{
    probe_id: string;
    recall_at_k: number;
    precision_at_k: number;
    reciprocal_rank: number;
    namespace_leaks: number;
  }>;
  /** Explicit negative-control isolation proof (primary read of negative ns). */
  negative_control: {
    ran: boolean;
    denied: boolean;
    observed_hit_count: number;
    cross_token: boolean;
    failure?: string;
  };
  /**
   * Overall gate verdict. PASS requires ALL of: scorecard thresholds met, the
   * negative-control proof ran and denied, and teardown left nothing behind
   * (failed === 0). A metrics-only pass can never report PASS here.
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
