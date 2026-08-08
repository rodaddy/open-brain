#!/usr/bin/env bun
/**
 * ===========================================================================
 * RETIRED 2026-08-08 — NOT REGISTERED, NOT RUNNING. DO NOT RE-REGISTER.
 * ===========================================================================
 * Ruling: operator, 2026-08-08, ledger item 25 (`docs/issue-graph.md`), which
 * AMENDS item 24. This gate fired live exactly once and wedged the pipeline:
 * it blocked the controller's merge of PR #645, and structurally blocked the
 * merge of any fix for itself.
 *
 * Two reasons it is retired rather than repaired:
 *
 *   1. Its live defects were the same gaps PR #642 had disclosed as PROPOSED —
 *      the receipt probe hit a nonexistent endpoint (HTML 404), the provider
 *      scope-proof demanded a key it simultaneously rejected, and the drain
 *      step could not import openbrain_memory in the hook interpreter (#646).
 *      #646 is fixed regardless: a tool demanding a key it rejects is a defect
 *      with or without a consumer.
 *   2. The reason that actually decided it — raw capture is AUTOMATIC (Stop
 *      hooks -> watermark -> durable spool, running regardless of any gate),
 *      and distilling raw sessions into durable memory is the DREAM pipeline's
 *      designed job (`docs/dream-design.md`). So this gate was hard-blocking
 *      merges to force HAND distillation of something the architecture intends
 *      to automate. Enforcing a manual duplicate of a designed automatic step
 *      is backwards.
 *
 * WHAT REPLACES IT: an automatic-capture LIVENESS check (#647), built on the
 * #625 pattern — prove the raw capture lane DELIVERED for recent sessions and
 * be loud on silence. The real risk is the automatic lane dying quietly, not
 * an agent skipping a hand-written receipt.
 *
 * WHY THE FILE IS KEPT: the server-side receipt probe, the drain step, and the
 * outage-vs-skip discrimination below are prior art for #647, which has to
 * answer the same question ("did capture deliver for this session?") without
 * the block. Deleting it would make that lane rediscover it. Retirement is
 * enforced by `scripts/done-means/648-capture-gate-retired.sh`.
 *
 * Everything below this header describes the gate AS IT WAS and is retained
 * verbatim as the record of the design; the KEPT tiers of item 24 are
 * hydration (`.claude/hooks/hydration-stamp.ts`) and recall telemetry.
 * ===========================================================================
 *
 * capture-gate — repo-local hard gate on `gh pr merge` requiring a SERVER-SIDE
 * capture receipt for the current session.
 *
 * ---------------------------------------------------------------------------
 * THE RULING THIS IMPLEMENTS
 * ---------------------------------------------------------------------------
 * Issue #451 asked where the hard edges of "unskippable memory calls" belong.
 * Operator ruling 2026-08-08 (ledger item 24, docs/issue-graph.md): TIERED
 * ALL-THREE. This file is the CAPTURE tier — the only one of the three that is
 * a hard gate:
 *
 *   CAPTURE   HARD GATE at merge. A server-side receipt must exist. (this file)
 *   HYDRATION VERIFY + STAMP, never a block.  (.claude/hooks/hydration-stamp.ts)
 *   RECALL    MEASURE into existing telemetry. (apps/hooks/post_tool_use.py)
 *
 * It is deliberately the same SHAPE as `.claude/hooks/merge-gate.ts` and shares
 * its parser: the enforce layer holds no judgment, it compares values a service
 * returned. A gate that reasons can be reasoned with, and the session that
 * wants to merge is the one least suited to judging whether it may.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RECEIPT MUST COME FROM THE SERVER
 * ---------------------------------------------------------------------------
 * Operator ruling, verbatim: "server receipt is the proof; local state only a
 * cache — a local file is forgeable." A gate satisfied by writing a local file
 * is a gate the gated party can satisfy by writing a file, which is not a gate.
 * So the receipt is read with a `session_context` query against the live
 * service (server/tools/session-lifecycle.ts:109-183), scoped by the bearer
 * token, and nothing on local disk can substitute for it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DRAINS FIRST, AND WHY AN OUTAGE PASSES
 * ---------------------------------------------------------------------------
 * This is the operator's own refinement, and it is what makes the gate safe to
 * turn on. Capture ALREADY spools durably: during an outage the turn is
 * captured to disk and replayed when the service returns
 * (openbrain_memory/_runtime_spool.py, runtime.py:1018 `_drain_spool`,
 * apps/capture/outage.py). A session in an outage did nothing wrong, and its
 * memory is not lost — it is merely undelivered.
 *
 * So a missing receipt is not yet a verdict. The gate:
 *
 *   1. asks the server for a receipt        -> found?  PASS clean
 *   2. not found: attempts a spool DRAIN    -> delivered? re-ask; PASS clean
 *   3. service unreachable                  -> PASS **with a loud stamp**
 *   4. service up, drain produced nothing   -> REFUSE, naming the reason
 *
 * Only (4) is a skip, and only (4) blocks. (3) is what keeps (4) honest: a gate
 * that could not tell an outage from a skip would have to choose between
 * bricking every outage and never firing at all — and a gate that fires on
 * innocence teaches agents to route around it, which is this repo's standing
 * scar (#618, the guard that matched heredoc text and taxed every lane).
 *
 * The stamp is not a consolation prize. It is the record that keeps SKIP and
 * OUTAGE distinguishable permanently, so the operator reading the PR later can
 * see which one happened rather than inferring it from silence.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not touch the global ~/.claude lifecycle hooks, and it changes no
 * fail-open contract. The lifecycle hooks (session_start.py:41-43,
 * stop.py:16-19, session_end.py:23-27, post_tool_use.py:38-41) all promise
 * "ALWAYS EXIT 0 ... a hook that observes a session must never block or break
 * one", and that promise is untouched here: this gate governs a MERGE, an
 * action the agent chose, not a session boundary. A session that cannot start
 * is bricked; a merge that refuses until a receipt exists is recoverable. That
 * distinction is the whole reason the ruling put the hard edge here.
 *
 * MECHANISM
 *
 *   PreToolUse on Bash — parse the command; if it is `gh pr merge <n>`, resolve
 *   the receipt as above. Exit 2 blocks and hands stderr back to the model as
 *   the reason. Exit 0 allows.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  parseSimpleCommands,
  matchGhCommand,
  firstPositional,
} from "./lib/shell-command-parse.ts";

type HookInput = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
};

const HOOK_NAME = "capture-gate";

/** Flags of `gh pr merge` that take a SEPARATE value, so their value is never
 *  mistaken for the PR number. Mirrors merge-gate.ts. */
