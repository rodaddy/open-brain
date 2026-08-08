#!/usr/bin/env bun
/**
 * Driver for scripts/done-means/637-gate-precision.sh.
 *
 * Fires `.claude/hooks/design-lookup-gate.ts` once per fixture with a
 * PreToolUse payload on stdin — the same contract Claude Code uses — and
 * asserts the verdict.
 *
 * WHY A SEPARATE DRIVER. The fixture payloads are multi-line JSON containing
 * quotes, heredoc-ish prose, and shell metacharacters. Round-tripping them
 * through bash to build stdin is where the quoting bugs live; Bun reads the
 * JSON and writes the payload directly, so what the hook sees is exactly what
 * the fixture says.
 *
 * VERDICT PRECISION. A true positive must be refused by one of the clauses
 * that enforce the standing no-size-reduction rule, NOT by whatever clause
 * happens to fire first. The refusal text is asserted against the unrelated
 * clauses so a refusal from relevance, the collab boundary, or tree-search
 * cannot bank a false pass. Without that assertion a hook that refused
 * everything would score a perfect true-positive run — the exact false green
 * this repo's SME knowledge warns about for gates observed in one direction
 * only.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Fixture = {
  id: string;
  why: string;
  tool: string;
  input: Record<string, unknown>;
};

function argOf(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    console.error(`HARNESS-ERROR: missing required argument ${name}`);
    process.exit(3);
  }
  return value;
}

const HOOK = argOf("--hook");
const FP_PATH = argOf("--false-positives");
const TP_PATH = argOf("--true-positives");

const STATE = join(
  homedir(),
  ".local",
  "state",
  "open-brain-design-gate",
  "state.json",
);

/**
 * The gate's state file belongs to the LIVE session running this check. Save
 * it, and restore it no matter how this exits — including on a throw.
 */
const savedState = existsSync(STATE) ? readFileSync(STATE, "utf8") : null;
function restoreState(): void {
  try {
    if (savedState !== null) writeFileSync(STATE, savedState);
    else if (existsSync(STATE)) rmSync(STATE);
  } catch {
    console.error(
      "WARNING: could not restore the gate state file; the live session's lookup history may be reset.",
    );
  }
}

/**
 * Banners of the two clauses that enforce the standing no-size-reduction rule.
 * Exported by the hook itself so there is exactly one copy of each string and
 * a reworded refusal cannot silently stop matching here.
 *
 * A true-positive fixture must be refused by ONE OF THESE — not by the
 * relevance clause, not by the collab boundary, not by the tree-search clause.
 *
 * WHY BOTH COUNT. The first cut of this driver asserted only the prose-wall
 * banner, and the RED run duly showed seven true positives refused "by the
 * WRONG clause" — when in fact the memory-surface clause had refused them
 * correctly and for exactly the right reason. Satisfying that assertion would
 * have meant weakening the memory-surface clause so the other could claim the
 * refusal: a fix aimed at a layer that was never broken, which is the failure
 * mode docs/lane-contract.md round 6 records. What this corpus measures is
 * that the standing rule still bites, never which tooth does the biting.
 */
/**
 * The banners are DERIVED FROM THE HOOK'S OWN SOURCE rather than retyped here.
 * A second copy would be identical on the day it was written and would drift
 * afterwards — reword a refusal, and a stale assertion silently stops matching
 * while the corpus still scores green. That is the
 * `sme.duplicated_selection_lists_diverge` pattern, and a checker that measures
 * nothing while reporting success is the worst outcome available here.
 *
 * Both banners open with this stable prefix, which is the hook's refusal
 * signature; the specific wording after it is free to change.
 */
const REFUSAL_SIGNATURE = "BLOCKED by design-lookup-gate:";

/**
 * Refusal reasons that are NOT the standing-rule clauses. A true positive
 * refused by one of these was refused for the wrong reason and must not count.
 */
const UNRELATED_CLAUSES = [
  "requires a design lookup first",
  "search the index before walking the tree",
  "does not write to /Volumes/collab",
];

function refusedByAnEnforcementClause(stderr: string): boolean {
  if (!stderr.includes(REFUSAL_SIGNATURE)) return false;
  return !UNRELATED_CLAUSES.some((reason) => stderr.includes(reason));
}

