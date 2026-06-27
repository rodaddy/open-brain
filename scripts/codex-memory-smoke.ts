#!/usr/bin/env bun

type SmokeStep = {
  name: string;
  tool: string;
  params: Record<string, unknown>;
  expectOutput?: string[];
};

const writeEnabled = process.env.OPEN_BRAIN_CODEX_SMOKE_WRITE === "1";
const sessionKey =
  process.env.OPEN_BRAIN_CODEX_SMOKE_SESSION_KEY ??
  `codex-smoke-${new Date().toISOString().slice(0, 10)}`;
const branch = process.env.OPEN_BRAIN_CODEX_SMOKE_BRANCH ?? "unknown";
const dirtyState = process.env.OPEN_BRAIN_CODEX_SMOKE_DIRTY_STATE ?? "unknown";

const steps: SmokeStep[] = [
  {
    name: "start or resume lane",
    tool: "session_start",
    params: {
      session_key: sessionKey,
      project: "open-brain",
      agent: "codex-smoke",
      topic: "Codex durable memory smoke flow",
    },
  },
  {
    name: "refresh lane context",
    tool: "lane_upsert",
    params: {
      session_key: sessionKey,
      project: "open-brain",
      agent: "codex-smoke",
      source: "scripts/codex-memory-smoke.ts",
      topic: "Codex durable memory smoke flow",
      current_context_md: [
        "## Codex memory smoke",
        "",
        `- session_key: ${sessionKey}`,
        `- branch: ${branch}`,
        `- dirty_state: ${dirtyState}`,
        "- raw transcripts: not stored",
      ].join("\n"),
      metadata: {
        branch,
        dirty_state: dirtyState,
        smoke: true,
      },
    },
  },
  {
    name: "append decision event",
    tool: "append_session_event",
    params: {
      session_key: sessionKey,
      event_type: "decision",
      content: "Codex smoke flow writes only distilled high-signal events.",
      source: "scripts/codex-memory-smoke.ts",
      importance: "cold",
      metadata: { smoke: true },
    },
  },
  {
    name: "append validation receipt",
    tool: "append_session_event",
    params: {
      session_key: sessionKey,
      event_type: "receipt",
      content: "Codex smoke flow reached validation receipt step.",
      source: "scripts/codex-memory-smoke.ts",
      importance: "cold",
      metadata: {
        smoke: true,
        receipt: {
          schema: "openbrain.receipt.v1",
          action: "codex_memory_smoke",
          agent: "codex-smoke",
          session_key: sessionKey,
          timestamp: new Date().toISOString(),
          sources: [
            {
              kind: "repo_path",
              path: "scripts/codex-memory-smoke.ts",
            },
            {
              kind: "repo_path",
              path: "docs/memory-contract.md",
            },
          ],
          outputs: [
            {
              kind: "session_event",
              event_type: "receipt",
            },
          ],
          validations: [
            {
              kind: "dry_run",
              status: writeEnabled ? "skipped" : "passed",
              summary: "Command JSON rendered without executing writes.",
            },
          ],
          project: "open-brain",
          branch,
          dirty_state: dirtyState,
        },
      },
    },
  },
  {
    name: "load lane context before checkpoint",
    tool: "session_context",
    params: {
      session_key: sessionKey,
      include_events: true,
      event_limit: 10,
    },
  },
  {
    name: "checkpoint summary",
    tool: "session_wrap",
    params: {
      session_key: sessionKey,
      project: "open-brain",
      summary: `Disposable Codex memory smoke checkpoint for ${sessionKey}. Confirms session_start, append_session_event, session_context, and session_wrap command shapes.`,
      key_decisions: [
        `Codex durable memory captures distilled events instead of raw transcripts for ${sessionKey}.`,
      ],
      next_steps: ["Delete or ignore disposable smoke lane if no longer useful."],
    },
  },
  {
    name: "reload lane context after checkpoint",
    tool: "session_context",
    params: {
      session_key: sessionKey,
      include_events: true,
      event_limit: 10,
    },
    expectOutput: [
      sessionKey,
      "Codex smoke flow reached validation receipt step.",
    ],
  },
  {
    name: "search saved checkpoint context",
    tool: "search_all",
    params: {
      query: sessionKey,
      sources: "brain",
      limit: 5,
    },
    expectOutput: [
      sessionKey,
      `Disposable Codex memory smoke checkpoint for ${sessionKey}`,
    ],
  },
];

function commandFor(step: SmokeStep): string[] {
  return [
    "mcp2cli",
    "open-brain",
    step.tool,
    "--params",
    JSON.stringify(step.params),
  ];
}

if (!writeEnabled) {
  console.log(
    "Dry run only. Set OPEN_BRAIN_CODEX_SMOKE_WRITE=1 to execute writes.",
  );
  for (const step of steps) {
    console.log(`\n# ${step.name}`);
    console.log(commandFor(step).map((part) => JSON.stringify(part)).join(" "));
  }
  process.exit(0);
}

for (const step of steps) {
  const command = commandFor(step);
  console.log(`\n# ${step.name}`);
  const proc = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  if (proc.stdout.byteLength > 0) {
    console.log(stdout);
  }
  if (proc.stderr.byteLength > 0) {
    console.error(stderr);
  }
  if (proc.exitCode !== 0) {
    console.error(`${step.tool} failed with exit code ${proc.exitCode}`);
    process.exit(proc.exitCode);
  }
  for (const expected of step.expectOutput ?? []) {
    if (!stdout.includes(expected)) {
      console.error(
        `${step.tool} output did not include expected text: ${JSON.stringify(
          expected,
        )}`,
      );
      process.exit(1);
    }
  }
}
