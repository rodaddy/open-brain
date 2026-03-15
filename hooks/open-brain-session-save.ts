#!/usr/bin/env bun
// PreCompact hook: saves session state to Open Brain before context compaction
// Enhanced: extracts git context for key_decisions and branch info
// Fires on: manual | auto compaction
// Silent on all errors -- never blocks compaction

export {};

try {
  const input = await Bun.stdin.json();
  const { cwd, trigger, custom_instructions } = input;
  const project = cwd.split("/").pop() || "unknown";

  const OPEN_BRAIN_URL = "http://10.71.20.15:3100/mcp";
  const TOKEN = Bun.env.OPEN_BRAIN_AGENT_TOKEN;
  if (!TOKEN) process.exit(0);

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

  // Init MCP session
  const initResp = await fetch(OPEN_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "claude-code-hook", version: "2.0.0" },
      },
    }),
  });

  const mcpSessionId = initResp.headers.get("mcp-session-id");
  if (!mcpSessionId) process.exit(0);

  // Call session_save
  await fetch(OPEN_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      "mcp-session-id": mcpSessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "session_save",
        arguments: {
          summary,
          project,
          tags,
          next_steps: [],
          key_decisions,
        },
      },
    }),
  });
} catch {
  // Silent failure -- never block compaction
  process.exit(0);
}
