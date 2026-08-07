/**
 * Chart the issue dependency graph that already exists in prose, and report
 * the frontier: what is actually workable right now.
 *
 * WHY. The structure is ALREADY WRITTEN, in the issue bodies, by hand:
 * `Parent: #293`, `Program: #320`, `Depends on: #391`, `Part of #389`,
 * `Blocked by #435 and #436`. Measured 2026-08-07 across 49 open issues: 11
 * declare a Program, 4 declare `Parent: #293`, and several declare real
 * `Depends on:` chains (#394->#391, #391->#390, #347->six issues). GitHub's
 * NATIVE graph held 2 blocked_by edges and 1 blocking edge for all of it.
 *
 * That gap is the whole problem. Because the ordering lives in prose, every
 * session re-reads 49 bodies to rediscover what the issues already state, and
 * the only automated signal we had was `stale-blockers.ts` — a regex over
 * `#NNN` that cannot tell "blocked by" from "mentioned in passing". On
 * 2026-08-06 it flagged nine issues as all-refs-closed; four of them (#296,
 * #298, #299, #300) were unbuilt P1/P2/P3 work whose PARENT had closed, and
 * seven more (#400's children) are marked "do not implement" on purpose.
 *
 * WHAT IT IS NOT. This never closes, merges, deletes, or edits issue bodies.
 * It charts edges and reports. A frontier entry is a CANDIDATE for work, not a
 * verdict that the work is done or even that it should start — the issue's own
 * acceptance criteria still decide that, and a human still decides priority.
 *
 * HIERARCHY IS NOT BLOCKING. `Parent:`/`Program:`/`Part of` say where an issue
 * BELONGS; `Depends on:`/`Blocked by:` say what must land FIRST. A child whose
 * parent is still open is usually workable — treating containment as blocking
 * is what made the old signal misleading in the opposite direction. Both
 * readings are computed and printed so the difference is visible, not assumed.
 *
 * PARKED IS A FIRST-CLASS STATE, NOT A FILTER. #400 SHAPE and its seven
 * children say "PARKED BY DESIGN — do not implement" and "Question, not work."
 * They are not noise to hide; they are work whose gate is an operator DECISION
 * rather than a dependency. Operator, 2026-08-07: "if it is parked by design,
 * then that is actually something that should be included and on purpose." So
 * everything is reported, and the graph records WHY a thing is not moving.
 *
 *   bun run scripts/issue-graph.ts              # report only, writes nothing
 *   bun run scripts/issue-graph.ts --chart      # DRY RUN of the edge writes
 *   bun run scripts/issue-graph.ts --chart --write   # actually write edges
 */

type IssueRow = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string }[];
  parent: { number: number } | null;
  blockedBy: { totalCount: number; nodes: { number: number }[] };
  blocking: { totalCount: number; nodes: { number: number }[] };
};

type Edge = {
  from: number;
  to: number;
  kind: "depends" | "hierarchy";
  literal: string;
  /**
   * How the edge was found. A `field` edge came from a labelled declaration at
   * the start of a line — the author wrote it AS a declaration, so it charts
   * automatically. A `prose` edge was matched mid-sentence, which is a judgment
   * call about English and never writes without explicit confirmation.
   *
   * Measured 2026-08-07: #393's "this issue depends on the capture and
   * promotion path actually running (#380, #382, #389)" yields three prose
   * edges that are SEMANTICALLY CORRECT. That is exactly why they cannot be
   * trusted blindly — the pattern cannot distinguish that sentence from
   * "unlike #500, which depends on X", and a wrong blocking edge silently
   * hides workable work, the failure this tool exists to remove.
   */
  source: "field" | "prose";
};

const REPO = "rodaddy/open-brain";

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args[0]} failed: ${err.trim()}`);
  return out;
}

/**
 * Declared-edge patterns, taken from what issues in THIS repo actually write.
 * Each pattern is anchored to line start so a `#NNN` inside a sentence is not
 * mistaken for a declaration — that conflation is the defect in the regex
 * sweep this script replaces.
 */
