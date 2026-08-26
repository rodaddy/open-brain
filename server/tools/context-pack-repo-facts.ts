/**
 * `repo_facts` — curated facts bound to exactly ONE active repository.
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Response Shape").
 *
 * The binding is exact: `metadata->>'repo' = $repo`. There is NO cross-repo
 * fallback, and that is the whole safety property of this section. An unmatched
 * repo yields the defined empty state, never another repo's facts — a fact about
 * a different codebase, presented as a fact about this one, is worse than no
 * fact at all, because it looks authoritative and cites a real commit.
 *
 * The active repo is an explicit selector supplied by the caller, because the
 * pack scope carries no repo coordinate. This module never infers the repo from
 * source files or conversation.
 */
import type { Logger } from "pino";
import {
  boundedItemText,
  databaseUnavailableFragment,
  resolveItemBudget,
  type SectionBudget,
  type SectionFragment,
  type SectionReaderDeps,
} from "./context-pack-sections.ts";
import { asError, errorIdentityFields } from "./context-pack-shared.ts";

/**
 * Read-side mirror of the write-side `staleness_policy` enum.
 *
 * Declared here rather than imported because the repo-fact WRITE path is not
 * part of this module's boundary. The set is small, closed, and stored in the
 * database, so an unrecognized value is reported as `unknown_policy` rather than
 * assumed fresh — which is what keeps this mirror safe if the write side ever
 * adds a member before the read side learns about it.
 */
export const STALENESS_POLICIES = [
  "stable_fact_verify_source",
  "commit_pinned",
  "refresh_required",
  "volatile_pointer_only",
] as const;

type FactStalenessPolicy = (typeof STALENESS_POLICIES)[number];

const STALENESS_POLICY_SET = new Set<string>(STALENESS_POLICIES);

/**
 * Unbounded by default. These are the repo's own curated truths; there is no
 * version of "the caller wanted the repo facts, but only twenty of them" that
 * anyone asked for. A caller passing an explicit budget still gets one.
 */
const DEFAULT_MAX_ITEMS = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_ITEM_CHARS = Number.MAX_SAFE_INTEGER;

/**
 * Refresh horizon for the verified_at-sensitive policy. A fact verified longer
 * ago than this is dispositioned `refresh_due` — ADVISORY and content-free. The
 * fact is still surfaced so the caller decides; silently withholding a possibly
 * stale fact would be a different kind of lie.
 */
const REFRESH_REQUIRED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type RepoFactStalenessDisposition =
  | "source_pinned"
  | "commit_pinned"
  | "refresh_due"
  | "current"
  | "pointer_only"
  | "unknown_policy";

/**
 * Deterministic disposition from the stored policy and `verified_at`:
 *   stable_fact_verify_source -> source_pinned (re-verify against source_commit)
 *   commit_pinned             -> commit_pinned (valid only at that commit)
 *   refresh_required          -> refresh_due when older than the horizon
 *   volatile_pointer_only     -> pointer_only (trust the pointer, not the body)
 * An absent or unrecognized policy is `unknown_policy`, never assumed fresh.
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
      // An unparseable verified_at is treated as due, not as current: the whole
      // point of this policy is that the fact needs periodic re-checking, and a
      // missing timestamp is not evidence it was checked.
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
   * any other repo. Absent means the defined empty state.
   */
  repo: string | null | undefined;
  /** Stable "now" for staleness math; injected so output is deterministic. */
  nowMs: number;
  budget?: SectionBudget;
};

type RepoFactRowAdmission =
  | { admitted: false; countsAsTruncated: boolean }
  | { admitted: true; text: string; truncated: boolean };

/**
 * Decide whether one row may become an item, and with what text.
 *
 * The three exclusions are ordered exactly as the original loop ran them, and
 * that order is behavior: only the LAST of them (an unusable `fact`) can mark
 * the section truncated, so a row rejected by an earlier guard must not reach
 * the text step and set that flag. Lifting the decision here keeps the three
 * reasons legible without letting them reorder.
 */
function admitRepoFactRow(
  meta: Record<string, unknown>,
  repo: string,
  maxItemChars: number,
): RepoFactRowAdmission {
  // Defense in depth: never let a row whose metadata.repo drifted from the
  // bind slip through, in case a JSON edit ever bypasses the predicate.
  if (asText(meta.repo) !== repo) {
    return { admitted: false, countsAsTruncated: false };
  }
  // A repo fact without source refs cannot be cited to its exact commit.
  // Excluding it is the point of the section: an uncitable "fact" is just an
  // assertion, and this section's value is that every item is checkable.
  if (!asText(meta.source_url) || !asText(meta.source_commit)) {
    return { admitted: false, countsAsTruncated: false };
  }
  const bounded = boundedItemText(meta.fact, maxItemChars);
  if (!bounded.text) {
    return { admitted: false, countsAsTruncated: asText(meta.fact) !== null };
  }
  return { admitted: true, text: bounded.text, truncated: bounded.truncated };
}

