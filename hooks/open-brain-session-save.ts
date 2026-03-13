#!/usr/bin/env bun
// PreCompact hook: saves session state to Open Brain before context compaction
// Fires on: manual | auto compaction
// Silent on all errors -- never blocks compaction

try {
  const input = await Bun.stdin.json();
  const { session_id, cwd, trigger, custom_instructions } = input;
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

  // Build summary with custom_instructions if present
  const parts = [
    `Auto-saved before ${trigger} compaction. Session: ${session_id}`,
  ];
  if (custom_instructions) parts.push(custom_instructions);
  const summary = parts.join(". ");

  // Step 2: Call session_save tool
  await fetch(OPEN_BRAIN_URL, {
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
        name: "session_save",
        arguments: {
          summary,
          project,
          tags: ["auto-save", "pre-compact", trigger],
          next_steps: [],
          key_decisions: [],
        },
      },
    }),
  });
} catch {
  // Silent failure -- never block compaction
  process.exit(0);
}
