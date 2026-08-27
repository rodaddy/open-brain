// brief-pack: bounded lane-brief assembler. See ../README.md.
// Exit 0 under budget, 1 OVER BUDGET (nothing written), 3 harness error.
import { readFileSync, writeFileSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";

type Entry = { date: string; text: string };
type Decision = { n: number; date: string; item: string; resolution: string };
type Section = { title: string; body: string };

const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "will", "must", "when", "what",
  "then", "than", "them", "they", "into", "over", "your", "been", "were",
  "does", "each", "only", "also", "such", "same", "some", "more", "most",
  "make", "made", "used", "using", "before", "after", "which", "there",
  "their", "would", "could", "should", "about", "every", "never", "always",
]);

function die(msg: string): never {
  process.stderr.write("HARNESS ERROR: " + msg + "\n");
  process.exit(3);
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  const words = s.toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function score(task: Set<string>, text: string): number {
  let n = 0;
  for (const w of tokens(text)) if (task.has(w)) n += 1;
  return n;
}

function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      throw err;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mustRead(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    die("cannot read " + label + ": " + path);
  }
}

// --- args -------------------------------------------------------------
const argv = process.argv.slice(2);
const opts: Record<string, string> = {};
// Every accepted flag, by name. An unknown flag used to be stored and ignored,
// so a typo (`--budget-token`, `--report-headings`) silently shipped a brief
// built entirely from defaults while exiting 0 (adversarial review F4,
// 2026-08-27). A misspelled budget is exactly the case where a silent default
// is worst.
const KNOWN_FLAGS: string[] = [
  "task",
  "lane-contract",
  "done-means",
  "controller-contract",
  "decisions",
  "loop-policy",
  "budget-tokens",
  "max-tightenings",
  "max-decisions",
  "report-heading",
  "out",
];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.slice(0, 2) !== "--") die("unexpected argument: " + a);
  const key = a.slice(2);
  if (KNOWN_FLAGS.indexOf(key) === -1) {
    die("unknown flag --" + key + "; known flags are --" + KNOWN_FLAGS.join(" --"));
  }
  const val = argv[i + 1];
  if (val === undefined) die("missing value for --" + key);
  opts[key] = val;
  i += 1;
}
for (const req of ["task", "lane-contract", "done-means"]) {
  if (!opts[req]) die("missing required --" + req);
}
const budget = Number(opts["budget-tokens"] ?? "8000");
const maxTightenings = Number(opts["max-tightenings"] ?? "8");
const maxDecisions = Number(opts["max-decisions"] ?? "5");
if (!Number.isFinite(budget) || !Number.isFinite(maxTightenings) || !Number.isFinite(maxDecisions)) {
  die("numeric option is not a number");
}
// A cap of 0 packed "(none)" at exit 0 — the same vacuous brief the
// Tightenings guard exists to stop, just reached through a flag. A negative
// cap was worse: slice(0, -1) silently dropped exactly one entry and looked
// like a pass (adversarial review F1 and F4, 2026-08-27).
if (maxTightenings < 1) die("--max-tightenings must be at least 1, got " + opts["max-tightenings"]);
if (maxDecisions < 0) die("--max-decisions must be 0 or more, got " + opts["max-decisions"]);

const taskText = opts.task === "-" ? readStdin() : mustRead(opts.task, "--task");
if (taskText.trim() === "") die("--task is empty");
const contract = mustRead(opts["lane-contract"], "--lane-contract");
const doneMeans = mustRead(opts["done-means"], "--done-means");

// --- parse ------------------------------------------------------------
function sectionOf(src: string, heading: string): string | null {
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === heading) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].slice(0, 3) === "## ") break;
    body.push(lines[i]);
  }
  return body.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

// First level-2 heading whose text matches /report/i, e.g.
// "## Lane report schema" or "## Required lane report format".
function findReportHeading(src: string): string | null {
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t.slice(0, 3) !== "## ") continue;
    if (/report/i.test(t.slice(3))) return t;
  }
  return null;
}

const tighteningsSection = sectionOf(contract, "## Tightenings");
if (tighteningsSection === null) {
  process.stderr.write("ABSENT: no \"## Tightenings\" section in " + opts["lane-contract"] + "\n");
  process.exit(3);
}
// process.exit is untyped here (no @types/node), so the null branch above
// does not narrow for the checker; the ?? is unreachable at runtime.
const tighteningsBody: string = tighteningsSection ?? "";
const groundRules = sectionOf(contract, "## Ground rules") ?? "(no ## Ground rules section)";

