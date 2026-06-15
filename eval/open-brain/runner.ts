import type {
  EvalCategory,
  EvalCorpusEntry,
  EvalFixture,
  EvalProbe,
  EvalScorecard,
  ProbeScore,
  RankedEvalResult,
} from "./types.ts";

const CATEGORY_ORDER: EvalCategory[] = [
  "recall",
  "precision",
  "temporal",
  "identity",
  "citation",
  "contradiction",
  "namespace",
  "scale",
];

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9/_-]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2),
    ),
  );
}

function entryText(entry: EvalCorpusEntry): string {
  return [
    entry.title,
    entry.content,
    entry.tags.join(" "),
    (entry.aliases ?? []).join(" "),
  ].join(" ");
}

function scoreEntry(queryTokens: string[], entry: EvalCorpusEntry): number {
  const textTokens = new Set(tokenize(entryText(entry)));
  const overlap = queryTokens.filter((token) => textTokens.has(token)).length;
  const aliasBoost = (entry.aliases ?? []).some((alias) =>
    queryTokens.some((token) => tokenize(alias).includes(token)),
  )
    ? 0.5
    : 0;
  return overlap + aliasBoost;
}

export function retrieve(
  corpus: EvalCorpusEntry[],
  probe: EvalProbe,
): RankedEvalResult[] {
  const queryTokens = tokenize(probe.query);
  return corpus
    .filter((entry) => probe.readable_namespaces.includes(entry.namespace))
    .map((entry) => ({ entry, score: scoreEntry(queryTokens, entry) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.id.localeCompare(b.entry.id);
    })
    .slice(0, probe.top_k)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

function recallAtK(retrievedIds: string[], relevantIds: string[]): number {
  if (relevantIds.length === 0) return 1;
  const hits = relevantIds.filter((id) => retrievedIds.includes(id)).length;
  return hits / relevantIds.length;
}

function precisionAtK(retrievedIds: string[], relevantIds: string[]): number {
  if (retrievedIds.length === 0) return relevantIds.length === 0 ? 1 : 0;
  if (relevantIds.length === 0) return 0;
  const hits = retrievedIds.filter((id) => relevantIds.includes(id)).length;
  return hits / retrievedIds.length;
}

function isStale(entry: EvalCorpusEntry, probe: EvalProbe): boolean {
  if (!probe.max_age_days || !probe.as_of) return false;
  const asOf = new Date(probe.as_of).getTime();
  const updatedAt = new Date(entry.updated_at ?? entry.created_at).getTime();
  if (Number.isNaN(asOf) || Number.isNaN(updatedAt)) return true;
  return asOf - updatedAt > probe.max_age_days * 24 * 60 * 60 * 1000;
}

function normalizedUseTargets(content: string, pattern: RegExp): string[] {
  const targets: string[] = [];
  for (const match of content.toLowerCase().matchAll(pattern)) {
    const target = (match[1] ?? "")
      .replace(/[`~"'()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (target) targets.push(target);
  }
  return targets;
}

function hasUseContradiction(entries: EvalCorpusEntry[]): boolean {
  const affirmative = new Set<string>();
  const negative = new Set<string>();
  for (const entry of entries) {
    const negativeTargets = normalizedUseTargets(
      entry.content,
      /\b(?:should not|must not|do not|don't|never)\s+use\s+([^.;,]+)/g,
    );
    for (const target of negativeTargets) {
      negative.add(target);
    }

    const withoutNegativeUse = entry.content.replace(
      /\b(?:should not|must not|do not|don't|never)\s+use\s+[^.;,]+/gi,
      " ",
    );
    for (const target of normalizedUseTargets(
      withoutNegativeUse,
      /\b(?:should\s+use|must\s+use|use)\s+([^.;,]+)/g,
    )) {
      affirmative.add(target);
    }
  }
  return Array.from(negative).some((target) => affirmative.has(target));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function scoreProbe(corpus: EvalCorpusEntry[], probe: EvalProbe): ProbeScore {
  const started = performance.now();
  const ranked = retrieve(corpus, probe);
  const latencyMs = Math.max(0, performance.now() - started);
  const retrievedIds = ranked.map(({ entry }) => entry.id);
  const entries = ranked.map(({ entry }) => entry);
  const failures: string[] = [];
  const uncertainty: string[] = [];

  const recall = recallAtK(retrievedIds, probe.relevant_ids);
  const precision = precisionAtK(retrievedIds, probe.relevant_ids);
  const citationIds = entries.map((entry) => entry.source_ref.id);
  const forbiddenIds = probe.expected_forbidden_ids ?? [];

  if (recall < (probe.min_recall_at_k ?? 1)) {
    failures.push(`recall ${recall.toFixed(3)} below threshold`);
  }
  if (precision < (probe.min_precision_at_k ?? 0)) {
    failures.push(`precision ${precision.toFixed(3)} below threshold`);
  }
  if (forbiddenIds.some((id) => retrievedIds.includes(id))) {
    failures.push("retrieved forbidden namespace evidence");
  }
  if (probe.expect_no_results && retrievedIds.length > 0) {
    failures.push("expected no retrievable evidence");
  }
  for (const junkId of probe.junk_ids ?? []) {
    if (retrievedIds.includes(junkId)) {
      failures.push(`retrieved declared junk ${junkId}`);
    }
  }
  for (const expectedCitation of probe.expected_citation_ids ?? []) {
    if (!citationIds.includes(expectedCitation)) {
      failures.push(`missing expected citation ${expectedCitation}`);
    }
  }
  if (entries.some((entry) => isStale(entry, probe))) {
    uncertainty.push("stale");
  }
  if (hasUseContradiction(entries)) {
    uncertainty.push("contradiction");
  }
  for (const expected of probe.expected_uncertainty ?? []) {
    if (!uncertainty.includes(expected)) {
      failures.push(`missing expected uncertainty ${expected}`);
    }
  }
  if (probe.max_latency_ms && latencyMs > probe.max_latency_ms) {
    failures.push(`latency ${latencyMs.toFixed(3)}ms above threshold`);
  }

  return {
    id: probe.id,
    category: probe.category,
    passed: failures.length === 0,
    recall_at_k: recall,
    precision_at_k: precision,
    latency_ms: Number(latencyMs.toFixed(3)),
    retrieved_ids: retrievedIds,
    citation_ids: citationIds,
    uncertainty,
    failures,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function runEvalSuite(
  fixture: EvalFixture,
  opts: { commit?: string; generatedAt?: string } = {},
): EvalScorecard {
  const probes = fixture.probes.map((probe) => scoreProbe(fixture.corpus, probe));
  const categories = Object.fromEntries(
    CATEGORY_ORDER.map((category) => {
      const categoryProbes = probes.filter((probe) => probe.category === category);
      return [
        category,
        {
          probes_total: categoryProbes.length,
          probes_passed: categoryProbes.filter((probe) => probe.passed).length,
          recall_at_k: Number(mean(categoryProbes.map((probe) => probe.recall_at_k)).toFixed(3)),
          precision_at_k: Number(
            mean(categoryProbes.map((probe) => probe.precision_at_k)).toFixed(3),
          ),
        },
      ];
    }),
  ) as EvalScorecard["categories"];
  const citationProbes = probes.filter((probe) => probe.category === "citation");

  return {
    schema_version: 1,
    suite: "open-brain-memory",
    corpus_id: fixture.corpus_id,
    commit: opts.commit ?? "unknown",
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    probes_total: probes.length,
    probes_passed: probes.filter((probe) => probe.passed).length,
    probes_failed: probes.filter((probe) => !probe.passed).length,
    metrics: {
      recall_at_k: Number(mean(probes.map((probe) => probe.recall_at_k)).toFixed(3)),
      precision_at_k: Number(mean(probes.map((probe) => probe.precision_at_k)).toFixed(3)),
      citation_grounding: Number(
        mean(citationProbes.map((probe) => (probe.failures.length === 0 ? 1 : 0))).toFixed(3),
      ),
      namespace_leak_count: probes.filter((probe) =>
        probe.failures.includes("retrieved forbidden namespace evidence"),
      ).length,
      p95_latency_ms: Number(percentile(probes.map((probe) => probe.latency_ms), 95).toFixed(3)),
    },
    categories,
    probes,
  };
}

export function formatScorecard(scorecard: EvalScorecard): string {
  const verdict =
    scorecard.probes_failed === 0
      ? "PASS"
      : `FAIL (${scorecard.probes_failed}/${scorecard.probes_total} failed)`;
  const lines = [
    `Open Brain memory eval: ${verdict}`,
    `corpus=${scorecard.corpus_id} commit=${scorecard.commit}`,
    `recall@k=${scorecard.metrics.recall_at_k.toFixed(3)} precision@k=${scorecard.metrics.precision_at_k.toFixed(3)} citation=${scorecard.metrics.citation_grounding.toFixed(3)} namespace_leaks=${scorecard.metrics.namespace_leak_count} p95=${scorecard.metrics.p95_latency_ms.toFixed(3)}ms`,
    "",
    "Categories:",
  ];
  for (const category of CATEGORY_ORDER) {
    const result = scorecard.categories[category];
    lines.push(
      `- ${category}: ${result.probes_passed}/${result.probes_total} pass recall=${result.recall_at_k.toFixed(3)} precision=${result.precision_at_k.toFixed(3)}`,
    );
  }
  return lines.join("\n");
}
