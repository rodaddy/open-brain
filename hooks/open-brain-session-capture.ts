#!/usr/bin/env bun
// SessionEnd hook: captures session knowledge to Open Brain
// Fires on: session end
// Silent on all errors -- never blocks session end

export {};

try {
  const input = await Bun.stdin.json();
  const { cwd } = input;
  const project = cwd.split("/").pop() || "unknown";

  const OPEN_BRAIN_URL = "http://10.71.20.15:3100/mcp";
  const TOKEN = Bun.env.OPEN_BRAIN_AGENT_TOKEN;
  if (!TOKEN) process.exit(0);

  // Get recent git log (last 10 commits)
  let commits: string[] = [];
  try {
    const logResult = Bun.spawnSync(
      ["git", "log", "--oneline", "--no-decorate", "-10"],
      { cwd, timeout: 3000 },
    );
    if (logResult.exitCode === 0) {
      commits = logResult.stdout.toString().trim().split("\n").filter(Boolean);
    }
  } catch {
    /* no git or not a repo */
  }

  // Get git diff --stat for changed files
  let diffStat = "";
  try {
    const diffResult = Bun.spawnSync(
      ["git", "diff", "--stat", "HEAD~1", "HEAD"],
      { cwd, timeout: 3000 },
    );
    if (diffResult.exitCode === 0) {
      diffStat = diffResult.stdout.toString().trim();
    }
  } catch {
    /* ignore */
  }

  // Get branch name for tags
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

  // Extract decision commits (feat/fix/refactor/chore/docs/perf)
  const decisionPrefixes =
    /^[a-f0-9]+ (feat|fix|refactor|chore|docs|perf|test)(\(.+\))?:/;
  const decisionCommits = commits.filter((c) => decisionPrefixes.test(c));

  // Build key_decisions from commit messages (strip hash)
  const key_decisions = decisionCommits.map((c) =>
    c.replace(/^[a-f0-9]+ /, ""),
  );

  // Build rich summary
  const summaryParts: string[] = [`Session end capture for ${project}`];
  if (branch) summaryParts.push(`Branch: ${branch}`);
  if (commits.length)
    summaryParts.push(`Last commit: ${commits[0].replace(/^[a-f0-9]+ /, "")}`);
  if (diffStat) summaryParts.push(`\n\nChanged files:\n${diffStat}`);
  const summary = summaryParts.join(". ");

  // Build tags from branch type
  const tags = ["auto-save", "session-end"];
  if (branch) {
    const branchType = branch.split("/")[0];
    if (
      ["feat", "fix", "wip", "chore", "refactor", "docs"].includes(branchType)
    ) {
      tags.push(branchType);
    }
  }

  // Parse SSE or JSON response
  const parseMcpResponse = async (resp: Response) => {
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          return JSON.parse(line.slice(6));
        } catch {
          /* skip */
        }
      }
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

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

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
    "mcp-session-id": mcpSessionId,
  };

  const callTool = async (
    id: number,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const resp = await fetch(OPEN_BRAIN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return parseMcpResponse(resp);
  };

  // Save session
  await callTool(2, "session_save", {
    summary,
    project,
    tags,
    key_decisions,
    next_steps: [],
  });

  // Log each decision commit
  let toolId = 3;
  for (const commit of decisionCommits) {
    const title = commit.replace(/^[a-f0-9]+ /, "");
    await callTool(toolId++, "log_decision", {
      title,
      rationale: "Decided during session",
      tags: [project, ...tags],
    });
  }

  // Log a thought summarizing the diff if we have one
  if (diffStat) {
    await callTool(toolId++, "log_thought", {
      content: `Files changed in ${project} session:\n\n${diffStat}`,
      tags: [project, "git-diff", "session-end"],
    });
  }
} catch {
  // Silent failure -- never block session end
  process.exit(0);
}
