#!/usr/bin/env bun
// Search PAI Knowledge Base
// Usage: search-kb.ts <query> [--decisions] [--learnings] [--patterns] [--limit N]

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface KBEntry {
  title: string;
  summary: string;
  weight: number;
  tags?: string[];
  impact?: string;
  context?: string;
  files?: string[];
  alternatives?: string[];
  tradeoffs?: string;
  evidence?: string[];
  problem?: string;
  solution?: string;
  keyInsight?: string;
  avoid?: string;
  date?: string;
  lastSeen?: string;
}

interface SearchResult extends KBEntry {
  category: "decision" | "learning" | "pattern";
  score: number;
}

function loadKB(filename: string): KBEntry[] {
  const kbPath = join(
    homedir(),
    ".config",
    "pai-private",
    "knowledge",
    filename,
  );
  if (!existsSync(kbPath)) return [];

  try {
    const data = JSON.parse(readFileSync(kbPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function scoreEntry(entry: KBEntry, queryTokens: string[]): number {
  const searchFields = [
    entry.title || "",
    entry.summary || "",
    entry.context || "",
    (entry.tags || []).join(" "),
    (entry.files || []).join(" "),
    entry.problem || "",
    entry.solution || "",
    entry.keyInsight || "",
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;

  // Token matching
  for (const token of queryTokens) {
    if (searchFields.includes(token)) {
      score += 10;
      // Bonus for title match
      if ((entry.title || "").toLowerCase().includes(token)) {
        score += 20;
      }
    }
  }

  // Weight bonus (0-100 normalized to 0-10)
  score += (entry.weight || 0) / 10;

  // Recency bonus (last 7 days = +20, last 30 days = +10)
  if (entry.lastSeen) {
    const lastSeen = new Date(entry.lastSeen);
    const now = new Date();
    const daysSince =
      (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince <= 7) score += 20;
    else if (daysSince <= 30) score += 10;
  }

  // Impact bonus
  if (entry.impact === "CRITICAL") score += 15;
  else if (entry.impact === "HIGH") score += 10;

  return score;
}

function search(
  query: string,
  categories: string[],
  limit: number,
): SearchResult[] {
  const queryTokens = tokenize(query);
  const results: SearchResult[] = [];

  if (categories.includes("decisions") || categories.length === 0) {
    const decisions = loadKB("decisions-v2.json");
    for (const entry of decisions) {
      const score = scoreEntry(entry, queryTokens);
      if (score > 10) {
        results.push({ ...entry, category: "decision", score });
      }
    }
  }

  if (categories.includes("learnings") || categories.length === 0) {
    const learnings = loadKB("learnings-v2.json");
    for (const entry of learnings) {
      const score = scoreEntry(entry, queryTokens);
      if (score > 10) {
        results.push({ ...entry, category: "learning", score });
      }
    }
  }

  if (categories.includes("patterns") || categories.length === 0) {
    const patterns = loadKB("patterns-v2.json");
    for (const entry of patterns) {
      const score = scoreEntry(entry, queryTokens);
      if (score > 10) {
        results.push({ ...entry, category: "pattern", score });
      }
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

function formatResult(result: SearchResult): string {
  const impact = result.impact ? ` [${result.impact}]` : "";
  const weight = result.weight ? ` (w:${result.weight})` : "";
  const score = ` (score:${result.score.toFixed(1)})`;

  let output = `- **${result.title}**${impact}${weight}${score}`;

  if (result.summary && result.summary !== result.title) {
    output += `\n  ${result.summary}`;
  }

  if (result.category === "decision") {
    if (result.context) {
      output += `\n  *Rationale:* ${result.context.slice(0, 200)}...`;
    }
    if (result.alternatives && result.alternatives.length > 0) {
      output += `\n  *Rejected:* ${result.alternatives[0]}`;
    }
  }

  if (result.category === "learning") {
    if (result.problem) {
      output += `\n  *Problem:* ${result.problem}`;
    }
    if (result.solution) {
      output += `\n  *Solution:* ${result.solution}`;
    }
    if (result.avoid) {
      output += `\n  *Avoid:* ${result.avoid}`;
    }
  }

  return output;
}

function main() {
  const args = process.argv.slice(2);

  // Parse flags
  const categories: string[] = [];
  let limit = 10;
  const queryParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--decisions") categories.push("decisions");
    else if (arg === "--learnings") categories.push("learnings");
    else if (arg === "--patterns") categories.push("patterns");
    else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10) || 10;
    } else if (!arg.startsWith("--")) {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(" ");

  if (!query) {
    console.log(
      "Usage: search-kb.ts <query> [--decisions] [--learnings] [--patterns] [--limit N]",
    );
    process.exit(1);
  }

  const results = search(query, categories, limit);

  if (results.length === 0) {
    console.log(`## Brain Query: "${query}"\n\nNo results found.`);
    process.exit(0);
  }

  console.log(`## Brain Query: "${query}"\n`);

  // Group by category
  const byCategory = {
    decision: results.filter((r) => r.category === "decision"),
    learning: results.filter((r) => r.category === "learning"),
    pattern: results.filter((r) => r.category === "pattern"),
  };

  if (byCategory.decision.length > 0) {
    console.log(`### Decisions (${byCategory.decision.length} found)\n`);
    byCategory.decision.forEach((r) => console.log(formatResult(r) + "\n"));
  }

  if (byCategory.learning.length > 0) {
    console.log(`### Learnings (${byCategory.learning.length} found)\n`);
    byCategory.learning.forEach((r) => console.log(formatResult(r) + "\n"));
  }

  if (byCategory.pattern.length > 0) {
    console.log(`### Patterns (${byCategory.pattern.length} found)\n`);
    byCategory.pattern.forEach((r) => console.log(formatResult(r) + "\n"));
  }
}

main();
