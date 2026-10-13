import type { ReflexPointersPayload } from "./transport.ts";
import type {
  ReflexAbComparison,
  ReflexAbFixture,
  ReflexAbNegativeControl,
  ReflexAbReceipt,
  ReflexAbSeededRecord,
  ReflexArmVerdict,
} from "./reflex-ab-types.ts";
import {
  emittedKnownServerIds,
  serverIdSetsEqual,
  type KnownPointerRefs,
} from "./reflex-ab-gate-support.ts";

// The A/B comparison and run-level failure phases of the reflex gate, extracted
// from reflex-ab-gate.ts (issue 752 lint sweep). Behavior-identical: the same
// derived numbers and the same failure strings in the same order.

export interface ComparisonInputs {
  offPayload: ReflexPointersPayload;
  controlPayload: ReflexPointersPayload;
  armOff: ReflexArmVerdict;
  armControl: ReflexArmVerdict;
  armOn: ReflexArmVerdict;
  knownRefs: KnownPointerRefs;
  seeded: ReflexAbSeededRecord[];
  fixture: ReflexAbFixture;
}

/**
 * Build the REFLEX-4 A/B comparison. Content-free emitted prior-known server id
 * sets drive the stability/coverage controls: `priorKnownServerIds` is the
 * ground-truth known set (primary-role, prior_known seeds), and the emitted sets
 * are what each unsuppressed arm surfaced.
 */
export function buildComparison(input: ComparisonInputs): ReflexAbComparison {
  const { armOff, armControl, armOn, knownRefs } = input;
  const priorKnownServerIds = new Set(
    input.seeded
      .filter(
        (r) =>
          r.namespace_role === "primary" &&
          input.fixture.prior_known_ids.includes(r.fixture_id),
      )
      .map((r) => r.server_id),
  );
  const offKnownEmitted = emittedKnownServerIds(input.offPayload, priorKnownServerIds);
  const controlKnownEmitted = emittedKnownServerIds(
    input.controlPayload,
    priorKnownServerIds,
  );
  const knownResurfacingStable =
    offKnownEmitted.size > 0 && serverIdSetsEqual(offKnownEmitted, controlKnownEmitted);
  // The prior_context the gate sent must EXACTLY cover the OFF arm's emitted
  // known set: every emitted known item is referenced and no reference points at
  // a known item the OFF arm did not resurface.
  const referencesCoverOffKnown =
    knownRefs.referencedServerIds.size > 0 &&
    serverIdSetsEqual(knownRefs.referencedServerIds, offKnownEmitted);

  return {
    known_resurfaced_off: armOff.redundant_resurfacing,
    known_resurfaced_control: armControl.redundant_resurfacing,
    known_resurfaced_on: armOn.redundant_resurfacing,
    known_suppressed_delta: armOff.redundant_resurfacing - armOn.redundant_resurfacing,
    fewer_known_when_enabled:
      armOn.redundant_resurfacing < armOff.redundant_resurfacing,
    known_resurfacing_stable: knownResurfacingStable,
    stable_known_count: knownResurfacingStable ? offKnownEmitted.size : 0,
    references_sent: knownRefs.refs.length,
    references_cover_off_known: referencesCoverOffKnown,
    net_new_preserved: Math.min(
      armOff.net_new_present,
      armControl.net_new_present,
      armOn.net_new_present,
    ),
    net_new_preserved_on_both:
      armOff.net_new_missing === 0 &&
      armControl.net_new_missing === 0 &&
      armOn.net_new_missing === 0,
  };
}

/**
 * The A/B contrast failures. Suppression ENABLED must return strictly fewer
 * already-known items, over a non-vacuous and stable unsuppressed baseline whose
 * emitted known set the sent prior_context exactly covers.
 */
export function contrastFailures(
  comparison: ReflexAbComparison,
  armOff: ReflexArmVerdict,
): string[] {
  const failures: string[] = [];
  // A/B contrast: the OFF arm must ACTUALLY have resurfaced at least one known
  // item, otherwise there is nothing to suppress and the contrast is vacuous.
  if (armOff.redundant_resurfacing === 0) {
    failures.push(
      "off arm resurfaced zero already-known items: the A/B contrast is vacuous (suppression had nothing to remove)",
    );
  }
  // Stability control: the two UNSUPPRESSED arms (OFF and CONTROL) must resurface
  // the SAME non-vacuous already-known set. If they disagree, a variable ranked
  // recall dropped known items on its own and the ON arm's zero cannot be
  // attributed to suppression.
  if (!comparison.known_resurfacing_stable) {
    failures.push(
      `unsuppressed known resurfacing is not stable across off/control (off=${comparison.known_resurfaced_off} control=${comparison.known_resurfaced_control} stable_known=${comparison.stable_known_count}): a variable recall could masquerade as suppression`,
    );
  }
  // Reference-coverage control: the prior_context the gate fed the ON arm must be
  // non-empty AND exactly cover the OFF arm's emitted known set, so suppression
  // is acting on precisely the items that were resurfaced.
  if (comparison.references_sent === 0) {
    failures.push(
      "no prior_context references were sent to the suppression arm: suppression had nothing to act on",
    );
  }
  if (!comparison.references_cover_off_known) {
    failures.push(
      `prior_context references (${comparison.references_sent}) do not exactly cover the off arm's emitted already-known set (${armOff.redundant_resurfacing}): the suppression contrast is not attributable`,
    );
  }
  if (!comparison.fewer_known_when_enabled) {
    failures.push(
      `suppression did not return fewer already-known items (off=${comparison.known_resurfaced_off} on=${comparison.known_resurfaced_on})`,
    );
  }
  if (comparison.known_resurfaced_on !== 0) {
    failures.push(
      `suppression enabled still resurfaced ${comparison.known_resurfaced_on} already-known item(s)`,
    );
  }
  if (!comparison.net_new_preserved_on_both) {
    failures.push(
      "suppression did not preserve the net-new evidence on all arms (off/control/on)",
    );
  }
  return failures;
}

/** The cross-namespace denial control's failure strings. */
export function negativeControlFailures(
  negativeControl: ReflexAbNegativeControl,
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

/** The per-role seeded counts the receipt records. */
export function seededCounts(
  seeded: ReflexAbSeededRecord[],
  fixture: ReflexAbFixture,
): ReflexAbReceipt["seeded"] {
  return {
    primary: seeded.filter((r) => r.namespace_role === "primary").length,
    negative: seeded.filter((r) => r.namespace_role === "negative").length,
    prior_known: seeded.filter((r) => r.namespace_role === "primary" && r.prior_known)
      .length,
    net_new: seeded.filter(
      (r) =>
        r.namespace_role === "primary" && fixture.net_new_ids.includes(r.fixture_id),
    ).length,
  };
}