const DECLARATIONS: { re: RegExp; kind: Edge["kind"]; source: Edge["source"] }[] = [
  // Line-anchored field form, optionally bolded:
  //   "Depends on: #391"      "**Depends on:** #344, #345, #346"
  // `\*{0,2}` before and after the label covers the bold variants; #347
  // writes `**Depends on:**` and was missed by a stricter pattern.
  // The COLON is the signal, not the line start. Verified 2026-08-07: #393 and
  // #384 both wrap a sentence such that "depends on ..." begins at column 0, so
  // line-anchoring alone cannot distinguish a declaration from prose that
  // happened to wrap there. `Depends on:` is a field the author wrote as a
  // declaration; `depends on the capture path ...` is English.
  { re: /^\s*\*{0,2}Depends on\*{0,2}\s*:\s*(.+)$/gim, kind: "depends", source: "field" },
  { re: /^\s*\*{0,2}Blocked by\*{0,2}\s*:\s*(.+)$/gim, kind: "depends", source: "field" },
  // #437 writes "**Blocked by #435** (verify ...)" — bolded, no colon, but the
  // bold markers around the label ARE the authorial declaration marker.
  { re: /^\s*\*\*Blocked by\s+((?:#\d{2,4}[^*]*?)+)\*\*/gim, kind: "depends", source: "field" },
  { re: /^\s*\*{0,2}Parent(?:\s+epic)?\*{0,2}:?\s*(.+)$/gim, kind: "hierarchy", source: "field" },
  { re: /^\s*\*{0,2}Program\*{0,2}:?\s*(.+)$/gim, kind: "hierarchy", source: "field" },
  { re: /^\s*\*{0,2}Part of\*{0,2}\s*(.+)$/gim, kind: "hierarchy", source: "field" },
  // Mid-sentence prose forms. #437 writes "Blocked by #435 and #436." inside a
  // paragraph and #393 writes "this issue depends on the capture and promotion
  // path actually running (#380, #382, #389)" — both real dependencies that a
  // line-anchored pattern alone reports as workable.
  //
  // Scoped deliberately: the reference list must follow the phrase IMMEDIATELY,
  // so the two corpus cases naming a CONCEPT rather than an issue produce no
  // edge (verified 2026-08-07: #446 "blocked by the writer question", #282
  // "blocked by the current 1GB storage ..." — neither yields a reference).
  //
  // These are `prose`, so they REPORT and never chart without confirmation.
  { re: /\bBlocked by\s+((?:#\d{2,4}(?:\s*(?:,|and)\s*)?)+)/gi, kind: "depends", source: "prose" },
  { re: /\bdepends on\b[^.\n]*?\(?((?:#\d{2,4}(?:\s*(?:,|and)\s*)?)+)\)?/gi, kind: "depends", source: "prose" },
];

/** "#435 and #436", "#344, #345, #346" -> [435, 436] / [344, 345, 346] */
function refsIn(text: string): number[] {
  return [...text.matchAll(/#(\d{2,4})\b/g)].map((m) => Number(m[1]));
}

const PARKED_MARKERS = [
  /PARKED BY DESIGN/i,
  /Question, not work/i,
  /Do not implement/i,
  /\bDEFERRED\b/,
];

function parkedReason(issue: IssueRow): string | null {
  const body = issue.body ?? "";
  for (const marker of PARKED_MARKERS) {
    const hit = body.match(marker);
    if (hit) return hit[0];
  }
  if (issue.labels.some((l) => l.name === "question")) return "label:question";
  return null;
}

const args = new Set(Bun.argv.slice(2));
const doChart = args.has("--chart");
const doWrite = args.has("--write");

const open: IssueRow[] = JSON.parse(
  await gh([
    "issue", "list", "--state", "open", "-L", "500", "--json",
    "number,title,body,state,labels,parent,blockedBy,blocking",
  ]),
);
const allStates: { number: number; state: string }[] = JSON.parse(
  await gh(["issue", "list", "--state", "all", "-L", "1000", "--json", "number,state"]),
);

const state = new Map<number, string>();
for (const row of allStates) state.set(row.number, row.state);

const openByNumber = new Map(open.map((i) => [i.number, i]));

// --- parse declared edges -------------------------------------------------

const declared: Edge[] = [];
for (const issue of open) {
  const body = issue.body ?? "";
  for (const { re, kind, source } of DECLARATIONS) {
    re.lastIndex = 0;
    for (const match of body.matchAll(re)) {
      const line = match[1] ?? "";
      for (const to of refsIn(line)) {
        if (to === issue.number) continue;
        declared.push({
          from: issue.number, to, kind, source,
          literal: match[0].trim().replace(/\s+/g, " "),
        });
      }
    }
  }
}

// Dedupe. A `field` declaration WINS over a `prose` match for the same pair:
// if the author wrote it as a real declaration anywhere in the body, that is
// the stronger evidence and the edge charts automatically. Sorting field-first
// before the filter is what makes the first-seen entry the authoritative one.
const seen = new Set<string>();
const edges = declared
  .slice()
  .sort((a, b) => (a.source === b.source ? 0 : a.source === "field" ? -1 : 1))
  .filter((e) => {
    const key = `${e.from}->${e.to}:${e.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

const dependsEdges = edges.filter((e) => e.kind === "depends");
const hierarchyEdges = edges.filter((e) => e.kind === "hierarchy");

// --- frontier, computed BOTH ways ----------------------------------------

function openBlockersOf(n: number, kinds: Edge["kind"][]): number[] {
  return edges
    .filter((e) => e.from === n && kinds.includes(e.kind))
    .map((e) => e.to)
    .filter((to) => state.get(to) === "OPEN")
    .filter((to, i, arr) => arr.indexOf(to) === i)
    .sort((a, b) => a - b);
}

type FrontierRow = {
  issue: IssueRow;
  strictBlockers: number[];
  containmentBlockers: number[];
  parked: string | null;
};

const rows: FrontierRow[] = open
  .map((issue) => ({
    issue,
    strictBlockers: openBlockersOf(issue.number, ["depends"]),
    containmentBlockers: openBlockersOf(issue.number, ["depends", "hierarchy"]),
    parked: parkedReason(issue),
  }))
  .sort((a, b) => a.issue.number - b.issue.number);

const strictFrontier = rows.filter((r) => r.strictBlockers.length === 0);
const containmentFrontier = rows.filter((r) => r.containmentBlockers.length === 0);

// --- report ---------------------------------------------------------------

const log = (s = "") => console.log(s);

log(`Open issues: ${open.length}`);
log(`Declared edges parsed: ${edges.length}  (depends=${dependsEdges.length} hierarchy=${hierarchyEdges.length})`);

const nativeBlockedBy = open.filter((i) => i.blockedBy.totalCount > 0).length;
const nativeParent = open.filter((i) => i.parent !== null).length;
log(`Native graph today: ${nativeBlockedBy} issue(s) with blocked_by, ${nativeParent} with a parent`);
log();

/**
 * Which epic/program an issue belongs to, for the frontier tag.
 *
 * Operator decision 2026-08-07: hierarchy never blocks, but the frontier line
 * SHOWS its epic. Belonging is context worth seeing; it is not a gate. Without
 * the tag a flat list loses the grouping that made the blocking reading look
 * attractive in the first place.
 */
function belongsTo(n: number): string {
  const native = openByNumber.get(n)?.parent?.number;
  const declaredParent = edges.find((e) => e.from === n && e.kind === "hierarchy")?.to;
  const owner = native ?? declaredParent;
  if (owner === undefined) return "";
  const title = openByNumber.get(owner)?.title ?? "";
  const short = title.replace(/^\[(Epic|Program)\]\s*/i, "").split(/[:—-]/)[0]!.trim();
  return `  [in #${owner}${short ? ` ${short.slice(0, 22)}` : ""}]`;
}

function frontierLine(r: FrontierRow): string {
  const parked = r.parked ? `  [PARKED: ${r.parked}]` : "";
  return `  #${r.issue.number} ${r.issue.title.slice(0, 72)}${belongsTo(r.issue.number)}${parked}`;
}

log("=== FRONTIER A — hierarchy is NOT blocking (depends-on only) ===");
log(`${strictFrontier.length} of ${open.length} open issues have no open dependency.`);
log("Epic tags are CONTEXT, not gates: an open epic closes BECAUSE its children");
log("land, so treating containment as blocking deadlocks by construction.");
log();
for (const r of strictFrontier) log(frontierLine(r));
log();

log("=== FRONTIER B — hierarchy ALSO blocks (parent/program count) ===");
log(`${containmentFrontier.length} of ${open.length} open issues have no open dependency or open parent.`);
log();
for (const r of containmentFrontier) log(frontierLine(r));
log();

const blocked = rows.filter((r) => r.strictBlockers.length > 0);
if (blocked.length) {
  log("=== BLOCKED (real `Depends on:` / `Blocked by:` with an OPEN blocker) ===");
  for (const r of blocked) {
    log(`  #${r.issue.number} blocked by ${r.strictBlockers.map((n) => `#${n}`).join(" ")}`);
  }
  log();
}

const parkedRows = rows.filter((r) => r.parked);
if (parkedRows.length) {
  log("=== PARKED BY DESIGN — included on purpose, gated by a DECISION not a dependency ===");
  for (const r of parkedRows) {
    log(`  #${r.issue.number} ${r.issue.title.slice(0, 70)}  [${r.parked}]`);
  }
  log();
}

// --- charting -------------------------------------------------------------

if (!doChart) {
  log("Report only. Re-run with --chart to see the edge writes this would make.");
  process.exit(0);
}

/** Native dependencies need the blocker's numeric DATABASE id, not #number. */
const dbIdCache = new Map<number, number>();
async function dbId(n: number): Promise<number> {
  const cached = dbIdCache.get(n);
  if (cached !== undefined) return cached;
  const id = Number(JSON.parse(await gh(["api", `repos/${REPO}/issues/${n}`, "--jq", ".id"])));
  dbIdCache.set(n, id);
  return id;
}

const uncharted = dependsEdges.filter((e) => {
  const issue = openByNumber.get(e.from);
  if (!issue) return false;
  return !issue.blockedBy.nodes.some((node) => node.number === e.to);
});

// Only FIELD declarations chart automatically. A prose match is a judgment
// call about English, and a wrong blocking edge silently hides workable work.
const missing = uncharted.filter((e) => e.source === "field");
const loose = uncharted.filter((e) => e.source === "prose");

log("=== CHARTING: labelled declarations -> native blocked_by edges ===");
log(`${dependsEdges.length} declared, ${missing.length} chartable and missing.`);
log();
for (const e of missing) {
  log(`  #${e.from} blocked_by #${e.to}   (declared: "${e.literal.slice(0, 60)}")`);
}
log();

if (loose.length) {
  log("=== LOOSE MATCH (verify) — found in PROSE, never charted automatically ===");
  log("These may well be real. #393's are. But the pattern cannot tell a genuine");
  log("prose dependency from an incidental mention, so a human confirms each one.");
  log();
  for (const e of loose) {
    log(`  #${e.from} blocked_by #${e.to}?   "...${e.literal.slice(0, 74)}..."`);
  }
  log();
  log(`To chart one, add a labelled field to the issue body, or write it by hand:`);
  log(`  gh api --method POST repos/${REPO}/issues/<n>/dependencies/blocked_by -F issue_id=<db-id>`);
  log();
}

if (hierarchyEdges.length) {
  log("=== HIERARCHY (reported, NOT written as blocking) ===");
  for (const e of hierarchyEdges) {
    const nativeParent = openByNumber.get(e.from)?.parent?.number;
    const already = nativeParent === e.to ? "  [already native parent]" : "";
    log(`  #${e.from} belongs to #${e.to}${already}   (declared: "${e.literal.slice(0, 50)}")`);
  }
  log();
}

if (!doWrite) {
  log("DRY RUN — nothing was written. Re-run with --chart --write to apply.");
  process.exit(0);
}

let written = 0;
let failed = 0;
for (const e of missing) {
  try {
    const blockerId = await dbId(e.to);
    await gh([
      "api", "--method", "POST",
      `repos/${REPO}/issues/${e.from}/dependencies/blocked_by`,
      "-F", `issue_id=${blockerId}`,
    ]);
    log(`  wrote #${e.from} blocked_by #${e.to}`);
    written++;
  } catch (err) {
    log(`  FAILED #${e.from} blocked_by #${e.to}: ${(err as Error).message.slice(0, 120)}`);
    failed++;
  }
}
log();
log(`Wrote ${written} edge(s), ${failed} failure(s). Nothing was closed, merged, or deleted.`);
