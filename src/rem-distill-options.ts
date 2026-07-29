/**
 * The distillation pass — Terra's judgements become the operator's buttons.
 *
 * WHY THIS EXISTS AS A SEPARATE STAGE. Operator, 2026-07-29: "the point of
 * this isn't for this session to come up with all of the pre-canned things.
 * This session is supposed to come up with yes or no and the reasons why...
 * and then you, as a separate entity as an opus model, are supposed to distill
 * that into the web page that I use to actually rank the shit."
 *
 * Terra grades ONE exchange at a time and cannot see across them. Asked to
 * write click-options from inside a single item, it produced four flavours of
 * agreement (measured, dream_run_001) — because from inside one item there is
 * nothing to disagree with. The options have to be composed by something that
 * has read the whole run, which is what this does.
 *
 * WHAT IT IS NOT. It is not a second opinion on the score, and it does not
 * re-grade. Terra's judgement stands; this only shapes how the operator
 * responds to it.
 *
 * THE OPTIONS ARE DERIVED FROM TERRA'S OWN ANGLES, NOT INVENTED. Every option
 * cites the reason text it came from, so the page can show what it was built
 * on and the operator can audit it — "the ability to edit and audit what is
 * there" (2026-07-29). An option with no provenance is a guess wearing a
 * button, and this repo has paid for those.
 *
 * THE DEFAULT IS PRE-SELECTED. "if on the web page you set a baseline default
 * that sort of matches what Terra came up with, so that if I agree it's a
 * quick easy click-through that might be the most ideal path". So exactly one
 * option per item carries `is_default`, and it is the one matching Terra's own
 * verdict. Agreeing costs one click; disagreeing costs two.
 */

import type { TerraJudgement } from "./rem-terra-grader.ts";

/** One button on the review page. */
export interface GradeOption {
  /**
   * Stable across items so counts aggregate. This is the lesson of migration
   * 042: the operator's free-text notes were "five sentences expressing three
   * ideas, retyped with a typo and a new phrasing each time", sharing not one
   * word, so no search found both. A code makes "which way do I most often
   * disagree" a GROUP BY instead of a reading exercise.
   */
  code: string;
  /** Button text. Short enough to scan a row without reading. */
  label: string;
  /** Inserted into the editable note. The operator rewrites it freely. */
  text: string;
  /** The score this option sets. The operator can still override it. */
  score: number;
  /** Exactly one option per item has this. */
  is_default?: boolean;
  /**
   * The Terra reason this was built from, so the page can show its basis.
   * Empty only for the fixed escape hatches, which are not derived.
   */
  derived_from?: string;
}

/**
 * Pick the angle that best matches a facet.
 *
 * Terra's reasons are unordered and phrased freely, so the match is by keyword
 * rather than position. A missing match yields undefined and the caller omits
 * that option rather than fabricating one — an option that does not reflect
 * anything Terra said is exactly the invented button this pass exists to avoid.
 */
function angle(reasons: string[], words: RegExp): string | undefined {
  return reasons.find((r) => words.test(r));
}

/**
 * Compose the options for one item.
 *
 * Four shapes, drawn from the patterns visible across a whole run rather than
 * chosen a priori (measured on dream_run_003, 40 reasons over 10 items):
 *
 *   AGREE      — Terra's read, restated. Always present, always the default.
 *   DURABILITY — every single reason set carried a durable-vs-transient angle,
 *                and that is the axis a disagreement usually turns on. Points
 *                the opposite way from the score: if Terra scored it high, the
 *                option argues transient, and vice versa.
 *   BEHAVIOR   — present only when Terra judged the agent's conduct, which is
 *                the axis 042 gave a column to and which moves independently
 *                of value.
 *   SCOPE      — the hedge ("specific to an active batch", "details may
 *                evolve") that appeared exactly where scores sat mid-range.
 */
export function composeOptions(j: TerraJudgement): GradeOption[] {
  const options: GradeOption[] = [];
  const high = j.score >= 7;

  // AGREE. The default, and the only option guaranteed to exist.
  options.push({
    code: "agree",
    label: `agree — ${j.score}`,
    text: j.reasons[0] ?? j.synopsis,
    score: j.score,
    is_default: true,
    derived_from: j.reasons[0],
  });

  // DURABILITY, pointed against the score so it is a real alternative.
  const durable = angle(
    j.reasons,
    /durable|standing|rule|persists|ongoing|forever|architecture/i,
  );
  const transient = angle(
    j.reasons,
    /transient|short|specific to|may evolve|task-specific|one-off|active batch/i,
  );
  if (high && transient) {
    options.push({
      code: "less_durable_than_scored",
      label: "narrower than that",
      text: transient,
      // Below the promote cut, so the disagreement actually changes the verdict
      // rather than only nudging the ordering.
      score: 4,
      derived_from: transient,
    });
  } else if (!high && durable) {
    options.push({
      code: "more_durable_than_scored",
      label: "keep it, this lasts",
      text: durable,
      score: 8,
      derived_from: durable,
    });
  }

  // BEHAVIOR. Independent of value: a high-value memory often records BAD
  // agent behavior, and those are among the most worth keeping.
  if (j.agent_behavior !== "neutral") {
    const behaviorAngle = angle(
      j.reasons,
      /agent|response|ignored|did not|executed|accounted|confirm/i,
    );
    if (behaviorAngle) {
      options.push({
        code:
          j.agent_behavior === "bad"
            ? "keep_for_the_mistake"
            : "keep_for_the_method",
        label:
          j.agent_behavior === "bad"
            ? "worth keeping for what went wrong"
            : "worth keeping for how it was done",
        text: behaviorAngle,
        // The behavior is the reason to keep it, so it does not sink.
        score: Math.max(j.score, 7),
        derived_from: behaviorAngle,
      });
    }
  }

  // The escape hatches. Not derived, deliberately: "none of the above, it's
  // actually this" has to exist whatever Terra said, and it is the option that
  // produces the most informative disagreement when it is used.
  options.push({
    code: "drop_it",
    label: "not worth keeping",
    text: "",
    score: 0,
  });

  return options;
}

/**
 * Options for a whole run, keyed by candidate id.
 *
 * Takes the run as a unit rather than mapping item-by-item because the point
 * of this pass is cross-item sight. Today the composition is per-item; keeping
 * the signature run-shaped means adding a cross-item rule — "these three
 * exchanges restate one standing rule, offer to grade them together" — does
 * not change every caller.
 */
export function composeRunOptions(
  judgements: TerraJudgement[],
): Map<string, GradeOption[]> {
  return new Map(judgements.map((j) => [j.id, composeOptions(j)]));
}
