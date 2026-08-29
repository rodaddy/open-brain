// The runtime closure of src/ under server/main.ts.
//
// Walks runtime imports from server/main.ts over tracked, non-test .ts files
// and prints every src/ file it can reach. Type-only edges (`import type`,
// `export type`) are excluded -- they vanish at build time and do not keep a
// file alive. Dynamic `import()` edges ARE followed: they run.
//
// BASELINE: 67 src/ files at 42944000 (2026-08-29), the L5 starting number for
// issue 864. Every move lane lowers it and none may raise it.
//
//   bun scripts/src-runtime-closure.ts            one path per line, sorted
//   bun scripts/src-runtime-closure.ts --count    only the number
//   bun scripts/src-runtime-closure.ts --parents  path, BFS parent, importers
//
// The repo root comes from `git rev-parse --show-toplevel`, so the script is
// correct from any working directory inside a checkout. Exit 0.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";

const ENTRY = "server/main.ts";

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function trackedSourceFiles(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "*.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  return listed
    .split("\n")
    .filter((f) => f.length > 0 && !/\.(test|spec)\.ts$/.test(f));
}

function resolveSpec(
  root: string,
  tracked: ReadonlySet<string>,
  from: string,
  spec: string,
): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(join(root, from)), spec);
  const candidates = [base, `${base}.ts`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const rel = relative(root, candidate);
    if (tracked.has(rel)) return rel;
  }
  return null;
}

function isTypeOnlyEdge(match: string): boolean {
  return /^\s*(?:import|export)\s+type\b/.test(match);
}

function runtimeDeps(
  root: string,
  tracked: ReadonlySet<string>,
  file: string,
): string[] {
  const text = readFileSync(join(root, file), "utf8");
  const found: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let match = IMPORT_RE.exec(text);
  while (match !== null) {
    if (!isTypeOnlyEdge(match[0])) {
      const spec = match[1] ?? match[2] ?? match[3];
      const resolved =
        spec === undefined ? null : resolveSpec(root, tracked, file, spec);
      if (resolved !== null) found.push(resolved);
    }
    match = IMPORT_RE.exec(text);
  }
  return [...new Set(found)];
}

function buildGraph(
  root: string,
  files: readonly string[],
  tracked: ReadonlySet<string>,
): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const file of files) deps.set(file, runtimeDeps(root, tracked, file));
  return deps;
}

function visitFile(
  deps: ReadonlyMap<string, string[]>,
  parent: Map<string, string>,
  file: string,
): string[] {
  const discovered: string[] = [];
  for (const dep of deps.get(file) ?? []) {
    if (parent.has(dep)) continue;
    parent.set(dep, file);
    discovered.push(dep);
  }
  return discovered;
}

function breadthFirstParents(deps: ReadonlyMap<string, string[]>): Map<string, string> {
  const parent = new Map<string, string>([[ENTRY, ""]]);
  let frontier = [ENTRY];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const file of frontier) next.push(...visitFile(deps, parent, file));
    frontier = next;
  }
  return parent;
}

function importersOf(
  deps: ReadonlyMap<string, string[]>,
  reached: ReadonlyMap<string, string>,
  target: string,
): string[] {
  return [...reached.keys()].filter((p) => (deps.get(p) ?? []).includes(target));
}

function main(): void {
  const root = repoRoot();
  const files = trackedSourceFiles(root);
  const tracked = new Set(files);
  const deps = buildGraph(root, files, tracked);
  const reached = breadthFirstParents(deps);
  const live = [...reached.keys()].filter((f) => f.startsWith("src/")).sort();

  const mode = process.argv[2] ?? "";
  if (mode === "--count") {
    console.log(String(live.length));
    return;
  }
  for (const file of live) {
    if (mode === "--parents") {
      const importers = importersOf(deps, reached, file).join(",");
      console.log(`${file}\tvia=${reached.get(file) ?? ""}\timporters=${importers}`);
    } else {
      console.log(file);
    }
  }
}

main();
