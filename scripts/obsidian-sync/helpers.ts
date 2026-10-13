/** Naming, formatting, and project-resolution helpers for the Obsidian sync. */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { expectDefined } from "../test-support/expect-defined.ts";

export { expectDefined };

export const DEFAULT_VAULT = "/srv/shared/ObsidianVault";
export const UNTAGGED = "_untagged";

/**
 * Project grouping -- merge related sub-projects into a parent folder.
 * Key = parent folder name, Value = sub-project names that nest under it.
 * Files land at: Projects/<parent>/<sub>/Decisions|Thoughts|Sessions/
 */
export const PROJECT_GROUPS: Record<string, string[]> = {
  Acme: ["acme", "acme-ng", "acme-co", "acme-ingest", "acme-strat", "acme-trading"],
};

// Build reverse lookup: sub-project -> parent group
const GROUP_LOOKUP = new Map<string, string>();
for (const [parent, children] of Object.entries(PROJECT_GROUPS)) {
  for (const child of children) {
    GROUP_LOOKUP.set(child, parent);
  }
}

export function sanitize(name: string, maxLen = 80): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function fmtDate(iso: string): string {
  return expectDefined(new Date(iso).toISOString().split("T")[0], "date part");
}

export function shortId(uuid: string): string {
  return expectDefined(uuid.split("-")[0], "uuid prefix");
}

export function warmthStars(w: number | null): string {
  if (!w) return "—";
  return "★".repeat(w) + "☆".repeat(5 - w) + ` (${w}/5)`;
}

export function tagLine(tags: string[], prefix: string): string {
  const merged = [prefix, ...tags.filter((t) => t !== prefix)];
  return `[${merged.map((t) => `"${t}"`).join(", ")}]`;
}

export function listItems(items: string[] | unknown[]): string {
  if (!items || items.length === 0) return "—";
  return items.map((i) => `- ${String(i)}`).join("\n");
}

/** Find first tag matching a known project name, or UNTAGGED */
export function resolveProject(tags: string[], knownProjects: Set<string>): string {
  for (const tag of tags) {
    if (knownProjects.has(tag)) return tag;
    // Case-insensitive fallback
    const lower = tag.toLowerCase();
    for (const p of knownProjects) {
      if (p.toLowerCase() === lower) return p;
    }
  }
  return UNTAGGED;
}

/** Resolve vault path segments for a project: [parent, sub] or just [project] */
export function projectPath(project: string): string[] {
  const parent = GROUP_LOOKUP.get(project);
  if (parent) return [sanitize(parent), sanitize(project)];
  return [sanitize(project)];
}

/** Inject [[wikilinks]] for known people and project names in text */
export function injectLinks(
  text: string,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  let result = text;
  const names = [...Array.from(people.keys()), ...Array.from(projects)].sort(
    (a, b) => b.length - a.length,
  );

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, "gi");
    result = result.replace(re, `[[${name}]]`);
  }
  return result;
}

export function isSyncManaged(path: string): boolean {
  if (!existsSync(path)) return true;
  const content = readFileSync(path, "utf-8");
  return content.includes("ob_id:");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
