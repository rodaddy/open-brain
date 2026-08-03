// Record byte-exact stdin -> stdout/exit fixtures from the LIVE TS gates.
// These recordings ARE the parity fixtures for the Python port.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const OUT = "/Volumes/ThunderBolt/_tmp/open-brain/_scratch/gateport-fixtures";
const SCRIPTS = "/Volumes/ThunderBolt/Development/_ob/scripts";
mkdirSync(OUT, { recursive: true });
const scratch = mkdtempSync(join("/Volumes/ThunderBolt/_tmp/open-brain/_scratch", "gaterec-"));
const settings = join(scratch, "settings.json");
writeFileSync(settings, "{}");

type Probe = { name: string; script: string; argv: string[]; stdin: Record<string, unknown> };

const budgetState = join(scratch, "budget-state.json");
const receipts = join(scratch, "receipts.json");
const policyState = join(scratch, "policy-state.json");
const spool = join(scratch, "spool.jsonl");

function budgetArgs(event: string, sessionId: string, project: string | null = "Development"): string[] {
  const a = [
    join(SCRIPTS, "context-budget-gate.ts"),
    "--event", event,
    "--state-path", budgetState,
    "--receipt-state-path", receipts,
    "--settings-path", settings,
    "--policy-state-path", policyState,
    "--spool-path", spool,
    "--session-id", sessionId,
    "--nag-tokens", "200000",
    "--hard-tokens", "250000",
  ];
  if (project) a.push("--project", project);
  return a;
}

function policyArgs(event: string, sessionId: string, extra: string[] = []): string[] {
  return [
    join(SCRIPTS, "policy-refresh-gate.ts"),
    "--event", event,
    "--state-path", join(scratch, "policy-own-state.json"),
    "--agent", "claude",
    "--runtime", "claude",
    "--session-id", sessionId,
    ...extra,
  ];
}