const MERGE_FLAGS_WITH_VALUES = new Set([
  "--body",
  "-b",
  "--body-file",
  "-F",
  "--subject",
  "-t",
  "--match-head-commit",
  "--author-email",
  "-A",
  "--repo",
  "-R",
]);

/**
 * Read the hook payload with a NON-BLOCKING read.
 *
 * `readFileSync(0)` returns whatever is buffered rather than waiting for the
 * writer to close, which is what `await Bun.stdin.text()` does. That await
 * wedged a session in this repo on 2026-07-28; see design-lookup-gate.ts
 * readInput() for the full account. Do not "modernise" this into an await.
 */
function readInput(): HookInput {
  try {
    const text = readFileSync(0, "utf8");
    return text.trim() ? (JSON.parse(text) as HookInput) : {};
  } catch {
    return {};
  }
}

function refuse(lines: string[]): never {
  console.error(lines.join("\n"));
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const input = readInput();

if ((input.tool_name ?? "") !== "Bash") process.exit(0);

const rawCommand =
  typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
if (!rawCommand.trim()) process.exit(0);

let prNumber: string | null = null;
for (const command of parseSimpleCommands(rawCommand)) {
  const matched = matchGhCommand(command, "pr", ["merge"]);
  if (!matched) continue;
  const positional = firstPositional(matched.rest, MERGE_FLAGS_WITH_VALUES);
  // The bare form is merge-gate.ts's business to refuse; refusing it twice
  // would give the model two different reasons for one problem. This gate only
  // evaluates a merge it can name a PR for.
  if (!positional) continue;
  if (!/^\d+$/.test(positional)) continue;
  prNumber = positional;
  break;
}

// Not a `gh pr merge <n>`: allow untouched. This includes every string literal
// and heredoc body that merely CONTAINS the phrase (#618) — the parser, not a
// substring match, is what makes that true.
if (!prNumber) process.exit(0);

const sessionId = (input.session_id ?? "").trim();
if (!sessionId) {
  refuse([
    `BLOCKED by ${HOOK_NAME}: the hook payload carries no session_id.`,
    "",
    "A capture receipt is per-session, so without a session id there is nothing",
    "to look up. Refusing rather than guessing, and rather than silently",
    "allowing (AGENTS.md, no silent adjustments) — an unreadable payload must",
    "not be the way enforcement turns itself off.",
  ]);
}

const baseUrl = (process.env.OPENBRAIN_BASE_URL ?? "").trim().replace(/\/+$/, "");
const token = (process.env.OPENBRAIN_TOKEN ?? "").trim();

if (!baseUrl || !token) {
  const missing = [
    !baseUrl ? "OPENBRAIN_BASE_URL" : null,
    !token ? "OPENBRAIN_TOKEN" : null,
  ].filter(Boolean).join(", ");
  refuse([
    `BLOCKED by ${HOOK_NAME}: no Open Brain coordinates (${missing} unset).`,
    "",
    "This is UNCONFIGURED, which is not the same as an outage and is not",
    "treated like one: an outage is a service that should answer and does not,",
    "while this is a gate that was never pointed at a service. Passing here",
    "would mean the gate silently does nothing on any machine that forgot to",
    "set the variables — enforcement that evaporates exactly where it is",
    "needed.",
    "",
    "Satisfy it by sourcing the provider env, e.g.:",
    "",
    "    set -a; . ~/.local/share/openbrain-memory/env/claudex-observation.env; set +a",
  ]);
}

/**
 * Outcome of one attempt to read a receipt from the SERVER.
 *
 * `reachable` is the field the whole tier turns on: it separates "the service
 * said there is no receipt" (a skip) from "the service did not say anything"
 * (an outage). Collapsing those two into a single boolean is precisely the
 * mistake the drain-first design exists to prevent.
 */
type ReceiptLookup = {
  reachable: boolean;
  receiptCount: number;
  detail: string;
};

/**
 * Ask the live service whether this session has any captured events.
 *
 * Uses `session_context` (server/tools/session-lifecycle.ts:109) because it is
 * the read-only, namespace-scoped view of a session's events; the namespace is
 * derived from the bearer token server-side, so this gate cannot widen its own
 * scope by asking nicely.
 */
function lookupReceipt(): ReceiptLookup {
  const response = spawnSync(
    "curl",
    [
      "-sS",
      "--max-time",
      "10",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-X",
      "POST",
      "--data-binary",
      JSON.stringify({
        tool: "session_context",
        arguments: { session_key: sessionId, include_events: true, event_limit: 1 },
      }),
      `${baseUrl}/tools/session_context`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  if (response.error || response.status !== 0) {
    return {
      reachable: false,
      receiptCount: 0,
      detail: response.error
        ? response.error.message
        : `curl exited ${response.status}: ${String(response.stderr ?? "").trim()}`,
    };
  }

  const raw = String(response.stdout ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Reachable but unintelligible. This is NOT an outage — something answered
    // — so it must not take the outage path and earn a free pass.
    return {
      reachable: true,
      receiptCount: 0,
      detail: `service answered with non-JSON (${raw.slice(0, 120)})`,
    };
  }

  const count = countEvents(parsed);
  return {
    reachable: true,
    receiptCount: count,
    detail: count > 0 ? `${count} captured event(s) for this session` : "0 captured events",
  };
}

/**
 * Count the session's events out of a `session_context` reply.
 *
 * The reply may arrive either as the tool's own JSON or wrapped in an MCP
 * text-content envelope, so both are read. Anything unrecognised counts ZERO
 * rather than throwing: a shape this cannot read is a missing receipt, never an
 * accidental pass.
 */
function countEvents(payload: unknown): number {
  const direct = readEventCount(payload);
  if (direct !== null) return direct;

  // MCP envelope: { content: [{ type: "text", text: "<json>" }] }
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        if (typeof text !== "string") continue;
        try {
          const inner = readEventCount(JSON.parse(text));
          if (inner !== null) return inner;
        } catch {
          continue;
        }
      }
    }
  }
  return 0;
}

