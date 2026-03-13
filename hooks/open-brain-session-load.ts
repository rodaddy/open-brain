#!/usr/bin/env bun
// SessionStart hook: loads previous session context from Open Brain
// Fires on: startup | resume | compact
// Outputs formatted context to stdout for Claude to consume
// Silent on all errors -- never blocks session start

try {
  const input = await Bun.stdin.json();
  const { cwd } = input;
  const project = cwd.split("/").pop() || "unknown";

  const OPEN_BRAIN_URL = "http://10.71.20.49:3100/mcp";
  const TOKEN = Bun.env.OPEN_BRAIN_AGENT_TOKEN;

  if (!TOKEN) process.exit(0);

  // Step 1: Initialize MCP session
  const initResp = await fetch(OPEN_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "claude-code-hook", version: "1.0.0" },
      },
    }),
  });

  const mcpSessionId = initResp.headers.get("mcp-session-id");
  if (!mcpSessionId) process.exit(0);

  // Step 2: Call session_load tool
  const loadResp = await fetch(OPEN_BRAIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "mcp-session-id": mcpSessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "session_load",
        arguments: { project },
      },
    }),
  });

  const result = await loadResp.json();
  const content = result?.result?.content?.[0]?.text;
  if (!content || content.startsWith("No sessions")) process.exit(0);

  const session = JSON.parse(content);

  // Output concise context to stdout (injected into Claude's context)
  const lines: string[] = [];
  lines.push("<!-- Open Brain: Previous Session Context -->");
  lines.push(`## Last Session: ${session.project || "global"}`);
  lines.push(`**Saved:** ${session.created_at}`);

  if (session.key_decisions?.length) {
    lines.push("");
    lines.push("### Key Decisions");
    for (const d of session.key_decisions) lines.push(`- ${d}`);
  }

  if (session.blockers?.length) {
    lines.push("");
    lines.push("### Blockers");
    for (const b of session.blockers) lines.push(`- ${b}`);
  }

  if (session.next_steps?.length) {
    lines.push("");
    lines.push("### Next Steps");
    for (const s of session.next_steps) lines.push(`- ${s}`);
  }

  lines.push("<!-- End Open Brain Context -->");
  console.log(lines.join("\n"));
} catch {
  // Silent failure -- don't block session start
  process.exit(0);
}
