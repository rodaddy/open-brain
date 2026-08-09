#!/usr/bin/env bun
/**
 * The clause-(f) mutation for the #678 done-means check: remove the
 * `continue_from` block from the `agent_context_pack` entry of the contract
 * mirror, so the parity test can be shown to FAIL when the mirror drifts.
 *
 * A FILE rather than an inline `bun -e` string, deliberately. Under `bun -e`
 * the first user argument lands at `process.argv[1]`, not `[2]`; an inline
 * version reading `[2]` received `undefined`, threw inside `readFileSync`, and
 * left the mirror untouched while the surrounding check carried on. The
 * "mutated" parity run then passed for the most boring possible reason — there
 * was no mutation — which is a false GREEN for the one clause whose entire job
 * is to prove the prover. Keeping this in a file makes the argument contract
 * ordinary and the failure loud.
 *
 * Contract with the caller: exit non-zero on any failure to mutate, and print
 * `MUTATION-APPLIED` on success. The caller checks the exit code, the marker,
 * AND that the file changed — three gates, because the exit code alone was
 * already proven insufficient once.
 */

import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("MUTATION-FAILED: no target path argument");
  process.exit(1);
}

const src = readFileSync(path, "utf8");

const START_MARKER = "  agent_context_pack: {";
const END_MARKER = "  agent_reflex_pointers: {";

const start = src.indexOf(START_MARKER);
if (start < 0) {
  console.error(`MUTATION-FAILED: start marker not found: ${START_MARKER}`);
  process.exit(1);
}
// Round 25: gate the END marker on having found the START, and search FORWARD
// from it — an end pattern that can match earlier than the start silently
// yields an empty or inverted slice.
const end = src.indexOf(END_MARKER, start + START_MARKER.length);
if (end < 0) {
  console.error(`MUTATION-FAILED: end marker not found after start: ${END_MARKER}`);
  process.exit(1);
}

const entry = src.slice(start, end);
const mutatedEntry = entry.replace(
  /\n      continue_from: \{[\s\S]*?\n      \},/,
  "",
);
if (mutatedEntry === entry) {
  console.error(
    "MUTATION-FAILED: the continue_from block was not matched inside the agent_context_pack entry",
  );
  process.exit(1);
}

writeFileSync(path, src.slice(0, start) + mutatedEntry + src.slice(end));
console.log(
  `MUTATION-APPLIED: continue_from removed from the agent_context_pack mirror entry (${entry.length - mutatedEntry.length} bytes)`,
);
