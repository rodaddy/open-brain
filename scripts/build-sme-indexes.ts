#!/usr/bin/env bun
/**
 * Regenerate the six SME lane index files from the per-entry files in
 * `docs/sme/entries/`.
 *
 *   bun scripts/build-sme-indexes.ts          # write the lane files
 *   bun scripts/build-sme-indexes.ts --check  # verify only; non-zero if stale
 *
 * WHY THIS EXISTS
 * ---------------
 * Every review-swarm lane appends findings to the same six markdown files, and
 * git cannot union-merge prose. On the night of 2026-08-06 that produced three
 * manual union merges of `docs/sme/correctness.md` alone. Splitting each
 * finding into its own file makes parallel appends conflict-free by
 * construction: two lanes writing two findings now write two different files
 * and git merges them without a human.
 *
 * The lane files remain, because they are what a reviewer actually reads and
 * what `AGENTS.md` points at — but they become GENERATED artifacts. Never edit
 * them by hand; the edit is silently destroyed by the next build. Write a new
 * file in `docs/sme/entries/` and run this script.
 *
 * DETERMINISM IS THE POINT
 * ------------------------
 * Same inputs must produce byte-identical output, or the merge conflicts come
 * straight back in a new costume. Two properties enforce that:
 *
 *   - Entry ORDER comes from the explicit `order` frontmatter field, not from
 *     filesystem enumeration order (which varies by platform) and not from the
 *     entry date (the source files are NOT chronologically sorted — e.g. the
 *     pre-migration correctness.md opened with a 2026-06-19 entry followed by
 *     2026-06-11, and gotcha-agent.md had 2026-08-06 before 2026-08-05).
 *     Sorting by date would have silently reordered 226 entries and produced a
 *     diff touching every line of every lane file.
 *   - Ties in `order` break on filename, so the total order is always strict.
 *
 * ENTRY FILE FORMAT
 * -----------------
 * YAML-ish frontmatter delimited by `---`, then the entry body verbatim:
 *
 *     ---
 *     lane: correctness
 *     order: 12
 *     section: harvest-522        # optional; omitted for the main run
 *     ---
 *     ## [2026-06-19] Mock-pool tests cannot catch SQL constraint failures
 *
 *     **Severity:** HIGH
 *     ...
 *
 * The body is stored and emitted BYTE-FOR-BYTE. This script does not parse
 * severity, source, scope, or status, and deliberately so: those fields appear
 * in at least four different shapes across the corpus (a 4-line bold block, a
 * 5-line block using `**Scope key:**`, a single inline `Severity: HIGH.
 * Status: ... Provenance: ...` prose line, and a bold `**Provenance:**` line),
 * with some entries missing fields entirely. Any parser would have to
 * normalize, and normalizing rewords history. The frontmatter carries only
 * what placement needs.
 *
 * SECTIONS
 * --------
 * Each lane file carries a "Harvest #522" divider — a `---` rule, an H1, and a
 * fixed explanatory paragraph — sitting between two dated entries, identical
 * in all six files. Entries after it belong to `section: harvest-522`, and the
 * divider is re-emitted from the template below when the first such entry is
 * reached. It is lane structure, not a finding, so it is not an entry file.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SME_DIR = join(REPO_ROOT, "docs", "sme");
const ENTRIES_DIR = join(SME_DIR, "entries");

/** Lane slug -> generated lane filename. Order here is display order only. */
const LANES = [
  "correctness",
  "adversarial",
  "quality",
  "security",
  "domain-backend",
  "gotcha-agent",
] as const;

type Lane = (typeof LANES)[number];

/**
 * The prose that opens each lane file, reproduced verbatim from the
 * pre-migration originals. Kept here rather than in a per-lane header file
 * because it is short, stable, and belongs with the generator that emits it.
 *
 * `gotcha-agent` is the exception: its preamble is 111 lines of operational
 * reviewer policy (Mission, six Mandatory Checks, Output Format), which is not
 * a finding and not boilerplate. It lives in `docs/sme/_headers/gotcha-agent.md`
 * so it stays editable prose rather than a TypeScript string literal.
 */
