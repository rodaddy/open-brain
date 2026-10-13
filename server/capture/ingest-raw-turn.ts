/**
 * The harness-noise predicate for captured conversation turns.
 *
 * This file owns `isHarnessNoise` and nothing else. It once also carried a
 * second MCP registrar for the tool name `ingest_raw_turn`, duplicating the
 * live one; issue 1212 dropped that registrar and everything only it reached.
 * The ingest tool lives at `server/tools/ingest-raw-turn.ts`, which is what
 * `server/tools/index.ts` wires.
 *
 * Original context (Issue #380, INGEST-1; spec:
 * docs/full-send-derivation-spec.md section 2): the client is a DUMB PIPE. It
 * ships what happened and decides nothing about salience. Every judgment
 * (distillation, dedupe, supersession) is server-side, asynchronous, and
 * re-runnable, because only the server runs when no session is open, sees the
 * whole corpus, survives a client crash, and serves Claude/Codex/Python from
 * one implementation instead of three divergent client heuristics.
 */

/**
 * Harness control strings that are not dialogue and must never be ingested.
 *
 * This is a SHAPE filter on runtime scaffolding, NOT a salience judgment: it
 * does not ask whether a turn is worth remembering, only whether it is a turn
 * at all. Measured across 515 transcripts on 2026-07-25 -- "[Request
 * interrupted by user]" appears 270 times across 51 sessions, "[Request
 * interrupted by user for tool use]" 103 times across 33. Storing those is
 * pure noise: identical strings, no author, no decision, and they would
 * dominate any exact-content analysis.
 */
const HARNESS_NOISE: readonly RegExp[] = [
  /^\[Request interrupted by user[^\]]*\]$/,
  /^<local-command-(?:caveat|stdout|stderr)>/,
  /^<command-(?:name|message|args)>/,
  /^<bash-(?:input|stdout|stderr)>/,
  /^Continue from where you left off\.$/,
  /^The user doesn't want to proceed with this tool use\./,
];

export function isHarnessNoise(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  return HARNESS_NOISE.some((pattern) => pattern.test(trimmed));
}