type Verdict = { exit: number; stderr: string };

async function fire(
  event: "post-tool-use" | "pre-tool-use",
  session: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<Verdict> {
  const proc = Bun.spawn(["bun", HOOK, "--event", event], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: session,
        cwd: "/Volumes/ThunderBolt/Development/open-brain",
        hook_event_name: event === "pre-tool-use" ? "PreToolUse" : "PostToolUse",
        tool_name: tool,
        tool_input: input,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { exit, stderr };
}

/**
 * Pre-seed a lookup that covers the fixture's subject, so the RELEVANCE clause
 * — a separate, working feature that #637 does not touch — is never what
 * decides a verdict here. The seed is built from the fixture's own target so
 * it shares subject tokens with it.
 */
async function seedCoveringLookup(
  session: string,
  fixture: Fixture,
): Promise<void> {
  const target = String(
    fixture.input.file_path ??
      fixture.input.notebook_path ??
      fixture.input.command ??
      JSON.stringify(fixture.input.questions ?? ""),
  );
  const subject = target
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 40)
    .join(" ");
  await fire("post-tool-use", session, "Bash", {
    command: `aqmd search "${subject.replace(/"/g, "")}"`,
  });
}

function loadFixtures(path: string): Fixture[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Fixture[];
  } catch (error) {
    console.error(`HARNESS-ERROR: could not parse ${path}: ${String(error)}`);
    process.exit(3);
  }
}

const falsePositives = loadFixtures(FP_PATH);
const truePositives = loadFixtures(TP_PATH);

let failures = 0;
let passes = 0;

function report(id: string, status: "PASS" | "FAIL", evidence: string): void {
  console.log(`  ${status}  ${id.padEnd(44)} ${evidence}`);
  if (status === "PASS") passes += 1;
  else failures += 1;
}

// ---------------------------------------------------------------------------
// FALSE POSITIVES — every one must be ALLOWED.
// ---------------------------------------------------------------------------
console.log(
  "FALSE-POSITIVE CORPUS (recorded taxes — each MUST be allowed):",
);
for (const [index, fixture] of falsePositives.entries()) {
  const session = `637-fp-${index}-${process.pid}`;
  await seedCoveringLookup(session, fixture);
  const verdict = await fire("pre-tool-use", session, fixture.tool, fixture.input);
  if (verdict.exit === 0) {
    report(fixture.id, "PASS", "allowed (exit=0)");
  } else {
    const firstLine = verdict.stderr.split("\n").find((l) => l.trim()) ?? "";
    report(
      fixture.id,
      "FAIL",
      `BLOCKED (exit=${verdict.exit}) — ${firstLine.slice(0, 120)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// TRUE POSITIVES — every one must be BLOCKED, by the cap wall specifically.
// ---------------------------------------------------------------------------
console.log(
  "\nTRUE-POSITIVE CORPUS (agent-voice reduction proposals — each MUST be refused by an enforcement clause):",
);
for (const [index, fixture] of truePositives.entries()) {
  const session = `637-tp-${index}-${process.pid}`;
  await seedCoveringLookup(session, fixture);
  const verdict = await fire("pre-tool-use", session, fixture.tool, fixture.input);
  if (verdict.exit !== 2) {
    report(
      fixture.id,
      "FAIL",
      `NOT BLOCKED (exit=${verdict.exit}) — the wall's teeth weakened`,
    );
  } else if (!refusedByAnEnforcementClause(verdict.stderr)) {
    const firstLine = verdict.stderr.split("\n").find((l) => l.trim()) ?? "";
    report(
      fixture.id,
      "FAIL",
      `refused by the WRONG clause — ${firstLine.slice(0, 120)}`,
    );
  } else {
    report(fixture.id, "PASS", "refused by an enforcement clause (exit=2)");
  }
}

restoreState();

console.log(`\n${passes} pass, ${failures} fail`);
if (failures > 0) {
  console.log(
    "\nA false-positive FAIL is the #637 tax still being charged.\n" +
      "A true-positive FAIL means the no-size-reduction rule's teeth weakened — " +
      "that is a harder failure than the tax, and is never an acceptable trade.",
  );
}
process.exit(failures > 0 ? 1 : 0);