const PREAMBLES: Record<Lane, string> = {
  correctness: `# Correctness SME Findings

Correctness reviewers check API contracts, schema compatibility, state
transitions, and runtime behavior that tests can accidentally miss.
`,
  adversarial: `# Adversarial SME Findings

Adversarial reviewers hunt for failure states: outages, partial writes, stuck
locks, oversized data, malformed responses, and tests that pass for the wrong
reason.
`,
  quality: `# Quality SME Findings

Quality reviewers check whether abstractions communicate their contracts and
whether future maintainers can safely extend the package without repeating past
mistakes.
`,
  security: `# Security SME Findings

Security reviewers focus on boundaries: namespaces, bearer tokens, secret
handling, trusted headers, redirect behavior, and plaintext transport.
`,
  "domain-backend": `# Backend and Open Brain Domain SME Findings

The backend/domain lane checks MCP-over-HTTP behavior, Open Brain tool contracts,
namespace semantics, and package/runtime deployment boundaries.
`,
  "gotcha-agent": "", // loaded from docs/sme/_headers/gotcha-agent.md
};

const HEADERS_DIR = join(SME_DIR, "_headers");

/** Divider introducing the harvest-522 section, identical in all six lanes. */
const HARVEST_522_DIVIDER = `---

# Harvest #522 — findings recovered from issue/PR history (2026-08-03)

Routed here by operator ruling on the #522 canon harvest: these are review
findings from closed issues and PRs that never reached this lane file. Each
carries its source and a verbatim quote. Severity is recorded as stated in the
source; where the source did not state one, it says so rather than inventing a
level.
`;

const SECTION_DIVIDERS: Record<string, string> = {
  "harvest-522": HARVEST_522_DIVIDER,
};

/**
 * Banner shape follows this repo's existing generated-file convention from
 * `_ob/scripts/sync-repo-standards.ts:287` (the `_DOCS/STANDARDS-*.md` header):
 * `GENERATED by <script> -- DO NOT EDIT.`, a `source:` line, a `Refresh:`
 * command, and a closing sentence sending edits to the source.
 *
 * That script also embeds a `source-hash` for drift detection. This one does
 * not, and the omission is deliberate: a standards file derives from exactly
 * one source document, so a hash is the only cheap staleness signal available.
 * A lane file derives from N entry files, and `--check` already rebuilds and
 * compares the full text — which detects every drift a hash would, plus drift
 * in the generator itself, which a source-hash cannot see.
 */
const BANNER = `<!-- GENERATED by scripts/build-sme-indexes.ts -- DO NOT EDIT.
     source: docs/sme/entries/*.md (one file per finding)
     Refresh: bun scripts/build-sme-indexes.ts
     Add a finding by writing a new file in docs/sme/entries/, then refreshing.
     Findings belong in the source above, never in this generated copy. -->
`;

interface Entry {
  file: string;
  lane: Lane;
  order: number;
  section: string | null;
  /**
   * Blank lines emitted after this entry, before the next heading. Defaults to
   * 1, which is how all but four of the corpus entries were written. The four
   * exceptions end flush against the following heading, and reproducing that
   * exactly is what keeps the migration a MOVE of history rather than a
   * reformat of it.
   */
  gap: number;
  body: string;
}

/**
 * Split frontmatter from body. Intentionally minimal — the frontmatter is
 * written by this repo's own migration and holds three scalar keys. A YAML
 * library would accept far more than the format allows and would invite
 * structure the build cannot round-trip.
 */
function parseEntry(path: string, raw: string): Entry {
  if (!raw.startsWith("---\n")) {
    throw new Error(`${path}: missing opening '---' frontmatter delimiter`);
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`${path}: missing closing '---' frontmatter delimiter`);
  }
  const fmText = raw.slice(4, end + 1);
  const body = raw.slice(end + 5);

  const fm: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error(`${path}: malformed frontmatter line: ${line}`);
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const lane = fm.lane as Lane;
  if (!LANES.includes(lane)) {
    throw new Error(`${path}: unknown lane '${fm.lane}'`);
  }
  const order = Number(fm.order);
  if (!Number.isInteger(order)) {
    throw new Error(`${path}: 'order' must be an integer, got '${fm.order}'`);
  }
  const section = fm.section ? fm.section : null;
  if (section && !(section in SECTION_DIVIDERS)) {
    throw new Error(`${path}: unknown section '${section}'`);
  }
  const gap = fm.gap === undefined ? 1 : Number(fm.gap);
  if (!Number.isInteger(gap) || gap < 0) {
    throw new Error(`${path}: 'gap' must be a non-negative integer, got '${fm.gap}'`);
  }
  return { file: path, lane, order, section, gap, body };
}

