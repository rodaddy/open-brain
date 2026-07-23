// Standalone repo_facts section builder.
//
// Binds the ACTIVE repo exactly: metadata->>'repo' = $repo. There is no
// cross-repo fallback — an unmatched repo yields the defined empty state, never
// another repo's facts. Every included fact carries its source refs
// (source_commit, source_url) and a staleness disposition derived from the
// staleness_policy + verified_at semantics already defined in repo-facts.ts.
// The active repo is an explicit selector supplied by the caller because the
// context-pack scope carries no repo coordinate; this module does not derive
// the repo from source files or conversation.

import { STALENESS_POLICIES } from "./repo-facts.ts";

/** Local mirror of the write-side staleness_policy enum (repo-facts.ts). */
type FactStalenessPolicy = (typeof STALENESS_POLICIES)[number];
import {
  boundedItemText,
  databaseUnavailableFragment,
  resolveItemBudget,
  type SectionBudget,
  type SectionFragment,
  type SectionReaderDeps,
} from "./agent-context-pack-sections.ts";

const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_ITEM_CHARS = 2000;

/**
 * Refresh horizon (ms) for the two verified_at-sensitive policies. A fact
 * verified longer ago than this is dispositioned "refresh_due" (advisory,
 * content-free); the fact is still surfaced so the caller can decide.
 */
const REFRESH_REQUIRED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const STALENESS_POLICY_SET = new Set<string>(STALENESS_POLICIES);

export type RepoFactStalenessDisposition =
  | "source_pinned"
  | "commit_pinned"
  | "refresh_due"
  | "current"
  | "pointer_only"
  | "unknown_policy";

/**
 * Deterministic disposition from the stored staleness_policy + verified_at.
 * Mirrors the four STALENESS_POLICIES already enforced on write:
 *   stable_fact_verify_source -> source_pinned (re-verify against source_commit)
 *   commit_pinned             -> commit_pinned (valid only at source_commit)
 *   refresh_required          -> refresh_due when older than the horizon
 *   volatile_pointer_only     -> pointer_only (trust the pointer, not the body)
 * An absent/unrecognized policy is reported as unknown_policy rather than
 * assumed fresh.
 */
export function stalenessDispositionFor(
  policy: string | null,
  verifiedAt: string | null,
  nowMs: number,
): RepoFactStalenessDisposition {
  if (policy === null || !STALENESS_POLICY_SET.has(policy)) {
    return "unknown_policy";
  }
  const typed = policy as FactStalenessPolicy;
  switch (typed) {
    case "stable_fact_verify_source":
      return "source_pinned";
    case "commit_pinned":
      return "commit_pinned";
    case "volatile_pointer_only":
      return "pointer_only";
    case "refresh_required": {
      const verifiedMs = verifiedAt ? Date.parse(verifiedAt) : Number.NaN;
      if (!Number.isFinite(verifiedMs)) return "refresh_due";
      return nowMs - verifiedMs > REFRESH_REQUIRED_MAX_AGE_MS
        ? "refresh_due"
        : "current";
    }
  }
}

