import type { ContextPackPayload } from "./transport.ts";
import type {
  BudgetVerdict,
  CitationVerdict,
  IsolationVerdict,
  NegativeControlVerdict,
  SectionVerdict,
} from "./complete-pack-types.ts";
import { sanitizeStatus } from "./complete-pack-gate-sections.ts";

// The run-level failure lists for the complete-pack gate, extracted from
// complete-pack-gate.ts (issue 752 lint sweep). Every string is byte-identical
// to the inline version it replaced, in the same order: these strings are part
// of the gate's stdout interface.

/**
 * 1. Presence-or-defined-emptiness for all nine. A section fails when it is
 * neither present-with-items nor defined-empty, OR when it recorded any other
 * classification defect (e.g. a POPULATED section that also claims a
 * scope-denial for itself -- a forged/contradictory denial carries a `failure`
 * even though it has items). Surface a recorded `failure` regardless of
 * has_items so the populated-denial contradiction is not swallowed.
 */
export function sectionFailures(sections: SectionVerdict[]): string[] {
  const failures: string[] = [];
  for (const verdict of sections) {
    if (verdict.failure) {
      failures.push(verdict.failure);
    } else if (!verdict.has_items && !verdict.defined_empty) {
      failures.push(`${verdict.section}: not defined-empty`);
    }
  }
  return failures;
}

/**
 * The pack status failure. The raw status is server-controlled and could carry
 * an injected sentinel or body, so it is sanitized to a finite allowlisted label
 * (or a fixed generic) before it enters the content-free failures list.
 */
export function statusFailures(payload: ContextPackPayload): string[] {
  return payload.status === "ok"
    ? []
    : [`pack status is '${sanitizeStatus(payload.status)}', expected 'ok'`];
}

/** 3. Citation truth. */
export function citationFailures(citations: CitationVerdict): string[] {
  return citations.bijective
    ? []
    : [
        `citations not bijective: dangling=${citations.dangling_citations} uncited=${citations.uncited_items}`,
      ];
}

/** 4. Serialized budget. */
export function budgetFailures(budget: BudgetVerdict): string[] {
  const failures: string[] = [];
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
  return failures;
}

/** 2. Exact-scope isolation. */
export function isolationFailures(isolation: IsolationVerdict): string[] {
  const failures: string[] = [];
  if (!isolation.exact_scope_denied) {
    failures.push("durable_lane_context did not report its exact-scope defined-empty");
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
  return failures;
}

/**
 * 6. Explicit cross-namespace denial. A leak-free emitted pack is NOT enough:
 * the boundary must actually REFUSE the primary caller's read of the negative
 * namespace. An allowed read -- empty or not -- fails.
 */
export function negativeControlFailures(
  negativeControl: NegativeControlVerdict,
): string[] {
  if (!negativeControl.ran) {
    return [
      `negative-control proof did not run: ${negativeControl.failure ?? "unknown"}`,
    ];
  }
  if (!negativeControl.denied) {
    return [
      `negative-control not denied: ${negativeControl.failure ?? "isolation not proven"}`,
    ];
  }
  return [];
}
