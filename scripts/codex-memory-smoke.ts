#!/usr/bin/env bun

type SmokeStep = {
  name: string;
  tool: string;
  params: Record<string, unknown>;
};

const writeEnabled = process.env.OPEN_BRAIN_CODEX_SMOKE_WRITE === "1";
const sessionKey =
  process.env.OPEN_BRAIN_CODEX_SMOKE_SESSION_KEY ??
  `codex-smoke-${new Date().toISOString().slice(0, 10)}`;

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
      metadata: { smoke: true },
    },
  },
  {
    name: "load lane context",
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
      summary:
        "Disposable Codex memory smoke checkpoint. Confirms session_start, append_session_event, session_context, and session_wrap command shapes.",
      key_decisions: [
        "Codex durable memory captures distilled events instead of raw transcripts.",
      ],
      next_steps: ["Delete or ignore disposable smoke lane if no longer useful."],
    },
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
  if (proc.stdout.byteLength > 0) {
    console.log(new TextDecoder().decode(proc.stdout).trim());
  }
  if (proc.stderr.byteLength > 0) {
    console.error(new TextDecoder().decode(proc.stderr).trim());
  }
  if (proc.exitCode !== 0) {
    console.error(`${step.tool} failed with exit code ${proc.exitCode}`);
    process.exit(proc.exitCode);
  }
}