/** One admitted row as its item body and its matching citation. */
function repoFactEntry(options: {
  row: Record<string, unknown>;
  meta: Record<string, unknown>;
  repo: string;
  fact: string;
  nowMs: number;
}): {
  item: Record<string, unknown>;
  citation: Record<string, unknown>;
} {
  const { row, meta, repo, fact, nowMs } = options;
  const sourceUrl = asText(meta.source_url);
  const sourceCommit = asText(meta.source_commit);
  const citationId = `repo_fact:${String(row.id)}`;
  return {
    item: {
      id: row.id,
      repo,
      path: asText(meta.path),
      subject: asText(meta.subject) ?? asText(meta.symbol),
      fact_type: asText(meta.fact_type),
      fact,
      source_commit: sourceCommit,
      source_url: sourceUrl,
      verified_at: asText(meta.verified_at),
      staleness_policy: asText(meta.staleness_policy),
      staleness_disposition: stalenessDispositionFor(
        asText(meta.staleness_policy),
        asText(meta.verified_at),
        nowMs,
      ),
      confidence: typeof meta.confidence === "number" ? meta.confidence : null,
      citation_id: citationId,
    },
    citation: {
      id: citationId,
      kind: "repo_fact",
      source_ref: `ob_entities/${String(row.id)}`,
      source_url: sourceUrl,
      source_commit: sourceCommit,
    },
  };
}

/** Everything the row loop produces, before the envelope is assembled. */
type RepoFactCollection = {
  items: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  truncated: boolean;
};

/**
 * Walk the ordered rows once, admitting each through {@link admitRepoFactRow}.
 * `truncated` starts at the caller's row-count verdict and can only be set, so
 * the flag means "something did not make it in whole", exactly as before.
 */
function collectRepoFacts(options: {
  rows: Array<Record<string, unknown>>;
  repo: string;
  maxItemChars: number;
  nowMs: number;
  truncated: boolean;
}): RepoFactCollection {
  const { rows, repo, maxItemChars, nowMs } = options;
  const items: Array<Record<string, unknown>> = [];
  const citations: Array<Record<string, unknown>> = [];
  let truncated = options.truncated;

  for (const row of rows) {
    const meta = metadataOf(row);
    const admission = admitRepoFactRow(meta, repo, maxItemChars);
    if (!admission.admitted) {
      if (admission.countsAsTruncated) truncated = true;
      continue;
    }
    if (admission.truncated) truncated = true;
    const entry = repoFactEntry({
      row,
      meta,
      repo,
      fact: admission.text,
      nowMs,
    });
    items.push(entry.item);
    citations.push(entry.citation);
  }

  return { items, citations, truncated };
}

/** The defined empty state for a pack that carries no active repo. */
function noActiveRepoFragment(
  budget: Record<string, unknown>,
): SectionFragment {
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

/** The ordered, exactly-bound rows for one repo. No cross-repo fallback. */
async function queryRepoFactRows(
  deps: SectionReaderDeps,
  namespace: string,
  repo: string,
): Promise<Array<Record<string, unknown>>> {
  // Exact repo bind, archived rows excluded, no legacy fallback.
  const { rows } = await deps.query(
    `SELECT id, namespace, metadata, updated_at
         FROM ob_entities
        WHERE entity_type = 'repo_fact'
          AND archived_at IS NULL
          AND namespace = $1
          AND metadata->>'repo' = $2
        ORDER BY updated_at DESC, id DESC`,
    [namespace, repo],
  );
  return rows;
}

/**
 * Log a failed repo_facts read on two lines. ERROR states what broke so it is
 * visible at the default level; DEBUG carries every input that shaped the call.
 */
function logRepoFactsFailure(options: {
  logger: Logger | undefined;
  args: RepoFactsReaderArgs;
  repo: string;
  budget: Record<string, unknown>;
  error: unknown;
}): void {
  const { logger, args, repo, budget, error } = options;
  const identity = errorIdentityFields(error);
  logger?.error(
    { repo, namespace: args.namespace, ...identity },
    "repo_facts_section_failed",
  );
  logger?.debug(
    {
      repo,
      namespace: args.namespace,
      requested_budget: args.budget,
      resolved_budget: budget,
      ...identity,
      pg_code: (error as { code?: unknown })?.code ?? null,
      stack: asError(error)?.stack ?? null,
    },
    "repo_facts_section_failed_detail",
  );
}

/**
 * Assemble a repo_facts fragment bound to exactly one repo. Deterministic order:
 * most-recently-updated first, then id.
 */
export async function loadRepoFactsSection(
  args: RepoFactsReaderArgs,
  deps: SectionReaderDeps,
  logger?: Logger,
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
  if (repo === null) return noActiveRepoFragment(budget);

  try {
    const rows = await queryRepoFactRows(deps, args.namespace, repo);
    const overCount = rows.length > maxItems;
    const collected = collectRepoFacts({
      rows: overCount ? rows.slice(0, maxItems) : rows,
      repo,
      maxItemChars,
      nowMs: args.nowMs,
      truncated: overCount,
    });

    const truncation: Array<Record<string, unknown>> = collected.truncated
      ? [
          {
            source: "repo_facts",
            max_items: maxItems,
            max_item_chars: maxItemChars,
          },
        ]
      : [];

    return {
      section: {
        label: "repo_facts",
        repo,
        namespace_bound: true,
        repo_bound: true,
        items: collected.items,
        item_count: collected.items.length,
        truncated: truncation.length > 0,
      },
      scopeDenials: [],
      truncation,
      degradedSources: [],
      budget: { ...budget, items_included: collected.items.length },
      citations: collected.citations,
    };
  } catch (error) {
    logRepoFactsFailure({ logger, args, repo, budget, error });
    return databaseUnavailableFragment("repo_facts", budget);
  }
}