function readEventCount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { events?: unknown; event_count?: unknown };
  if (Array.isArray(record.events)) return record.events.length;
  if (typeof record.event_count === "number") return record.event_count;
  return null;
}

/**
 * Attempt a spool drain, reusing the runtime's own replay path.
 *
 * NEVER a reimplementation. `drain_spool_now` (runtime.py:573) is documented as
 * reusing `_drain_spool` unchanged so that exact-scope replay, quarantine
 * semantics, and namespace provenance stay identical to the automatic path — a
 * second drain implementation here would be a second set of those invariants to
 * keep in sync, and they would diverge.
 *
 * Returns true only when the drain reports having delivered something. A drain
 * that cannot run at all is not an error here: the receipt re-check is what
 * decides, and a failed drain simply leaves the receipt absent.
 */
function attemptDrain(): { ran: boolean; detail: string } {
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json,sys",
        "try:",
        "    from openbrain_memory.runtime import FirstClassMemoryRuntime",
        "except Exception as exc:",
        "    print(json.dumps({'ran': False, 'detail': f'runtime unavailable: {exc}'}))",
        "    sys.exit(0)",
        "try:",
        "    runtime = FirstClassMemoryRuntime()",
        "    report = runtime.drain_spool_now()",
        "except Exception as exc:",
        "    print(json.dumps({'ran': False, 'detail': f'drain failed: {exc}'}))",
        "    sys.exit(0)",
        "if report is None:",
        "    print(json.dumps({'ran': True, 'detail': 'nothing pending in the spool'}))",
        "else:",
        "    print(json.dumps({'ran': True, 'detail': f'drain report: {report!r}'[:300]}))",
      ].join("\n"),
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  if (result.error || result.status !== 0) {
    return {
      ran: false,
      detail: result.error ? result.error.message : `python3 exited ${result.status}`,
    };
  }
  try {
    const parsed = JSON.parse(String(result.stdout ?? "").trim()) as {
      ran?: boolean;
      detail?: string;
    };
    return { ran: Boolean(parsed.ran), detail: String(parsed.detail ?? "") };
  } catch {
    return { ran: false, detail: "drain produced unreadable output" };
  }
}

