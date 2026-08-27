// Decisions-ledger doctor (v1.3-beta). Node 24 native type stripping, no deps.
// stdin/args: argv[2] = ledger path, argv[3] = JSON string of git paths (may be "[]"),
// argv[4] = "1" when git evidence is available, "0" when the wrapper could not look.
// argv[5] = optional --section heading text (exact, e.g. "## Ledger"); "" when absent.
// Exit: 0 pass, 1 clause failure, 3 harness error.

import { readFileSync } from "node:fs";

type Row = {
  num: number;      // parsed row number from column 1, NaN if unparseable
  line: number;     // 1-based source line
  cells: string[];
};

const COLUMNS: string[] = [
  "#", "Date", "Item", "State", "Resolution",
  "Rejected", "Falsifier", "Supersedes", "Retires",
];
const STATES: string[] = ["OPEN", "RATIFIED", "HELD", "REVERSED", "SUPERSEDED"];

function harness(msg: string): never {
  process.stdout.write("HARNESS ERROR: " + msg + "\n");
  process.exit(3);
}

function splitRow(raw: string): string[] {
  let s: string = raw.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map(function (c) { return c.trim(); });
}

function isSeparator(cells: string[]): boolean {
  if (cells.length === 0) return false;
  for (const c of cells) {
    if (!/^:?-{1,}:?$/.test(c.replace(/\s/g, ""))) return false;
  }
  return true;
}

const path: string | undefined = process.argv[2];
if (!path) harness("no ledger path given");

let text: string;
try {
  text = readFileSync(path as string, "utf8");
} catch {
  harness("cannot read ledger: " + path);
}

let gitPaths: string[] = [];
let gitOk: boolean = process.argv[4] === "1";
if (gitOk) {
  try {
    gitPaths = JSON.parse(process.argv[3] || "[]") as string[];
  } catch {
    harness("bad git path payload");
  }
}

const section: string = process.argv[5] || "";

const lines: string[] = text.split("\n");

// A table header is a line with a pipe that is neither blank nor a separator row.
function tableHeaderAt(i: number): string[] | null {
  if (lines[i].indexOf("|") === -1) return null;
  const cells: string[] = splitRow(lines[i]);
  if (cells.length < 2 || isSeparator(cells)) return null;
  return cells;
}

function headingLevel(raw: string): number {
  const m = /^(#{1,6})\s/.exec(raw.trim());
  return m ? m[1].length : 0;
}

// Table selection, in order:
//   (a) --section <heading>: the first table under that exact heading, up to the
//       next heading of the same or higher level;
//   (b) else the first table anywhere whose header row first cell is "#";
//   (c) else the first table in the file.
let headerIdx: number = -1;
let selectedVia: string = "";

if (section !== "") {
  const want: string = section.trim();
  let hIdx: number = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === want) { hIdx = i; break; }
  }
  if (hIdx === -1) harness("no heading " + section);
  const level: number = headingLevel(lines[hIdx]);
  for (let i = hIdx + 1; i < lines.length; i++) {
    const lv: number = headingLevel(lines[i]);
    if (lv > 0 && level > 0 && lv <= level) break;
    if (tableHeaderAt(i)) { headerIdx = i; break; }
  }
  if (headerIdx === -1) harness("no markdown table under heading " + section + " in " + path);
  selectedVia = "section";
} else {
  for (let i = 0; i < lines.length; i++) {
    const cells: string[] | null = tableHeaderAt(i);
    if (cells && cells[0].trim() === "#") { headerIdx = i; selectedVia = "hash-column"; break; }
  }
  if (headerIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (tableHeaderAt(i)) { headerIdx = i; selectedVia = "first"; break; }
    }
  }
  if (headerIdx === -1) harness("no markdown table found in " + path);
}

process.stdout.write("table: line " + (headerIdx + 1) + " via " + selectedVia + "\n");

const header: string[] = splitRow(lines[headerIdx]);
const failures: string[] = [];

// Clause 1: schema.
let schemaOk: boolean = header.length === COLUMNS.length;
if (schemaOk) {
  for (let i = 0; i < COLUMNS.length; i++) {
    if (header[i].toLowerCase() !== COLUMNS[i].toLowerCase()) { schemaOk = false; break; }
  }
}
if (!schemaOk) {
  process.stdout.write(
    "FAIL schema row " + (headerIdx + 1) + ": judged the table at line " + (headerIdx + 1) +
    " (selected via " + selectedVia + ") with header [" + header.join(" | ") +
    "] but v1.3-beta requires the nine columns [" + COLUMNS.join(" | ") +
    "]; this ledger needs MIGRATION to the v1.3-beta 9-column format before the doctor can judge it\n"
  );
  process.exit(1);
}

