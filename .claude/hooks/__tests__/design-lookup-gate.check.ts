#!/usr/bin/env bun
/**
 * Functional check for design-lookup-gate's relevance test.
 *
 * NOT part of `bun test`: it drives the hook as a subprocess over stdin/exit
 * code, which is the real contract Claude Code uses, and it touches the gate's
 * live state path. `.check.ts` keeps it out of the default suite.
 *
 *   bun run .claude/hooks/__tests__/design-lookup-gate.check.ts
 *
 * The case that matters is REGRESSION: the exact 2026-07-28 sequence -- an
 * unrelated aqmd, then an edit to src/distiller.ts -- must now block. Under the
 * count-only gate it passed, and that pass cost an hour of rediscovering the
 * decomposition design already written down in #192/#247.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const GATE = join(import.meta.dir, "..", "design-lookup-gate.ts");
const STATE = join(
  homedir(),
  ".local",
  "state",
  "open-brain-design-gate",
  "state.json",
);

// The gate's own state file is what this drives, so it is saved and restored:
// this runs inside a live session whose real lookup history must survive.
const saved = existsSync(STATE) ? readFileSync(STATE, "utf8") : null;
function restore(): void {
  if (saved !== null) writeFileSync(STATE, saved);
  else if (existsSync(STATE)) rmSync(STATE);
}

type Call = { tool: string; input: Record<string, unknown> };

async function fire(
  event: "post-tool-use" | "pre-tool-use",
  session: string,
  call: Call,
): Promise<number> {
  const proc = Bun.spawn(["bun", "run", GATE, "--event", event], {
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: session,
        cwd: "/Volumes/ThunderBolt/Development/open-brain",
        tool_name: call.tool,
        tool_input: call.input,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  return await proc.exited;
}

const bash = (command: string): Call => ({ tool: "Bash", input: { command } });
const edit = (file_path: string): Call => ({
  tool: "Edit",
  input: { file_path },
});
const read = (file_path: string): Call => ({
  tool: "Read",
  input: { file_path },
});

const cases: Array<{
  name: string;
  lookups: Call[];
  mutation: Call;
  blocked: boolean;
}> = [
  {
    name: "REGRESSION: unrelated lookup then distiller edit",
    lookups: [bash('aqmd "is there frontend precedent in the fleet"')],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/distiller.ts",
    ),
    blocked: true,
  },
  {
    name: "relevant lookup unlocks the file it was about",
    lookups: [bash('aqmd search "distiller"')],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/distiller.ts",
    ),
    blocked: false,
  },
  {
    name: "no lookup at all blocks",
    lookups: [],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/distiller.ts",
    ),
    blocked: true,
  },
  {
    name: "camelCase lookup matches kebab-case file",
    lookups: [bash('aqmd "how does distillExchange build a candidate"')],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/distill-exchange.ts",
    ),
    blocked: false,
  },
  {
    name: "generic path tokens alone do not match",
    lookups: [bash('aqmd "what lives in src"')],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/embedding.ts",
    ),
    blocked: true,
  },
  {
    name: "design doc Read counts as a lookup for its subject",
    lookups: [read("docs/decisions/capture-never-drops-a-turn.md")],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/capture.ts",
    ),
    blocked: false,
  },
  {
    name: "two subjects stay unlocked at once",
    lookups: [bash('aqmd search "chunking"'), bash('aqmd search "distiller"')],
    mutation: edit(
      "/Volumes/ThunderBolt/Development/open-brain/src/chunking.ts",
    ),
    blocked: false,
  },
  {
    name: "non-mutating tool is never blocked",
    lookups: [],
    mutation: read("src/distiller.ts"),
    blocked: false,
  },
  {
    name: "mutating bash needs a relevant lookup",
    lookups: [bash('aqmd "frontend precedent"')],
    mutation: bash("git commit -m 'change the distiller'"),
    blocked: true,
  },
  {
    name: "non-mutating bash is never blocked",
    lookups: [],
    mutation: bash("git status"),
    blocked: false,
  },
];

let pass = 0;
let fail = 0;

for (const [index, testCase] of cases.entries()) {
  const session = `gate-check-${index}`;
  for (const lookup of testCase.lookups) {
    await fire("post-tool-use", session, lookup);
  }
  const code = await fire("pre-tool-use", session, testCase.mutation);
  const blocked = code === 2;
  const ok = blocked === testCase.blocked;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${testCase.name.padEnd(52)} -> ${
      blocked ? "BLOCKED" : "allowed"
    }`,
  );
  ok ? pass++ : fail++;
}

restore();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
