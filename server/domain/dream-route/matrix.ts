/**
 * Loads the committed route matrix: the one file that says what each
 * destination means. The text lives in a `.tsv` rather than in code so a
 * wording change is a reviewable one-line diff, and so the fingerprint of the
 * bytes can pin a question-set version to the exact words Jev was shown.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DESTINATIONS,
  type Destination,
  type MatrixRow,
  type RouteMatrix,
} from "./types.ts";

/** The committed matrix shipped beside this module. */
export const DEFAULT_MATRIX_PATH = fileURLToPath(
  new URL("./matrix.tsv", import.meta.url),
);

const MIN_LINE_LENGTH = 10;
const MAX_LINE_LENGTH = 300;

function isDestination(name: string): name is Destination {
  return (DESTINATIONS as readonly string[]).includes(name);
}

function parseRow(path: string, lineNumber: number, text: string): MatrixRow {
  const cells = text.split("\t");
  if (cells.length !== 3) {
    throw new Error(
      `${path}:${lineNumber}: expected exactly three tab-separated cells, got ${cells.length}`,
    );
  }
  const [name, line, commits] = cells as [string, string, string];
  if (!isDestination(name)) {
    throw new Error(
      `${path}:${lineNumber}: unknown destination ${JSON.stringify(name)}`,
    );
  }
  if (line.length < MIN_LINE_LENGTH || line.length > MAX_LINE_LENGTH) {
    throw new Error(
      `${path}:${lineNumber}: description must be ${MIN_LINE_LENGTH} to ${MAX_LINE_LENGTH} characters, got ${line.length}`,
    );
  }
  if (commits !== "true" && commits !== "false") {
    throw new Error(
      `${path}:${lineNumber}: commits must be "true" or "false", got ${JSON.stringify(commits)}`,
    );
  }
  return { name, line, commits: commits === "true" };
}

/**
 * Reads and validates a matrix file. Throws naming `path:line` on any defect
 * rather than routing against a half-read matrix; every destination must be
 * present exactly once.
 */
export function loadMatrix(path: string): RouteMatrix {
  const bytes = readFileSync(path);
  const rows: MatrixRow[] = [];
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed === "" || trimmed.startsWith("#")) return;
      rows.push(parseRow(path, index + 1, text));
    });
  for (const destination of DESTINATIONS) {
    const seen = rows.filter((row) => row.name === destination).length;
    if (seen === 0) throw new Error(`${path}: destination ${destination} is missing`);
    if (seen > 1)
      throw new Error(`${path}: destination ${destination} appears ${seen} times`);
  }
  const fingerprint = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return { rows, fingerprint };
}
