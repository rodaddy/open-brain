// brief-pack: bounded lane-brief assembler. See ../README.md.
// Exit 0 under budget, 1 OVER BUDGET (nothing written), 3 harness error.
import { readFileSync, writeFileSync, readSync } from "node:fs";

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
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.slice(0, 2) !== "--") die("unexpected argument: " + a);
  const key = a.slice(2);
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
    const m = text.match(/^- \*\*(\d{4}-\d{2}-\d{2})/);
    out.push({ date: m ? m[1] : "0000-00-00", text });
    cur = [];
  };
  for (const line of lines) {
    if (/^- \*\*\d{4}-\d{2}-\d{2}/.test(line)) {
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

const ctrlPath = opts["controller-contract"]
  ?? new URL("../../../../../../_DOCS/controller-contract.md", import.meta.url).pathname;
const schema = sectionOf(mustRead(ctrlPath, "--controller-contract"), "## Lane report schema")
  ?? die("controller contract has no \"## Lane report schema\" section");

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
  "# Lane brief\n\nbudget: " + used + "/" + budget + " tokens (ceil chars/4)";
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
