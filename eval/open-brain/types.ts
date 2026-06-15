export type EvalCategory =
  | "recall"
  | "precision"
  | "temporal"
  | "identity"
  | "citation"
  | "contradiction"
  | "namespace"
  | "scale";

export type CorpusEntryType = "thought" | "decision" | "relationship" | "project" | "session";

export interface EvalSourceRef {
  source: "brain";
  type: CorpusEntryType;
  id: string;
  namespace: string;
  label: string;
  preview: string;
  created_at: string;
  last_updated_at?: string;
}

export interface EvalCorpusEntry {
  id: string;
  namespace: string;
  type: CorpusEntryType;
  title: string;
  content: string;
  tags: string[];
  aliases?: string[];
  created_at: string;
  updated_at?: string;
  source_ref: EvalSourceRef;
}

export interface EvalProbe {
  id: string;
  category: EvalCategory;
  query: string;
  readable_namespaces: string[];
  top_k: number;
  relevant_ids: string[];
  junk_ids?: string[];
  expect_no_results?: boolean;
  expected_citation_ids?: string[];
  expected_uncertainty?: string[];
  expected_forbidden_ids?: string[];
  max_age_days?: number;
  as_of?: string;
  min_recall_at_k?: number;
  min_precision_at_k?: number;
  max_latency_ms?: number;
}

export interface EvalFixture {
  schema_version: 1;
  corpus_id: string;
  generated_at: string;
  corpus: EvalCorpusEntry[];
  probes: EvalProbe[];
}

export interface RankedEvalResult {
  entry: EvalCorpusEntry;
  score: number;
  rank: number;
}

export interface ProbeScore {
  id: string;
  category: EvalCategory;
  passed: boolean;
  recall_at_k: number;
  precision_at_k: number;
  latency_ms: number;
  retrieved_ids: string[];
  citation_ids: string[];
  uncertainty: string[];
  failures: string[];
}

export interface EvalScorecard {
  schema_version: 1;
  suite: "open-brain-memory";
  corpus_id: string;
  commit: string;
  generated_at: string;
  probes_total: number;
  probes_passed: number;
  probes_failed: number;
  metrics: {
    recall_at_k: number;
    precision_at_k: number;
    citation_grounding: number;
    namespace_leak_count: number;
    p95_latency_ms: number;
  };
  categories: Record<
    EvalCategory,
    {
      probes_total: number;
      probes_passed: number;
      recall_at_k: number;
      precision_at_k: number;
    }
  >;
  probes: ProbeScore[];
}