function parseEntries(body: string): Entry[] {
  const lines = body.split("\n");
  const out: Entry[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const text = cur.join("\n").replace(/\s+$/, "");
    const m = text.match(/^(?:- \*\*|### +)(\d{4}-\d{2}-\d{2})/);
    out.push({ date: m ? m[1] : "0000-00-00", text });
    cur = [];
  };
  for (const line of lines) {
    // Two entry shapes, same unit as ratchet-bound: a "- **YYYY-MM-DD" bullet,
    // or a "### YYYY-MM-DD" heading whose block (bullets included) is one entry.
    if (/^(?:- \*\*|### +)\d{4}-\d{2}-\d{2}/.test(line)) {
      flush();
      cur = [line];
    } else if (cur.length > 0) {
      cur.push(line);
    }
  }
  flush();
  return out;
}

const entries = parseEntries(tighteningsBody);

// Vacuous green: the section has substance but nothing parsed as an entry, so
// the brief would ship "## Tightenings (ranked)" / "(none)" at exit 0 while the
// contract's real rules sat unread. Same guard ratchet-bound carries, same
// reason (adversarial review fixture f2-unrecognised-shape.md, 2026-08-27:
// three live rules as plain bullets, zero ranked, exit 0).
const tighteningsContent: number = tighteningsBody
  .split("\n")
  .filter(function (l: string): boolean {
    const t = l.trim();
    return t !== "" && t.slice(0, 4) !== "<!--" && t.slice(0, 3) !== "-->";
  }).length;
if (entries.length === 0 && tighteningsContent > 0) {
  process.stderr.write(
    "HARNESS ERROR: 0 Tightenings entries recognized in a non-empty section (" +
      tighteningsContent +
      " content lines); entries must open with \"- **YYYY-MM-DD\" or \"### YYYY-MM-DD\"\n",
  );
  process.exit(3);
}

function parseDecisions(src: string): Decision[] {
  const out: Decision[] = [];
  for (const line of src.split("\n")) {
    if (line.trim().slice(0, 1) !== "|") continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 9) continue;
    if (/^-+$/.test(cells[0].replace(/:/g, ""))) continue;
    const n = Number(cells[0].replace("#", ""));
    if (!Number.isFinite(n)) continue;
    if (cells[3].toUpperCase() !== "RATIFIED") continue;
    out.push({ n, date: cells[1], item: cells[2], resolution: cells[4] });
  }
  return out;
}

const decisions: Decision[] = opts.decisions
  ? parseDecisions(mustRead(opts.decisions, "--decisions"))
  : [];
const loopPolicy = opts["loop-policy"]
  ? mustRead(opts["loop-policy"], "--loop-policy")
  : null;

// Default the controller contract to the lane contract's own directory, so a
// repo that does not use the Development _DOCS/ layout still resolves.
// Candidates in order: the lane contract's own directory first (repo-shaped,
// works outside the Development _DOCS/ layout), then the historical
// _DOCS/controller-contract.md relative to this tool.
function readable(path: string): boolean {
  try {
    readFileSync(path, "utf8");
    return true;
  } catch {
    return false;
  }
}
const ctrlCandidates = [
  resolve(dirname(resolve(opts["lane-contract"])), "controller-contract.md"),
  new URL("../../../../../../_DOCS/controller-contract.md", import.meta.url).pathname,
];
let ctrlResolved = "";
if (opts["controller-contract"]) {
  ctrlResolved = opts["controller-contract"];
} else {
  for (const c of ctrlCandidates) {
    if (readable(c)) {
      ctrlResolved = c;
      break;
    }
  }
  if (ctrlResolved === "") {
    die("no --controller-contract given and none at " + ctrlCandidates.join(" or "));
  }
}
const ctrlPath = ctrlResolved;
const ctrlSrc = mustRead(ctrlPath, "--controller-contract");
const reportHeading = opts["report-heading"]
  ? (opts["report-heading"].slice(0, 3) === "## "
    ? opts["report-heading"]
    : "## " + opts["report-heading"])
  : findReportHeading(ctrlSrc);
if (reportHeading === null) {
  process.stderr.write("ABSENT: no level-2 heading matching /report/i in " + ctrlPath + "\n");
  process.exit(3);
}
const headingUsed: string = reportHeading ?? "";
const schema = sectionOf(ctrlSrc, headingUsed)
  ?? die("controller contract has no \"" + headingUsed + "\" section");

function commentHeader(src: string): string {
  const lines = src.split("\n");
  let i = 0;
  if (lines[0] && lines[0].slice(0, 2) === "#!") i = 1;
  const out: string[] = [];
  for (; i < lines.length; i += 1) {
    if (lines[i].slice(0, 1) !== "#") break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// --- rank -------------------------------------------------------------
const taskTokens = tokens(taskText);
const rankedT = entries
  .map((e, i) => ({ e, s: score(taskTokens, e.text), i }))
  .sort((a, b) => (b.s - a.s) || (a.e.date < b.e.date ? 1 : a.e.date > b.e.date ? -1 : a.i - b.i));
const inT = rankedT.slice(0, maxTightenings);
const outT = rankedT.slice(maxTightenings);

const rankedD = decisions
  .map((d, i) => ({ d, s: score(taskTokens, d.item + " " + d.resolution), i }))
  .sort((a, b) => (b.s - a.s) || (a.d.date < b.d.date ? 1 : a.d.date > b.d.date ? -1 : a.i - b.i));
const inD = rankedD.slice(0, maxDecisions);
const outD = rankedD.slice(maxDecisions);

// --- assemble ---------------------------------------------------------
const sections: Section[] = [];
sections.push({ title: "Task", body: "## Task\n\n" + taskText.replace(/\s+$/, "") });
sections.push({
  title: "Done-means",
  body: "## Done-means\n\npath: " + opts["done-means"] + "\ninvocation: `bash "
    + opts["done-means"] + "`\n\n```\n" + commentHeader(doneMeans) + "\n```",
});
sections.push({
  title: "Standing rules",
  body: "## Standing rules\n\nFull contract: " + opts["lane-contract"] + "\n\n" + groundRules,
});
sections.push({
  title: "Tightenings (ranked)",
  body: "## Tightenings (ranked)\n\n" + (inT.length === 0
    ? "(none)"
    : inT.map((r) => r.e.text).join("\n\n")),
});
if (opts.decisions) {
  sections.push({
    title: "Decisions (ranked)",
    body: "## Decisions (ranked)\n\n" + (inD.length === 0
      ? "(none)"
      : inD.map((r) => "- #" + r.d.n + " " + r.d.item + ": " + r.d.resolution).join("\n")),
  });
}
if (loopPolicy !== null) {
  sections.push({ title: "Loop policy", body: "## Loop policy\n\n" + loopPolicy.replace(/\s+$/, "") });
}
sections.push({ title: "Report format", body: "## Report format\n\n" + schema });

const excluded: string[] = [];
for (const r of outT) excluded.push("- " + r.e.date + " " + r.e.text.replace(/\n/g, " ").slice(0, 80));
for (const r of outD) {
  excluded.push("- " + r.d.date + " " + ("#" + r.d.n + " " + r.d.item + ": " + r.d.resolution).slice(0, 80));
}
sections.push({
  title: "Excluded (available on request)",
  body: "## Excluded (available on request)\n\n" + (excluded.length === 0 ? "(none)" : excluded.join("\n")),
});

const bodyText = sections.map((s) => s.body).join("\n\n");
// header token count includes itself; compute with a placeholder of stable width.
const headerFor = (used: number) =>
  "# Lane brief\n\nbudget: " + used + "/" + budget + " tokens (ceil chars/4)"
  + " | report-format: " + headingUsed;
let used = estTokens(headerFor(0) + "\n\n" + bodyText);
used = estTokens(headerFor(used) + "\n\n" + bodyText);
const out = headerFor(used) + "\n\n" + bodyText + "\n";

if (used > budget) {
  process.stderr.write("OVER BUDGET: " + used + " > " + budget + "\n");
  process.stderr.write("section                          tokens\n");
  for (const s of sections) {
    const pad = (s.title + "                                ").slice(0, 32);
    process.stderr.write(pad + " " + estTokens(s.body) + "\n");
  }
  process.stderr.write(("header                          ").slice(0, 32) + " " + estTokens(headerFor(used)) + "\n");
  process.exit(1);
}

process.stdout.write(out);
if (opts.out) {
  try {
    writeFileSync(opts.out, out, "utf8");
  } catch {
    die("cannot write --out: " + opts.out);
  }
}
process.exit(0);
