/**
 * The real Terra transport — `codex exec`, subscription-routed.
 *
 * `rem-terra-grader.ts` takes its transport by injection so the grader can be
 * tested without a model. This is the implementation that actually spends a
 * call, kept in its own file for the same reason: nothing here is unit
 * testable without hitting Terra, so it stays small, and everything that CAN
 * be tested lives in the grader instead.
 *
 * MEASURED BEFORE WRITING THIS (2026-07-29, one real call):
 *   `codex exec --model gpt-5.6-terra -c model_reasoning_effort=low` returned
 *   exactly the requested JSON shape, no prose, no code fences, in ~40s for
 *   17,688 tokens. That probe is why this file parses stdout rather than
 *   defending against markdown wrappers it does not actually emit -- though it
 *   strips fences anyway, because one probe is not a guarantee.
 *
 *   `--output-last-message <FILE>` was tried first and REFUSED to write:
 *   "Operation not permitted (os error 1)". The Codex sandbox will not write
 *   to the share, so the last message is read from stdout. This is recorded
 *   because it looks like the obviously-correct flag and costs a call to
 *   discover otherwise.
 *
 * WHY NOT A WORKFLOW NODE. The mixed-model routing contract governs Workflow
 * `agent()` calls, where a hand-written worker command would bypass the
 * router. This is not a Workflow -- it is a maintenance stage that needs a
 * model, running under `runRemGrading`. The model, effort and access are
 * pinned here as constants rather than chosen per call, which is the property
 * the routing rule exists to guarantee.
 */

import type { TerraJudgement, TerraTransport } from "./rem-terra-grader.ts";

/**
 * Per-call ceiling. A batch that runs longer than this is a hung call, not a
 * slow one: the probe returned in ~40s for a single item, and a 50-item batch
 * that has not answered in ten minutes is not going to.
 */
const TIMEOUT_MS = 600_000;

/**
 * Pull the JSON object out of whatever the model returned.
 *
 * The probe returned bare JSON, but a grader that dies on an unexpected code
 * fence would lose a whole batch to a formatting whim. So: strip fences, then
 * take the outermost braces. Anything else throws, and the grader's caller
 * turns that into a per-batch fallback rather than a failed pass.
 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`no JSON object in model output (${raw.length} chars)`);
  }
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Coerce one returned entry, dropping anything that cannot be trusted.
 *
 * A malformed entry is discarded rather than defaulted. A defaulted score is
 * indistinguishable from a real one downstream -- it would sit in the queue
 * ordering as though Terra had judged it -- and 037's whole discipline is that
 * a guess must stay attributable. Dropping it makes the grader fall back to
 * the heuristic, which is honest about what it is.
 */
function coerce(entry: unknown): TerraJudgement | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string") return null;
  if (typeof e.score !== "number" || !Number.isInteger(e.score)) return null;
  if (e.score < 0 || e.score > 10) return null;

  const behavior =
    e.agent_behavior === "good" ||
    e.agent_behavior === "bad" ||
    e.agent_behavior === "neutral"
      ? e.agent_behavior
      : "neutral";

  return {
    id: e.id,
    score: e.score,
    label: typeof e.label === "string" ? e.label : "",
    quote: typeof e.quote === "string" ? e.quote : "",
    synopsis: typeof e.synopsis === "string" ? e.synopsis : "",
    agent_behavior: behavior,
    reasons: Array.isArray(e.reasons)
      ? e.reasons.filter((r): r is string => typeof r === "string")
      : [],
  };
}

/** Sends one batch to Terra and returns the judgements it could parse. */
export const runTerraBatch: TerraTransport = async ({
  model,
  effort,
  prompt,
  items,
}) => {
  // The items travel as JSON in the prompt rather than as a file, because the
  // sandbox that refused --output-last-message also cannot be relied on to
  // read one. Everything the model needs is in the message.
  const payload = [
    prompt,
    "",
    'Return ONLY a JSON object of the form {"grades":[...]}. No prose, no',
    "code fences, no commentary before or after.",
    "",
    "ITEMS (each carries turn_count, operator_chars and agent_chars -- the",
    "shape of the interaction, supplied because you see one exchange at a time):",
    JSON.stringify(items),
  ].join("\n");

  const proc = Bun.spawn(
    [
      `${process.env.HOME}/.local/bin/codex`,
      "exec",
      "--model",
      model,
      "-c",
      `model_reasoning_effort=${effort}`,
      "--skip-git-repo-check",
      "-",
    ],
    {
      stdin: new TextEncoder().encode(payload),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  let stdout: string;
  try {
    // Drain BOTH pipes concurrently. `codex exec` writes reasoning/progress
    // diagnostics to stderr; if the parent reads only stdout, a stderr pipe
    // that fills its OS buffer (~64 KB) blocks the child mid-write -- it never
    // flushes stdout's EOF and never exits, so both the stdout read and
    // `proc.exited` hang until the ten-minute kill timer fires and the whole
    // batch falls back to heuristic grading. Consuming stderr in parallel keeps
    // the child unblocked; the drained text is discarded (it is diagnostics,
    // and this sink never surfaces model output through the error channel).
    const [out] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = out;
  } finally {
    clearTimeout(timer);
  }

  if (proc.exitCode !== 0) {
    throw new Error(`codex exec exited ${proc.exitCode}`);
  }

  const parsed = extractJson(stdout) as { grades?: unknown };
  if (!Array.isArray(parsed.grades)) {
    throw new Error("model output had no grades array");
  }

  return parsed.grades
    .map(coerce)
    .filter((j): j is TerraJudgement => j !== null);
};