function metadataOf(row: Record<string, unknown>): Record<string, unknown> {
  const meta = row.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return meta as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type RepoFactsReaderArgs = {
  /** Auth-resolved, already-authorized namespace this section reads. */
  namespace: string;
  /**
   * The ACTIVE repo slug. Facts bind to this exactly; there is no fallback to
   * any other repo. When absent, the section is the defined empty state.
   */
  repo: string | null | undefined;
  /** Stable "now" for staleness math; injected so output is deterministic. */
  nowMs: number;
  /** Optional bounds; module defaults apply when absent. */
  budget?: SectionBudget;
};

/**
 * Assemble a repo_facts fragment bound to exactly one active repo. Deterministic
 * order: most-recently-updated first, then id. Empty state (no repo, or no
 * facts) is an explicit empty items array with repo echoed back, never another
 * repo's facts and never fabricated.
 */
export async function loadRepoFactsSection(
  args: RepoFactsReaderArgs,
  deps: SectionReaderDeps,
): Promise<SectionFragment> {
  const { maxItems, maxItemChars } = resolveItemBudget(args.budget, {
    maxItems: DEFAULT_MAX_ITEMS,
    maxItemChars: DEFAULT_MAX_ITEM_CHARS,
  });
  const repo = asText(args.repo);
  const budget = {
    max_items: maxItems,
    max_item_chars: maxItemChars,
    items_included: 0,
  };

  // No active repo -> defined empty state. Never widen the bind to recover.
  if (repo === null) {
    return {
      section: {
        label: "repo_facts",
        repo: null,
        namespace_bound: true,
        repo_bound: false,
        items: [],
        item_count: 0,
        truncated: false,
      },
      scopeDenials: [{ source: "repo_facts", reasons: ["no_active_repo"] }],
      truncation: [],
      degradedSources: [],
      budget,
      citations: [],
    };
  }

  try {
    // Exact repo bind. archived rows excluded. No cross-repo/legacy fallback:
    // if this repo has no facts, the loop below yields the empty state.
    const { rows } = await deps.query(
      `SELECT id, namespace, metadata, updated_at
         FROM ob_entities
        WHERE entity_type = 'repo_fact'
          AND archived_at IS NULL
          AND namespace = $1
          AND metadata->>'repo' = $2
        ORDER BY updated_at DESC, id DESC
        LIMIT $3`,
      [args.namespace, repo, maxItems + 1],
    );

    const truncation: Array<Record<string, unknown>> = [];
    let itemsTruncated = rows.length > maxItems;
    const capped = rows.slice(0, maxItems);

    const items: Array<Record<string, unknown>> = [];
    const citations: Array<Record<string, unknown>> = [];

    for (const row of capped) {
      const meta = metadataOf(row);
      const boundRepo = asText(meta.repo);
      // Defense in depth: never let a row whose metadata.repo drifted from the
      // bind slip through (guards against a JSON edit bypassing the predicate).
      if (boundRepo !== repo) continue;

      const sourceUrl = asText(meta.source_url);
      const sourceCommit = asText(meta.source_commit);
      // A repo fact without source refs cannot be cited to its exact commit;
      // exclude it rather than surface an uncitable fact.
      if (!sourceUrl || !sourceCommit) continue;

      const bounded = boundedItemText(meta.fact, maxItemChars);
      if (!bounded.text) {
        if (asText(meta.fact)) itemsTruncated = true;
        continue;
      }
      if (bounded.truncated) itemsTruncated = true;

      const disposition = stalenessDispositionFor(
        asText(meta.staleness_policy),
        asText(meta.verified_at),
        args.nowMs,
      );
      const citationId = `repo_fact:${String(row.id)}`;
      items.push({
        id: row.id,
        repo,
        path: asText(meta.path),
        subject: asText(meta.subject) ?? asText(meta.symbol),
        fact_type: asText(meta.fact_type),
        fact: bounded.text,
        source_commit: sourceCommit,
        source_url: sourceUrl,
        verified_at: asText(meta.verified_at),
        staleness_policy: asText(meta.staleness_policy),
        staleness_disposition: disposition,
        confidence:
          typeof meta.confidence === "number" ? meta.confidence : null,
        citation_id: citationId,
      });
      citations.push({
        id: citationId,
        kind: "repo_fact",
        source_ref: `ob_entities/${String(row.id)}`,
        source_url: sourceUrl,
        source_commit: sourceCommit,
      });
    }

    if (itemsTruncated) {
      truncation.push({
        source: "repo_facts",
        max_items: maxItems,
        max_item_chars: maxItemChars,
      });
    }

    return {
      section: {
        label: "repo_facts",
        repo,
        namespace_bound: true,
        repo_bound: true,
        items,
        item_count: items.length,
        truncated: truncation.length > 0,
      },
      scopeDenials: [],
      truncation,
      degradedSources: [],
      budget: { ...budget, items_included: items.length },
      citations,
    };
  } catch {
    return databaseUnavailableFragment("repo_facts", budget);
  }
}
