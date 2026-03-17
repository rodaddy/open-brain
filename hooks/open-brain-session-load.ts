#!/usr/bin/env bun
// SessionStart hook: loads knowledge + session context from Open Brain
// Uses mcp2cli for transport/auth -- no raw HTTP
// Fires on: * (all session starts)
// Silent on all errors -- never blocks session start

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

try {
  const input = await Bun.stdin.json();
  const { cwd } = input;
  const project = cwd.split("/").pop() || "unknown";

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
      }
    } catch {
      /* ignore parse errors */
    }
  }

  const searchQuery = [project, ...tags.slice(0, 5)].join(" ");

  // Helper to call mcp2cli and parse JSON result
  const callMcp = (
    service: string,
    tool: string,
    params: Record<string, unknown>,
  ): unknown | null => {
    const result = Bun.spawnSync(
      ["mcp2cli", service, tool, "--params", JSON.stringify(params)],
      { timeout: 8000 },
    );
    if (result.exitCode !== 0) return null;
    try {
      const output = JSON.parse(result.stdout.toString().trim());
      if (output?.result !== undefined) {
        const inner = output.result;
        if (typeof inner === "string") {
          try {
            return JSON.parse(inner);
          } catch {
            return inner;
          }
        }
        return inner;
      }
      return output;
    } catch {
      return null;
    }
  };

  // Client-side federation: OB search_brain + qmd BM25 search + session_load in parallel
  // All three are sync calls but run sequentially (Bun.spawnSync)
  const obResult = callMcp("open-brain", "search_brain", {
    query: searchQuery,
    limit: 7,
  });
  const qmdResult = callMcp("qmd", "search", { query: searchQuery, limit: 5 });
  const sessionResult = callMcp("open-brain", "session_load", { project });

  // Normalize OB results (distance 0-1 lower=better -> score 0-1 higher=better)
  const brainResults: Array<Record<string, unknown>> = [];
  if (Array.isArray(obResult)) {
    for (const r of obResult as Array<Record<string, unknown>>) {
      brainResults.push({
        source: "brain",
        type: r.source_type,
        content: r.content_preview,
        score: 1 - (Number(r.distance) || 0.5),
        tags: r.tags,
      });
    }
  }

  // Normalize qmd results (score 0-1 higher=better, nested in .results)
  const qmdResults: Array<Record<string, unknown>> = [];
  const qmdInner =
    qmdResult && typeof qmdResult === "object" && !Array.isArray(qmdResult)
      ? ((qmdResult as Record<string, unknown>).results as
          | Array<Record<string, unknown>>
          | undefined)
      : null;
  if (Array.isArray(qmdInner)) {
    for (const r of qmdInner) {
      qmdResults.push({
        source: "qmd",
        type: "file",
        content: String(r.snippet ?? r.content ?? "").slice(0, 300),
        score: Number(r.score) || 0.5,
        path: r.file || r.path,
        collection: r.collection,
      });
    }
  }

  // Merge and sort by score descending
  const results = [...brainResults, ...qmdResults]
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, 10);

  const lines: string[] = [];

  if (results.length > 0) {
    lines.push(`<!-- PAI Brain Context for ${project} -->`);
    lines.push(`<!-- Detected tags: ${tags.map((t) => "#" + t).join(" ")} -->`);
    lines.push("");
    lines.push("## Relevant Past Learnings");
    lines.push("");
    for (const r of results as Array<Record<string, unknown>>) {
      const isBrain = r.source === "brain";
      const typeLabel = isBrain
        ? r.type === "decision"
          ? "DECISION"
          : r.type === "thought"
            ? "TECHNIQUE"
            : String(r.type ?? "ENTRY").toUpperCase()
        : "FILE";
      const firstLine = isBrain
        ? String(r.content ?? "").split("\n")[0] || "Untitled"
        : r.path
          ? `${r.path}`
          : String(r.content ?? "").split("\n")[0] || "Untitled";
      lines.push(`## [${typeLabel}] ${firstLine}`);
      if (Array.isArray(r.tags) && r.tags.length) {
        lines.push(
          `**Tags:** ${(r.tags as string[]).map((t: string) => "#" + t).join(" ")}`,
        );
      }
      if (r.collection) lines.push(`**Collection:** ${r.collection}`);
      const content = String(r.content ?? "");
      if (content) {
        lines.push(
          content.length > 500 ? content.slice(0, 500) + "..." : content,
        );
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // Session context section
  if (
    sessionResult &&
    typeof sessionResult === "object" &&
    !(
      "text" in (sessionResult as Record<string, unknown>) &&
      String((sessionResult as Record<string, unknown>).text).startsWith(
        "No sessions",
      )
    )
  ) {
    const session = sessionResult as Record<string, unknown>;
    if (!lines.length) {
      lines.push(`<!-- PAI Brain Context for ${project} -->`);
    }
    lines.push("## Previous Session");
    lines.push(
      `**Project:** ${session.project || "global"} | **Saved:** ${session.created_at}`,
    );
    if (session.summary) lines.push(`\n${session.summary}`);
    if (Array.isArray(session.key_decisions) && session.key_decisions.length) {
      lines.push("\n### Key Decisions");
      for (const d of session.key_decisions) lines.push(`- ${d}`);
    }
    if (Array.isArray(session.blockers) && session.blockers.length) {
      lines.push("\n### Blockers");
      for (const b of session.blockers) lines.push(`- ${b}`);
    }
    if (Array.isArray(session.next_steps) && session.next_steps.length) {
      lines.push("\n### Next Steps");
      for (const s of session.next_steps) lines.push(`- ${s}`);
    }
    lines.push("");
  }

  if (lines.length > 0) {
    lines.push("<!-- End PAI Brain Context -->");
    let output = lines.join("\n");
    if (output.length > 3000) {
      const omitted = output.length - 3000;
      output =
        output.slice(0, 3000) +
        `\n<!-- Truncated: ${omitted} chars omitted -->`;
    }
    console.log(output);
  }
} catch (err) {
  // Log but never block session start
  console.error(`open-brain session-load hook error: ${err}`);
  process.exit(0);
}
