#!/usr/bin/env node
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
  const kbPath = join(homedir(), ".config", "pai-private", "knowledge", filename);
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

function searchableText(entry: KBEntry): string {
  return [
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
}

function tokenScore(entry: KBEntry, queryTokens: string[]): number {
  const searchFields = searchableText(entry);
  const title = (entry.title || "").toLowerCase();
  let score = 0;

  for (const token of queryTokens) {
    if (searchFields.includes(token)) {
      score += 10;
      // Bonus for title match
      if (title.includes(token)) {
        score += 20;
      }
    }
  }

  return score;
}

// Recency bonus (last 7 days = +20, last 30 days = +10)
function recencyBonus(lastSeen: string | undefined): number {
  if (!lastSeen) return 0;
  const seen = new Date(lastSeen);
  const now = new Date();
  const daysSince = (now.getTime() - seen.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 7) return 20;
  if (daysSince <= 30) return 10;
  return 0;
}

function impactBonus(impact: string | undefined): number {
  if (impact === "CRITICAL") return 15;
  if (impact === "HIGH") return 10;
  return 0;
}

function scoreEntry(entry: KBEntry, queryTokens: string[]): number {
  return (
    tokenScore(entry, queryTokens) +
    // Weight bonus (0-100 normalized to 0-10)
    (entry.weight || 0) / 10 +
    recencyBonus(entry.lastSeen) +
    impactBonus(entry.impact)
  );
}

function collectCategory(
  filename: string,
  category: SearchResult["category"],
  queryTokens: string[],
): SearchResult[] {
  const collected: SearchResult[] = [];
  for (const entry of loadKB(filename)) {
    const score = scoreEntry(entry, queryTokens);
    if (score > 10) {
      collected.push({ ...entry, category, score });
    }
  }
  return collected;
}

function search(query: string, categories: string[], limit: number): SearchResult[] {
  const queryTokens = tokenize(query);
  const wanted = (name: string) => categories.includes(name) || categories.length === 0;
  const results: SearchResult[] = [];

  if (wanted("decisions")) {
    results.push(...collectCategory("decisions-v2.json", "decision", queryTokens));
  }

  if (wanted("learnings")) {
    results.push(...collectCategory("learnings-v2.json", "learning", queryTokens));
  }

  if (wanted("patterns")) {
    results.push(...collectCategory("patterns-v2.json", "pattern", queryTokens));
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

function formatDecisionDetail(result: SearchResult): string {
  let output = "";
  if (result.context) {
    output += `\n  *Rationale:* ${result.context.slice(0, 200)}...`;
  }
  if (result.alternatives && result.alternatives.length > 0) {
    output += `\n  *Rejected:* ${result.alternatives[0]}`;
  }
  return output;
}

function formatLearningDetail(result: SearchResult): string {
  let output = "";
  if (result.problem) {
    output += `\n  *Problem:* ${result.problem}`;
  }
  if (result.solution) {
    output += `\n  *Solution:* ${result.solution}`;
  }
  if (result.avoid) {
    output += `\n  *Avoid:* ${result.avoid}`;
  }
  return output;
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
    output += formatDecisionDetail(result);
  }

  if (result.category === "learning") {
    output += formatLearningDetail(result);
  }

  return output;
}

interface ParsedArgs {
  categories: string[];
  limit: number;
  query: string;
}

function parseArgs(args: string[]): ParsedArgs {
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

  return { categories, limit, query: queryParts.join(" ") };
}

function printSection(heading: string, results: SearchResult[]): void {
  if (results.length === 0) return;
  console.log(`### ${heading} (${results.length} found)\n`);
  results.forEach((r) => console.log(formatResult(r) + "\n"));
}

function printResults(query: string, results: SearchResult[]): void {
  console.log(`## Brain Query: "${query}"\n`);

  // Group by category
  printSection(
    "Decisions",
    results.filter((r) => r.category === "decision"),
  );
  printSection(
    "Learnings",
    results.filter((r) => r.category === "learning"),
  );
  printSection(
    "Patterns",
    results.filter((r) => r.category === "pattern"),
  );
}

function main() {
  const { categories, limit, query } = parseArgs(process.argv.slice(2));

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

  printResults(query, results);
}

main();
