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

  // --- tree search must not be the first move (2026-07-29) ---------------
  // The operator hardened the `grep` denial and an agent used `Grep` with a
  // capital G. Ban a spelling, the next spelling wins. These pin the ACT.
  {
    name: "SPELLING: capital-G Grep tool blocks like grep does",
    lookups: [],
    mutation: { tool: "Grep", input: { pattern: "terra" } },
    blocked: true,
  },
  {
    name: "SPELLING: rg blocks as the first move",
    lookups: [],
    mutation: bash('rg -l "terra" /Volumes/collab'),
    blocked: true,
  },
  {
    name: "SPELLING: a readdir walker script blocks too",
    lookups: [],
    mutation: bash('bun -e "readdirSync(dir).forEach(f => ...)"'),
    blocked: true,
  },
  {
    name: "an index lookup unlocks rg for the literal token",
    lookups: [bash('aqmd search "terra"')],
    mutation: bash('rg -l "terra" /Volumes/collab'),
    blocked: false,
  },
  {
    name: "aqmd itself is never treated as a tree search",
    lookups: [],
    mutation: bash('aqmd search "bake-off"'),
    blocked: false,
  },
  {
    name: "grep in a pipe filters output, not the tree",
    lookups: [],
    mutation: bash("ps aux | grep postgres"),
    blocked: false,
  },

  // --- asking the operator is a mutation of his time (2026-07-29) --------
  {
    name: "AskUserQuestion without a lookup blocks",
    lookups: [],
    mutation: { tool: "AskUserQuestion", input: { questions: [] } },
    blocked: true,
  },

  // --- the shared volume is not scratch (2026-07-29) --------------------
  // 37 files from this repo were archived out of /Volumes/collab's root. No
  // lookup exempts these: it is a boundary, not a research question.
  {
    name: "COLLAB: Write to the shared volume blocks",
    lookups: [bash('aqmd search "bakeoff"')],
    mutation: {
      tool: "Write",
      input: { file_path: "/Volumes/collab/out.json" },
    },
    blocked: true,
  },
  {
    name: "COLLAB: /mnt spelling blocks the same",
    lookups: [bash('aqmd search "bakeoff"')],
    mutation: { tool: "Write", input: { file_path: "/mnt/collab/out.json" } },
    blocked: true,
  },
  {
    name: "COLLAB: redirect into the share blocks",
    lookups: [bash('aqmd search "bakeoff"')],
    mutation: bash('psql -c "select 1" > /Volumes/collab/probe.log'),
    blocked: true,
  },
  {
    name: "COLLAB: Bun.write into the share blocks",
    lookups: [bash('aqmd search "bakeoff"')],
    mutation: bash("bun -e 'Bun.write(\"/Volumes/collab/x.json\", d)'"),
    blocked: true,
  },
  {
    name: "COLLAB: reading the share is allowed",
    lookups: [],
    mutation: bash("ls -la /Volumes/collab/"),
    blocked: false,
  },
  {
    name: "COLLAB: writing a review is still allowed",
    lookups: [bash('aqmd search "reviews"')],
    mutation: {
      tool: "Write",
      input: { file_path: "/Volumes/collab/reviews/open-brain/PR123/notes.md" },
    },
    blocked: false,
  },
  {
    name: "COLLAB: the repo scratch bucket is allowed",
    lookups: [bash('aqmd search "items"')],
    mutation: {
      tool: "Write",
      input: {
        file_path: "/Volumes/ThunderBolt/_tmp/open-brain/_scratch/items.json",
      },
    },
    blocked: false,
  },

  // --- never cap remembered content (2026-07-30) -------------------------
  // Three self-inflicted truncations in one day, all silent. The worst turned
  // into a false claim to the operator about what the DATABASE stores.
  {
    name: "CAP: reintroducing resume.py's [:200] blocks",
    lookups: [bash('aqmd search "resume"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path:
          "/Volumes/ThunderBolt/Development/_ob/skills/brain/scripts/resume.py",
        new_string: 'body = (event.get("content") or "")[:200]',
      },
    },
    blocked: true,
  },
  {
    name: "CAP: a 500-char slice on a lane read blocks",
    lookups: [bash('aqmd search "provider"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path:
          "/Volumes/ThunderBolt/Development/_ob/scripts/ob-memory-provider.ts",
        new_string: "return value.trim().slice(0, 500);",
      },
    },
    blocked: true,
  },
  {
    name: "CAP: a Zod ceiling on turn content blocks",
    lookups: [bash('aqmd search "ingest"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path: "src/tools/ingest-raw-turn.ts",
        new_string: "content: z.string().max(200000),",
      },
    },
    blocked: true,
  },
  {
    name: "CAP: naming a MAX_*_CHARS constant into existence blocks",
    lookups: [bash('aqmd search "capture"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path: "src/tools/turn-capture.ts",
        new_string: "const MAX_CONTENT_CHARS = 200_000;",
      },
    },
    blocked: true,
  },
  {
    name: "CAP: REMOVING a cap is the fix, never blocked",
    lookups: [bash('aqmd search "resume"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path:
          "/Volumes/ThunderBolt/Development/_ob/skills/brain/scripts/resume.py",
        new_string: 'body = " ".join((event.get("content") or "").split())',
      },
    },
    blocked: false,
  },
  {
    name: "CAP: a uuid/hash prefix is an identifier, not content",
    lookups: [bash('aqmd search "lane-load"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path: "src/tools/lane-load.ts",
        new_string: "const short = turn_uuid.slice(0, 12);",
      },
    },
    blocked: false,
  },
  {
    name: "CAP: a cap outside the memory surface is not this gate's business",
    lookups: [bash('aqmd search "render-html-report"')],
    mutation: {
      tool: "Edit",
      input: {
        file_path: "scripts/render-html-report.ts",
        new_string: "const label = title.slice(0, 80);",
      },
    },
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
