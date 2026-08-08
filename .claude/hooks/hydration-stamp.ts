#!/usr/bin/env bun
/**
 * hydration-stamp — repo-local SessionStart check that the canon pack ARRIVED.
 *
 * ---------------------------------------------------------------------------
 * THE RULING THIS IMPLEMENTS, AND WHY IT IS NOT A GATE
 * ---------------------------------------------------------------------------
 * Issue #451, operator ruling 2026-08-08 (ledger item 24): the HYDRATION tier
 * is **VERIFY + STAMP**, never a block. Verbatim: "session start checks the
 * canon pack arrived with sections > 0; absence lands a loud visible marker on
 * the session and its PRs, never a block (a hydration block can only fire on
 * outages)."
 *
 * That parenthesis is the entire argument, and it is worth keeping in front of
 * whoever next wants to "strengthen" this file. A session cannot skip its own
 * hydration: it does not choose to hydrate, the SessionStart hook does it
 * automatically. So the ONLY state in which a hydration gate could ever fire is
 * one where the service failed to answer — an outage, i.e. the one case where
 * the session is blameless. A block here would therefore be a pure false-block
 * generator, and false blocks are how agents learn to route around guards
 * (#618, the guard that fired on heredoc text and taxed every lane until it was
 * fixed).
 *
 * The capture tier used to be the contrast case: a hard gate at merge, on the
 * argument that capture is an action the agent takes or omits, so a missing
 * receipt can mean a skip. Ledger item 25 (2026-08-08) RETIRED that tier —
 * raw capture turned out to be automatic and distillation is DREAM's job, so
 * the gate was blocking merges to force a hand-made duplicate of an automated
 * step, and its first live firing wedged the pipeline. The retired source is
 * kept at `.claude/hooks/_retired/capture-gate.ts` as prior art for the #647
 * liveness check. This file — verify and stamp, never block — is the tier that
 * survived, and the paragraph above is why it never had that failure mode.
 *
 * ---------------------------------------------------------------------------
 * ALWAYS EXIT 0
 * ---------------------------------------------------------------------------
 * This preserves, rather than changes, the fail-open contract every lifecycle
 * hook in this repo carries — session_start.py:41-43 ("FAIL OPEN. A hook that
 * opens a session must never block or break one"), and the same clause in
 * stop.py, session_end.py, and post_tool_use.py. Nothing here may exit non-zero
 * for any reason, including its own internal failure. A hook that breaks
 * sessions while reporting on session health is worse than no hook.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MARKER MUST NOT ALWAYS FIRE
 * ---------------------------------------------------------------------------
 * A marker printed on every session is decoration: it carries no information,
 * so it is filtered out by eye within a day and the absence it was meant to
 * surface becomes invisible again. The healthy path here is therefore SILENT,
 * and `scripts/done-means/451-tiered-coverage.sh` clause D2 is the standing
 * control that keeps it silent — it fails if a healthy pack produces a marker.
 *
 * MECHANISM
 *
 *   SessionStart — read the canon pack the session-start hydration produced and
 *   count its non-empty sections. Zero sections (or no pack at all) prints a
 *   loud marker naming the session. Always exits 0.
 */

import { readFileSync } from "node:fs";

type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  source?: string;
};

const HOOK_NAME = "hydration-stamp";

/**
 * Read the hook payload with a NON-BLOCKING read. Same rationale as every other
 * hook here: `await Bun.stdin.text()` wedged a session on 2026-07-28.
 */
function readInput(): HookInput {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

/**
 * The canon pack this session start produced, or null when none is observable.
 *
 * The pack is handed in through `DM451_CANON_PACK` — an explicit input rather
 * than a reach into the global hydration hook's internals. That is deliberate:
 * the non-goals of #451 forbid touching the global ~/.claude lifecycle hooks,
 * and reading their private state would couple this repo-local check to them
 * just as tightly as editing them.
 */
function readPack(): unknown | null {
  const raw = (process.env.DM451_CANON_PACK ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Count the non-empty sections of a canon pack.
 *
 * The pack's schema is `openbrain.agent_context_pack.v1`: `scope`, `sections`,
 * `warnings` (apps/hooks/session.py:918-936). "Arrived" means sections > 0 —
 * a pack whose sections object exists but is empty is exactly the measured
 * failure `_plans/canon-always-known.md:23-27` recorded (three lanes at 0
 * items), and it must count as ABSENT rather than present-but-empty. An empty
 * pack that reported healthy is the specific silence this tier exists to end.
 */
function countSections(pack: unknown): number {
  if (!pack || typeof pack !== "object") return 0;
  const sections = (pack as { sections?: unknown }).sections;
  if (!sections || typeof sections !== "object") return 0;
  let populated = 0;
  for (const value of Object.values(sections as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      if (value.length > 0) populated += 1;
    } else if (value !== null && value !== undefined && value !== "") {
      populated += 1;
    }
  }
  return populated;
}

// ---------------------------------------------------------------------------
// Main. Every path exits 0.
// ---------------------------------------------------------------------------
const input = readInput();
const sessionId = (input.session_id ?? "").trim() || "(unknown session)";
const pack = readPack();
const sections = countSections(pack);

if (sections > 0) {
  // HEALTHY — say nothing. See "why the marker must not always fire".
  process.exit(0);
}

const reason =
  pack === null
    ? "no canon pack was observable for this session"
    : "the canon pack arrived with ZERO populated sections";

console.error(
  [
    "⚠️ HYDRATION MARKER — this session started WITHOUT canon.",
    "",
    `  session: ${sessionId}`,
    `  reason:  ${reason}`,
    "",
    "Canon is who Rico is, the rules, and this repo's facts — the context that",
    "is meant to load automatically. A session missing it will confidently",
    "re-derive things it was supposed to already know, and the expensive part",
    "is that it looks exactly like a session that did know them.",
    "",
    "This is a MARKER, not a block: the session continues normally (operator",
    "ruling 2026-08-08, ledger item 24 — a hydration block could only ever fire",
    "during an outage, punishing a session that skipped nothing).",
    "",
    "Recover the context explicitly before relying on canon:",
    "",
    "    python3 _ob/skills/brain/scripts/resume.py",
    "",
    `Marker: ${HOOK_NAME} (issue #451).`,
  ].join("\n"),
);

process.exit(0);