const cwd = "/Volumes/ThunderBolt/Development";
const probes: Probe[] = [
  // --- context-budget-gate ---
  { name: "budget-status-fresh", script: "budget", argv: budgetArgs("status", "rec-1"), stdin: { session_id: "rec-1", cwd } },
  { name: "budget-user-prompt-submit-clean", script: "budget", argv: budgetArgs("user-prompt-submit", "rec-1"), stdin: { session_id: "rec-1", cwd } },
  { name: "budget-pre-tool-use-clean", script: "budget", argv: budgetArgs("pre-tool-use", "rec-1"), stdin: { session_id: "rec-1", cwd, tool_name: "Read", tool_input: { file_path: "/x" } } },
  { name: "budget-session-start-startup", script: "budget", argv: budgetArgs("session-start", "rec-1"), stdin: { session_id: "rec-1", cwd, source: "startup" } },
  { name: "budget-pre-compact", script: "budget", argv: budgetArgs("pre-compact", "rec-1"), stdin: { session_id: "rec-1", cwd } },
  { name: "budget-post-compact-arms", script: "budget", argv: budgetArgs("post-compact", "rec-2"), stdin: { session_id: "rec-2", cwd } },
  { name: "budget-blocked-pre-tool-use", script: "budget", argv: budgetArgs("pre-tool-use", "rec-2"), stdin: { session_id: "rec-2", cwd, tool_name: "Write", tool_input: { file_path: "/x/y" } } },
  { name: "budget-blocked-user-prompt-submit", script: "budget", argv: budgetArgs("user-prompt-submit", "rec-2"), stdin: { session_id: "rec-2", cwd } },
  { name: "budget-blocked-allows-read", script: "budget", argv: budgetArgs("pre-tool-use", "rec-2"), stdin: { session_id: "rec-2", cwd, tool_name: "Read", tool_input: { file_path: "/x" } } },
  { name: "budget-status-blocked", script: "budget", argv: budgetArgs("status", "rec-2"), stdin: { session_id: "rec-2", cwd } },
  { name: "budget-repair-enter", script: "budget", argv: [...budgetArgs("repair-enter", "rec-2"), "--repair-reason", "recall is broken", "--repair-minutes", "5"], stdin: { session_id: "rec-2", cwd } },
  { name: "budget-repair-active-bash", script: "budget", argv: budgetArgs("pre-tool-use", "rec-2"), stdin: { session_id: "rec-2", cwd, tool_name: "Bash", tool_input: { command: "echo hi >> notes.txt" } } },
  { name: "budget-repair-exit", script: "budget", argv: [...budgetArgs("repair-exit", "rec-2"), "--repair-reason", "done"], stdin: { session_id: "rec-2", cwd } },
  { name: "budget-repair-enter-refused", script: "budget", argv: [...budgetArgs("repair-enter", "rec-2"), "--repair-minutes", "5"], stdin: { session_id: "rec-2", cwd } },
  { name: "budget-checkpoint-done-refused", script: "budget", argv: budgetArgs("checkpoint-done", "rec-2"), stdin: { session_id: "rec-2", cwd } },
  { name: "budget-stop-no-work", script: "budget", argv: budgetArgs("stop", "rec-3"), stdin: { session_id: "rec-3", cwd } },
  { name: "budget-outside-development", script: "budget", argv: budgetArgs("user-prompt-submit", "rec-4", null), stdin: { session_id: "rec-4", cwd: "/Users/rico" } },
  { name: "budget-empty-stdin", script: "budget", argv: budgetArgs("status", "rec-5"), stdin: {} },
  // --- policy-refresh-gate ---
  { name: "policy-session-start", script: "policy", argv: policyArgs("session-start", "pol-1"), stdin: { session_id: "pol-1", cwd } },
  { name: "policy-user-prompt-submit", script: "policy", argv: policyArgs("user-prompt-submit", "pol-1"), stdin: { session_id: "pol-1", cwd } },
  { name: "policy-pre-tool-use-harmless", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Read", tool_input: { file_path: "/x" } } },
  { name: "policy-pre-tool-use-tmp-write", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Write", tool_input: { file_path: "/tmp/evil.txt" } } },
  { name: "policy-pre-tool-use-tmp-redirect", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Bash", tool_input: { command: "echo hi > /tmp/x.txt" } } },
  { name: "policy-pre-tool-use-git-reset-hard", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Bash", tool_input: { command: "git reset --hard origin/main" } } },
  { name: "policy-pre-tool-use-git-checkout-main", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Bash", tool_input: { command: "git checkout main" } } },
  { name: "policy-pre-tool-use-pr-merge-admin", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Bash", tool_input: { command: "gh pr merge --admin 12" } } },
  { name: "policy-pre-tool-use-agent", script: "policy", argv: policyArgs("pre-tool-use", "pol-1"), stdin: { session_id: "pol-1", cwd, tool_name: "Agent", tool_input: {} } },
  { name: "policy-post-compact", script: "policy", argv: policyArgs("post-compact", "pol-2"), stdin: { session_id: "pol-2", cwd } },
  { name: "policy-pre-compact", script: "policy", argv: policyArgs("pre-compact", "pol-3"), stdin: { session_id: "pol-3", cwd } },
  { name: "policy-blocked-risky-write", script: "policy", argv: policyArgs("pre-tool-use", "pol-2"), stdin: { session_id: "pol-2", cwd, tool_name: "Write", tool_input: { file_path: "/Volumes/ThunderBolt/Development/x.md" } } },
  { name: "policy-blocked-allows-refresh-cmd", script: "policy", argv: policyArgs("pre-tool-use", "pol-2"), stdin: { session_id: "pol-2", cwd, tool_name: "Bash", tool_input: { command: "bun /Volumes/ThunderBolt/Development/_ob/scripts/policy-refresh-gate.ts --event refresh --agent claude" } } },
  { name: "policy-refresh", script: "policy", argv: policyArgs("refresh", "pol-2"), stdin: { session_id: "pol-2", cwd } },
  { name: "policy-empty-stdin", script: "policy", argv: policyArgs("user-prompt-submit", "pol-9"), stdin: {} },
];

const recorded: unknown[] = [];
for (const probe of probes) {
  const stdin = JSON.stringify(probe.stdin);
  const result = spawnSync("bun", ["run", ...probe.argv], {
    input: stdin,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ANTHROPIC_BASE_URL: "" },
  });
  recorded.push({
    name: probe.name,
    script: probe.script,
    argv: probe.argv.slice(1),
    stdin: probe.stdin,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  });
  console.log(`${probe.name}: exit=${result.status} stdout=${result.stdout.length}b`);
}
writeFileSync(join(OUT, "recorded.json"), JSON.stringify(recorded, null, 2));
console.log(`\nwrote ${recorded.length} recordings; scratch=${scratch}`);
