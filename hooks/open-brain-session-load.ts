#!/usr/bin/env bun
// SessionStart hook: loads knowledge + session context from Open Brain
// Replaces: inject-brain-context.ts + query-knowledge.ts + original session-load
// Fires on: * (all session starts)
// Silent on all errors -- never blocks session start

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface McpResponse {
  result?: { content?: Array<{ text?: string }> };
}

try {
  const input = await Bun.stdin.json();
  const { cwd } = input;
  const project = cwd.split("/").pop() || "unknown";

  const OPEN_BRAIN_URL = "http://10.71.20.15:3100/mcp";
  const TOKEN = Bun.env.OPEN_BRAIN_AGENT_TOKEN;
  if (!TOKEN) process.exit(0);

  // Detect project tags from package.json dependencies
  const tags: string[] = [];
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const knownTags: Record<string, string> = {
        hono: "hono",
        react: "react",
        express: "express",
        next: "nextjs",
        "@modelcontextprotocol/sdk": "modelcontextprotocol-sdk",
        pg: "pg",
        pgvector: "pgvector",
        zod: "zod",
        htmx: "htmx",
        bun: "bun",
        typescript: "typescript",
        prisma: "prisma",
        drizzle: "drizzle",
        cors: "cors",
        "@hono/zod-openapi": "openapi",
        "@anthropic-ai/sdk": "anthropic-sdk",
        openai: "openai",
      };
      for (const dep of Object.keys(deps)) {
        if (knownTags[dep]) tags.push(knownTags[dep]);
        // Also add @types/* packages as tags
        else if (dep.startsWith("@types/")) tags.push(`types-${dep.slice(7)}`);
      }
    } catch {
      /* ignore parse errors */
    }
  }

  const searchQuery = [project, ...tags.slice(0, 5)].join(" ");

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

  // Parse SSE or JSON response from MCP server
  const parseMcpResponse = async (
    resp: Response,
  ): Promise<McpResponse | null> => {
    const text = await resp.text();
    // SSE format: "event: message\ndata: {...}\n\n"
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        return JSON.parse(line.slice(6));
      }
    }
    // Fallback: try plain JSON
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  // Helper to call an MCP tool
  const callTool = async (
    id: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string | null> => {
    const resp = await fetch(OPEN_BRAIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
        "mcp-session-id": mcpSessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const result = await parseMcpResponse(resp);
    return result?.result?.content?.[0]?.text ?? null;
  };

  // Call search_brain + session_load in parallel
  const [searchText, sessionText] = await Promise.all([
    callTool(2, "search_brain", { query: searchQuery, limit: 7 }),
    callTool(3, "session_load", { project }),
  ]);

  const lines: string[] = [];

  // Knowledge context section
  if (searchText) {
    try {
      const results = JSON.parse(searchText);
      if (Array.isArray(results) && results.length > 0) {
        lines.push(`<!-- PAI Brain Context for ${project} -->`);
        lines.push(
          `<!-- Detected tags: ${tags.map((t) => "#" + t).join(" ")} -->`,
        );
        lines.push("");
        lines.push("## Relevant Past Learnings");
        lines.push("");
        for (const r of results) {
          const typeLabel =
            r.source_type === "decision"
              ? "DECISION"
              : r.source_type === "thought"
                ? "TECHNIQUE"
                : r.source_type?.toUpperCase() || "ENTRY";
          const firstLine = r.content_preview?.split("\n")[0] || "Untitled";
          lines.push(`## [${typeLabel}] ${firstLine}`);
          if (r.tags?.length) {
            lines.push(
              `**Tags:** ${r.tags.map((t: string) => "#" + t).join(" ")}`,
            );
          }
          if (r.content_preview) {
            const preview =
              r.content_preview.length > 500
                ? r.content_preview.slice(0, 500) + "..."
                : r.content_preview;
            lines.push(preview);
          }
          lines.push("");
          lines.push("---");
          lines.push("");
        }
      }
    } catch {
      /* not JSON or empty */
    }
  }

  // Session context section
  if (sessionText && !sessionText.startsWith("No sessions")) {
    try {
      const session = JSON.parse(sessionText);
      if (!lines.length) {
        lines.push(`<!-- PAI Brain Context for ${project} -->`);
      }
      lines.push("## Previous Session");
      lines.push(
        `**Project:** ${session.project || "global"} | **Saved:** ${session.created_at}`,
      );
      if (session.summary) lines.push(`\n${session.summary}`);
      if (session.key_decisions?.length) {
        lines.push("\n### Key Decisions");
        for (const d of session.key_decisions) lines.push(`- ${d}`);
      }
      if (session.blockers?.length) {
        lines.push("\n### Blockers");
        for (const b of session.blockers) lines.push(`- ${b}`);
      }
      if (session.next_steps?.length) {
        lines.push("\n### Next Steps");
        for (const s of session.next_steps) lines.push(`- ${s}`);
      }
      lines.push("");
    } catch {
      /* not JSON */
    }
  }

  if (lines.length > 0) {
    lines.push("<!-- End PAI Brain Context -->");
    console.log(lines.join("\n"));
  }
} catch {
  // Silent failure -- don't block session start
  process.exit(0);
}