/**
 * Post the outage stamp so the degradation is visible AFTER the fact.
 *
 * Best-effort by design: if the stamp cannot be posted the merge still
 * proceeds, because the outage path's contract is "never block". The stamp is
 * also written to stdout, so the transcript carries it even when `gh` fails —
 * a stamp that exists only on GitHub would vanish exactly when GitHub is the
 * thing that is unreachable.
 */
function stampOutage(pr: string, session: string, detail: string): void {
  const message = [
    `⚠️ CAPTURE OUTAGE — merged without a server-side capture receipt.`,
    "",
    `  session: ${session}`,
    `  reason:  Open Brain was unreachable when this merge was gated`,
    `  detail:  ${detail}`,
    "",
    "This is a PASS, recorded loudly rather than absorbed silently. Capture",
    "spools durably (openbrain_memory/_runtime_spool.py), so this session's",
    "memory is written to disk and replays when the service returns — it is",
    "undelivered, not lost.",
    "",
    "It is stamped so an outage stays distinguishable from a SKIP forever.",
    `Gate: ${HOOK_NAME} (issue #451, ledger item 24).`,
  ].join("\n");

  console.log(message);

  const posted = spawnSync("gh", ["pr", "comment", pr, "--body", message], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (posted.error || posted.status !== 0) {
    console.log(
      `${HOOK_NAME}: could not post the outage stamp to PR #${pr} ` +
        `(${posted.error ? posted.error.message : `gh exited ${posted.status}`}); ` +
        `the stamp above is still in the transcript.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Resolve: receipt -> drain -> receipt -> (outage | skip)
// ---------------------------------------------------------------------------
const first = lookupReceipt();

if (first.reachable && first.receiptCount > 0) {
  console.log(
    [
      `${HOOK_NAME}: PR #${prNumber} may merge.`,
      `  capture receipt: ${first.detail} (session ${sessionId})`,
    ].join("\n"),
  );
  process.exit(0);
}

if (!first.reachable) {
  // OUTAGE PATH — pass, loudly. Never a block.
  stampOutage(prNumber, sessionId, first.detail);
  process.exit(0);
}

// Service is UP and says there is no receipt. Before calling that a skip, drain
// the spool: an undelivered capture is not an absent one.
const drain = attemptDrain();
const second = lookupReceipt();

if (second.reachable && second.receiptCount > 0) {
  console.log(
    [
      `${HOOK_NAME}: PR #${prNumber} may merge.`,
      `  capture receipt appeared after a spool drain: ${second.detail}`,
      `  drain: ${drain.detail}`,
      `  (session ${sessionId})`,
    ].join("\n"),
  );
  process.exit(0);
}

if (!second.reachable) {
  // The service went away between the two reads. Treat as an outage, which is
  // what it is — the drain-first design's job is to never call an outage a skip.
  stampOutage(prNumber, sessionId, second.detail);
  process.exit(0);
}

// SKIP — the only blocking path. The service answered, twice, and a drain
// produced nothing to deliver.
refuse([
  `BLOCKED by ${HOOK_NAME}: no capture receipt for this session.`,
  "",
  `  session:      ${sessionId}`,
  `  service:      ${baseUrl} — REACHABLE (this is not an outage)`,
  `  receipt:      ${second.detail}`,
  `  spool drain:  ${drain.detail}`,
  "",
  "The capture tier of issue #451 is a HARD GATE (operator ruling 2026-08-08,",
  "ledger item 24): a merge requires a SERVER-SIDE capture receipt for the",
  "session doing the merging. The server receipt is the proof; local state is",
  "only a cache, because a local file is forgeable.",
  "",
  "This is a SKIP, not an outage, and the difference is why this refuses. The",
  "service answered — twice — and a spool drain found nothing undelivered. An",
  "outage would have passed here with a visible stamp; nothing was captured at",
  "all.",
  "",
  "Satisfy it by capturing this session's durable learning before merging —",
  "the distilled in-flight event the work actually produced:",
  "",
  "    openbrain-memory --event capture",
  "",
  "then re-run the merge. A capture that reaches the spool but not the service",
  "also satisfies this gate once the drain delivers it.",
]);
