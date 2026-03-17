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

  // Build summary
  const summaryParts = [`Session before ${trigger} compaction`];
  if (branch) summaryParts.push(`Branch: ${branch}`);
  if (key_decisions.length) summaryParts.push(`Recent: ${key_decisions[0]}`);
  if (custom_instructions) summaryParts.push(custom_instructions);
  const summary = summaryParts.join(". ");

  // Build tags
  const tags = ["auto-save", "pre-compact", trigger];
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
    next_steps: [],
    key_decisions,
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
