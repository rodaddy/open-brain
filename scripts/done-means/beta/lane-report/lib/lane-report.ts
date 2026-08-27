// Validator for the Development five-field lane report.
// Schema: _DOCS/controller-contract.md "## Lane report schema".
// Run directly by Node 24 native type stripping. No deps, no build step.

import { readFileSync } from "node:fs";

type Clause =
  | "field-set"
  | "empty-value"
  | "trailing-content"
  | "claim-states"
  | "verified"
  | "none-or-text";

type Failure = { clause: Clause; detail: string };

type Field = { key: string; value: string; line: number };

const KEYS: string[] = [
  "deliverable",
  "claim-states",
  "verified",
  "deviations",
  "lessons",
];

const STATES: string[] = ["RUNNING", "MERGED", "WRITTEN", "PROPOSED"];

// A key line: "<key>:" at line start, key drawn from the known set only.
// Anything else at column 0 is trailing/foreign content, judged by clause 1 or 3.
function keyAt(line: string): string | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  if (/^\s/.test(line)) return null; // indented => continuation
  const head = line.slice(0, colon);
  if (KEYS.indexOf(head) === -1) return null;
  return head;
}

export function parse(text: string): { fields: Field[]; tail: string[] } {
  const lines = text.split("\n");
  const fields: Field[] = [];
  const tail: string[] = [];
  let current: Field | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = keyAt(line);
    if (key !== null) {
      current = {
        key: key,
        value: line.slice(key.length + 1),
        line: i + 1,
      };
      fields.push(current);
      continue;
    }
    if (current === null) {
      // content before any key line
      if (line.trim() !== "") tail.push("line " + (i + 1) + ": " + line.trim());
      continue;
    }
    if (current.key === "lessons" && line.trim() !== "" && !/^\s/.test(line)) {
      // clause 3: non-blank, non-indented content after the lessons value
      tail.push("line " + (i + 1) + ": " + line.trim());
      continue;
    }
    // continuation line belongs to the preceding key
    current.value = current.value + "\n" + line;
  }
  return { fields: fields, tail: tail };
}

function valueOf(fields: Field[], key: string): string | null {
  const hit = fields.find(function (f) { return f.key === key; });
  return hit === undefined ? null : hit.value;
}

function nonEmpty(value: string): boolean {
  return value.trim() !== "";
}

export function validate(text: string): Failure[] {
  const failures: Failure[] = [];
  const parsed = parse(text);
  const fields = parsed.fields;
  const seen: string[] = fields.map(function (f) { return f.key; });

  // Clause 1: exactly the five keys, at line start, in order.
  const orderOk = seen.length === KEYS.length && seen.join("\u0000") === KEYS.join("\u0000");
  if (!orderOk) {
    failures.push({
      clause: "field-set",
      detail:
        "expected [" +
        KEYS.join(", ") +
        "] in order, found [" +
        (seen.length === 0 ? "<none>" : seen.join(", ")) +
        "]",
    });
  }

  // Clause 2: every value non-empty.
  for (let i = 0; i < fields.length; i++) {
    if (!nonEmpty(fields[i].value)) {
      failures.push({
        clause: "empty-value",
        detail: fields[i].key + ": empty value at line " + fields[i].line,
      });
    }
  }

  // Clause 3: nothing after the lessons value except blank lines.
  if (parsed.tail.length > 0) {
    failures.push({
      clause: "trailing-content",
      detail: parsed.tail.join(" | "),
    });
  }

  // Clause 4: claim-states pairs.
  const claims = valueOf(fields, "claim-states");
  if (claims !== null && nonEmpty(claims)) {
    const found: string[] = claims.match(/\b[A-Z][A-Z]+\b/g) || [];
    const good = found.filter(function (w) { return STATES.indexOf(w) !== -1; }).length;
    const bad = found.filter(function (w, i) {
      return STATES.indexOf(w) === -1 && found.indexOf(w) === i;
    });
    // A pair is "<artifact>: <STATE>" — require a colon before a valid state.
    const paired = /[^\s:][^:\n]*:\s*(RUNNING|MERGED|WRITTEN|PROPOSED)\b/.test(
      claims,
    );
    if (good === 0 || !paired) {
      failures.push({
        clause: "claim-states",
        detail:
          "no \"<artifact>: <STATE>\" pair with STATE in {" +
          STATES.join(" ") +
          "}",
      });
    }
    if (bad.length > 0) {
      failures.push({
        clause: "claim-states",
        detail: "disallowed state word(s): " + bad.join(", "),
      });
    }
  }

  // Clause 5: verified lines.
  const verified = valueOf(fields, "verified");
  if (verified !== null && nonEmpty(verified)) {
    const vlines = verified.split("\n");
    let ok = 0;
    for (let i = 0; i < vlines.length; i++) {
      const l = vlines[i] ?? "";
      if (l.indexOf("->") === -1) continue;
      const result = l.slice(l.indexOf("->") + 2);
      if (/\bexit [0-9]+/.test(result) && l.slice(0, l.indexOf("->")).trim() !== "") {
        ok++;
      }
    }
    if (ok === 0) {
      failures.push({
        clause: "verified",
        detail: 'no "<cmd> -> <result>" line whose result contains "exit <digits>"',
      });
    }
  }

  // Clause 6: deviations / lessons are "none" or free text, never blank.
  ["deviations", "lessons"].forEach(function (key) {
    const v = valueOf(fields, key);
    if (v !== null && !nonEmpty(v)) {
      failures.push({
        clause: "none-or-text",
        detail: key + ': must be "none" or free text, found whitespace only',
      });
    }
  });

  return failures;
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined) {
    process.stderr.write("HARNESS: no report file argument\n");
    process.exit(3);
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    process.stderr.write("HARNESS: cannot read " + path + "\n");
    process.exit(3);
  }
  if (text.length === 0) {
    process.stderr.write("HARNESS: " + path + " is zero bytes\n");
    process.exit(3);
  }
  const failures = validate(text);
  failures.forEach(function (f) {
    process.stdout.write("FAIL " + f.clause + ": " + f.detail + "\n");
  });
  if (failures.length > 0) {
    process.stdout.write(
      "lane report invalid: " + failures.length + " failure(s)\n",
    );
    process.exit(1);
  }
  process.stdout.write("lane report valid: 5 fields, all clauses passed\n");
  process.exit(0);
}

main();
