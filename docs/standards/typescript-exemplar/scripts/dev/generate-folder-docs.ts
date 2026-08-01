/**
 * Check that every module has a real file-header docblock, and report what is
 * missing.
 *
 * WHY THIS SCRIPT IS DIFFERENT FROM ITS ANCESTOR
 *
 * The Python version this mirrors replaced a script that is one of the three
 * receipts in that exemplar's README: it returned 0 unconditionally, no hook
 * ever called it, and three documents described it as pre-commit enforced. It
 * was a no-op with documentation. This one has exactly one job and reports
 * honestly about it:
 *
 *   --check   exit 1 when a module is missing or has a placeholder docblock
 *   (default) list what is missing, exit 0
 *
 * A PLACEHOLDER COUNTS AS MISSING. "Module for handling things." restates the
 * filename and tells a reader nothing they could not get from `ls`; treating it
 * as present is how a rule ends up satisfied by text that carries no
 * information. That is the whole failure this file exists to prevent, so the
 * check is deliberately harder to satisfy than a mere `/** *​/` at the top.
 *
 * WHY A LEADING-COMMENT SCAN AND NOT A PARSER
 *
 * The Python twin uses `ast`, which is stdlib. TypeScript's equivalent is the
 * compiler API -- a real dependency and a large one for a question this narrow.
 * `## LAW: do not hand-roll a solved problem` ranks stdlib above a library, and
 * this problem is genuinely small: a file-header docblock is the first non-empty
 * construct in the file, so reading until the first non-comment line answers it
 * exactly. The limitation is stated rather than hidden: this cannot tell a
 * docblock from a license header, so a file whose first comment is a license
 * needs its docblock after it, which is where it belongs anyway.
 *
 * Usage:
 *   node --experimental-strip-types scripts/dev/generate-folder-docs.ts --check
 *   node --experimental-strip-types scripts/dev/generate-folder-docs.ts
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_ROOT = resolve(PROJECT_ROOT, "src/exemplar");

/**
 * A docblock shorter than this says nothing useful.
 *
 * Not a style preference: the header is what an agent reads to decide whether a
 * module is relevant, and one line cannot carry that. Matches the Python twin's
 * MIN_CHARS exactly -- a repo stricter in one language teaches that the rule is
 * arbitrary.
 */
const MIN_CHARS = 120;

/**
 * Phrasings that restate the filename. Matched case-insensitively against the
 * opening of the docblock.
 */
const PLACEHOLDERS = [
  "module for",
  "package for",
  "this module",
  "this package",
  "todo",
  "tbd",
  "placeholder",
];

/**
 * Extract a file's leading docblock, or null when it has none.
 *
 * @param path - File to inspect.
 * @returns The docblock's prose with comment syntax stripped, or null.
 */
function headerDocblock(path: string): string | null {
  const source = readFileSync(path, "utf8");
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (match === null) return null;

  const body = match[1];
  if (body === undefined) return null;

  return body
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Why a file failed the check. */
interface Finding {
  path: string;
  reason: string;
}

/**
 * Judge one file's docblock.
 *
 * @param path - Absolute path to a source file.
 * @returns A finding, or null when the file passes.
 */
function inspect(path: string): Finding | null {
  const doc = headerDocblock(path);
  const shown = relative(PROJECT_ROOT, path);

  if (doc === null || doc.length === 0) {
    return { path: shown, reason: "no file-header docblock" };
  }

  const opening = doc.slice(0, 80).toLowerCase();
  const placeholder = PLACEHOLDERS.find((phrase) => opening.startsWith(phrase));
  if (placeholder !== undefined) {
    return {
      path: shown,
      reason: `opens with the placeholder phrase "${placeholder}" -- it restates the filename`,
    };
  }

  if (doc.length < MIN_CHARS) {
    return {
      path: shown,
      reason: `docblock is ${String(doc.length)} chars (minimum ${String(MIN_CHARS)})`,
    };
  }

  return null;
}

/**
 * Every TypeScript source file under src/.
 *
 * `fd` rather than a hand-rolled recursive walk: it is installed, it is
 * gitignore-aware, and AGENTS.md requires it over `find`. Falling back to a
 * manual walk when fd is absent would mean two code paths with different
 * ignore semantics, so this fails loudly instead.
 */
function sourceFiles(): string[] {
  try {
    return execFileSync("fd", ["--extension", "ts", "--type", "f", ".", SOURCE_ROOT], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
  } catch (error: unknown) {
    throw new Error(
      `Could not enumerate sources with fd: ${error instanceof Error ? error.message : String(error)}. ` +
        "ACTION REQUIRED: install fd (brew install fd).",
    );
  }
}

function main(): void {
  const checkMode = process.argv.includes("--check");
  const findings = sourceFiles()
    .map(inspect)
    .filter((finding): finding is Finding => finding !== null);

  if (findings.length === 0) {
    process.stdout.write(
      `all ${String(sourceFiles().length)} modules have a real file-header docblock\n`,
    );
    return;
  }

  process.stdout.write(`\n${String(findings.length)} module(s) need a docblock:\n\n`);
  for (const finding of findings) {
    process.stdout.write(`  ${finding.path}\n      ${finding.reason}\n`);
  }
  process.stdout.write(
    "\nA header docblock states WHY the module exists and what a reader needs to\n" +
      "know before using it -- not what its name already says.\n\n",
  );

  // The default mode REPORTS and exits 0; --check is the gating mode. Two modes
  // rather than one so the script is usable while writing docs without failing
  // the shell every time, and unambiguous in CI.
  if (checkMode) process.exitCode = 1;
}

main();