// Collect data rows.
const rows: Row[] = [];
for (let i = headerIdx + 1; i < lines.length; i++) {
  const raw: string = lines[i];
  if (raw.indexOf("|") === -1) {
    if (raw.trim() === "") continue;
    break;
  }
  const cells: string[] = splitRow(raw);
  if (isSeparator(cells)) continue;
  if (cells.length !== COLUMNS.length) {
    failures.push("FAIL schema row " + (i + 1) + ": " + cells.length + " cells, expected " + COLUMNS.length);
    continue;
  }
  rows.push({ num: parseInt(cells[0], 10), line: i + 1, cells: cells });
}
if (rows.length === 0) harness("table found but it has no data rows: " + path);

function id(r: Row): string { return isNaN(r.num) ? "@line" + r.line : String(r.num); }

const superseded: string[] = [];
for (const r of rows) {
  const s: string = r.cells[7];
  if (s !== "") {
    const refs: string[] = s.split(/[,\s]+/).filter(function (x) { return x !== ""; });
    for (const ref of refs) superseded.push(ref.replace(/^#/, ""));
  }
}

for (const r of rows) {
  const state: string = r.cells[3];
  const item: string = r.cells[2];
  const rejected: string = r.cells[5];
  const falsifier: string = r.cells[6];
  const sup: string = r.cells[7];
  const retires: string = r.cells[8];

  // Clause 7: state enum.
  if (STATES.indexOf(state) === -1) {
    failures.push("FAIL state row " + id(r) + ": \"" + state + "\" is not one of " + STATES.join(", "));
  }
  // Clause 3 / 4.
  if (state === "RATIFIED" && falsifier === "") {
    failures.push("FAIL falsifier row " + id(r) + ": RATIFIED row \"" + item + "\" has an empty Falsifier");
  }
  if (state === "RATIFIED" && rejected === "") {
    failures.push("FAIL rejected row " + id(r) + ": RATIFIED row \"" + item + "\" has an empty Rejected");
  }
  // Clause 5.
  if (sup !== "") {
    const refs: string[] = sup.split(/[,\s]+/).filter(function (x) { return x !== ""; });
    for (const ref of refs) {
      const n: string = ref.replace(/^#/, "");
      let found: boolean = false;
      for (const o of rows) { if (String(o.num) === n) { found = true; break; } }
      if (!found) {
        failures.push("FAIL supersedes row " + id(r) + ": references row " + n + ", which does not exist");
      }
    }
  }
  // Clause 6.
  if (retires !== "") {
    if (!gitOk) harness("clause 6 needs git evidence and none was available");
    let evidence: boolean = false;
    for (const p of gitPaths) {
      if (p.indexOf("scripts/done-means/") === 0 || p.indexOf("/scripts/done-means/") !== -1) { evidence = true; break; }
      if (p === retires) { evidence = true; break; }
    }
    if (!evidence) {
      failures.push(
        "FAIL retire-without-check row " + id(r) + ": Retires=\"" + retires +
        "\" but no changed path is under scripts/done-means/ nor equal to that path (" +
        gitPaths.length + " changed paths examined)"
      );
    }
  }
}

// Clause 2: conflicting RATIFIED rows on the same Item.
const groups: Array<{ key: string; rows: Row[] }> = [];
for (const r of rows) {
  if (r.cells[3] !== "RATIFIED") continue;
  const key: string = r.cells[2].trim().toLowerCase();
  let g: { key: string; rows: Row[] } | undefined;
  for (const x of groups) { if (x.key === key) { g = x; break; } }
  if (!g) { g = { key: key, rows: [] }; groups.push(g); }
  g.rows.push(r);
}
for (const g of groups) {
  if (g.rows.length < 2) continue;
  const live: Row[] = g.rows.filter(function (r) {
    return superseded.indexOf(String(r.num)) === -1;
  });
  if (live.length >= 2) {
    const ids: string[] = live.map(id);
    failures.push(
      "FAIL conflict row " + ids.join(",") + ": " + live.length +
      " live RATIFIED rows share Item \"" + live[0].cells[2] + "\" and none is superseded"
    );
  }
}

if (failures.length > 0) {
  for (const f of failures) process.stdout.write(f + "\n");
  process.stdout.write("ledger " + path + ": " + failures.length + " failure(s) across " + rows.length + " rows\n");
  process.exit(1);
}
process.stdout.write("ok: " + path + " — " + rows.length + " rows, 0 failures\n");
process.exit(0);
