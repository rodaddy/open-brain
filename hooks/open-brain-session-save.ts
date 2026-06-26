#!/usr/bin/env bun
// PreCompact hook: saves session state to Open Brain before context compaction
// Uses mcp2cli for transport/auth -- no raw HTTP
// Fires on: manual | auto compaction
// Silent on all errors -- never blocks compaction

export {};

try {
  const input = await Bun.stdin.json();
  const { cwd, trigger, custom_instructions } = input;
  const project = cwd.split("/").pop() || "unknown";

  // Extract recent git commits as key decisions
  const key_decisions: string[] = [];
  try {
    const gitResult = Bun.spawnSync(
      ["git", "log", "--oneline", "-5", "--no-decorate"],
      { cwd, timeout: 3000 },
    );
    if (gitResult.exitCode === 0) {
      const commits = gitResult.stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      key_decisions.push(...commits.map((c) => c.replace(/^[a-f0-9]+ /, "")));
    }
  } catch {
    /* no git or not a repo */
  }

  // Extract branch name for context
  let branch = "";
  try {
    const branchResult = Bun.spawnSync(["git", "branch", "--show-current"], {
      cwd,
      timeout: 2000,
    });
    if (branchResult.exitCode === 0) {
      branch = branchResult.stdout.toString().trim();
    }
  } catch {
    /* ignore */
  }

  // Capture dirty state so compact recovery can separate real work from noise.
  let dirtyState = "";
  try {
    const statusResult = Bun.spawnSync(["git", "status", "--short"], {
      cwd,
      timeout: 3000,
    });
    if (statusResult.exitCode === 0) {
      dirtyState = statusResult.stdout.toString().trim();
    }
  } catch {
    /* no git or not a repo */
  }

  // Build summary
  const summaryParts = [`Session before ${trigger} compaction`];
  summaryParts.push(`CWD: ${cwd}`);
  summaryParts.push("Policy state: context is stale after compaction; next agent action must refresh active routers/SOPs before risky edits, git, infra, deploy, or worker orchestration.");
  summaryParts.push("Pony style: identify the owning boundary, make the smallest correct owned change, preserve callers/invariants, and verify.");
  summaryParts.push("Critical mode: challenge weak assumptions, surface concrete risk, ask when ambiguity matters, then proceed.");
  summaryParts.push("Source order: live/source files and current system state beat OB/qmd, which beat compacted memory or summaries.");
  if (branch) summaryParts.push(`Branch: ${branch}`);
  summaryParts.push(dirtyState ? `Dirty state:\n${dirtyState}` : "Dirty state: clean or unavailable");
  if (key_decisions.length) summaryParts.push(`Recent: ${key_decisions[0]}`);
  if (custom_instructions) summaryParts.push(custom_instructions);
  const summary = summaryParts.join(". ");

  // Build tags
  const tags = [
    "auto-save",
    "pre-compact",
    "policy-refresh-required",
    "pony-style",
    "critical-mode",
    trigger,
  ];
  if (branch) {
    const branchType = branch.split("/")[0];
    if (["feat", "fix", "wip", "chore"].includes(branchType))
      tags.push(branchType);
  }

  // Save via mcp2cli
  const params = JSON.stringify({
    summary,
    project,
    tags,
    next_steps: [
      "Reread active AGENTS/CLAUDE router and triggered SOPs before risky action.",
      "Restate Pony style, critical mode, source-of-truth order, and next concrete action.",
      "Inspect cwd, branch, and dirty state before editing; do not mix unrelated dirty files into the next phase.",
      "Run /Volumes/ThunderBolt/Development/_ob/scripts/policy-refresh-gate.ts --event refresh --agent claude after refresh.",
    ],
    key_decisions: [
      "Compaction requires forced relearn before risky action.",
      "Pony style and critical mode are hard layer-1 defaults.",
      ...key_decisions,
    ],
  });

  const result = Bun.spawnSync(
    ["mcp2cli", "open-brain", "session_save", "--params", params],
    { timeout: 12000 },
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    console.error(`open-brain session_save failed: ${stderr}`);
  }
} catch (err) {
  // Log but never block compaction
  console.error(`open-brain pre-compact hook error: ${err}`);
  process.exit(0);
}