function loadEntries(): Entry[] {
  if (!existsSync(ENTRIES_DIR)) {
    throw new Error(`${ENTRIES_DIR} does not exist; nothing to build from`);
  }
  const names = readdirSync(ENTRIES_DIR)
    .filter((n) => n.endsWith(".md"))
    .sort(); // stable base order; `order` is authoritative, filename breaks ties
  return names.map((n) => parseEntry(n, readFileSync(join(ENTRIES_DIR, n), "utf8")));
}

function preambleFor(lane: Lane): string {
  const headerPath = join(HEADERS_DIR, `${lane}.md`);
  if (existsSync(headerPath)) return readFileSync(headerPath, "utf8");
  const inline = PREAMBLES[lane];
  if (!inline) throw new Error(`no preamble for lane '${lane}' (expected ${headerPath})`);
  return inline;
}

function renderLane(lane: Lane, entries: Entry[]): string {
  const mine = entries
    .filter((e) => e.lane === lane)
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.file < b.file ? -1 : 1));

  const parts: string[] = [BANNER, "\n", preambleFor(lane)];

  // Each entry contributes its body plus the blank lines that FOLLOWED it in
  // the source, so spacing is carried by the entry that owned it rather than
  // imposed uniformly by the renderer. The preamble supplies the first
  // separator; every later one comes from the preceding entry's `gap`.
  let pendingGap = 1;
  let currentSection: string | null = null;
  for (const entry of mine) {
    if (entry.section !== currentSection) {
      if (entry.section) {
        // `parseEntry` rejects any section name that is not a key here, so a
        // miss is a programming error rather than bad input — say so loudly
        // instead of emitting `undefined` into a lane file.
        const divider = SECTION_DIVIDERS[entry.section];
        if (divider === undefined) {
          throw new Error(`${entry.file}: no divider registered for section '${entry.section}'`);
        }
        // The divider template opens at its `---` rule, so the blank line that
        // separated it from the preceding entry is supplied here, and a second
        // blank separates the template's closing paragraph from the first
        // entry of the new section.
        parts.push("\n".repeat(Math.max(pendingGap, 1)), divider);
        pendingGap = 1;
      }
      currentSection = entry.section;
    }
    parts.push("\n".repeat(pendingGap), entry.body.replace(/\s*$/, "") + "\n");
    pendingGap = entry.gap;
  }

  // The final entry's gap is deliberately NOT emitted. Each source lane file
  // ends with a single newline terminating its last line, which the body
  // already carries; emitting the gap as well appends a spurious blank line.
  return parts.join("");
}

function main(): void {
  const check = process.argv.includes("--check");
  const entries = loadEntries();

  // Duplicate (lane, order) is not fatal — filename breaks the tie
  // deterministically — but it means two findings claim one slot, which is a
  // sign of a bad merge and is worth saying out loud.
  const seen = new Map<string, string>();
  for (const e of entries) {
    const key = `${e.lane}#${e.order}`;
    const prior = seen.get(key);
    if (prior) console.warn(`warning: ${e.lane} order ${e.order} claimed by both ${prior} and ${e.file}`);
    else seen.set(key, e.file);
  }

  let stale = 0;
  for (const lane of LANES) {
    const target = join(SME_DIR, `${lane}.md`);
    const next = renderLane(lane, entries);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === next) continue;
    stale += 1;
    if (check) {
      console.error(`stale: docs/sme/${lane}.md differs from its entries`);
    } else {
      writeFileSync(target, next);
      console.log(`wrote docs/sme/${lane}.md (${entries.filter((e) => e.lane === lane).length} entries)`);
    }
  }

  if (check && stale > 0) {
    console.error(`\n${stale} lane file(s) out of date. Run: bun scripts/build-sme-indexes.ts`);
    process.exit(1);
  }
  if (!check && stale === 0) console.log("all lane files already up to date");
}

main();
