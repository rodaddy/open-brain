/**
 * Content-free summarization of a child process's stderr.
 *
 * A gate that is trusted as the acceptance instrument has to carry the child's
 * error text, or every real failure presents as a bare exit code and has to be
 * recovered by hand-replaying the command (issue #583). The discipline that
 * makes that safe is the same one the receipts already use elsewhere: keep the
 * error CLASS and ONE line, never bodies and never secrets.
 *
 * Built on the import-free `secret-patterns.ts` leaf rather than
 * `sharing.redactText` so the eval transport does not pull the server logger
 * into a child-process code path.
 */

import { SECRET_PATTERNS } from "./secret-patterns.ts";

/**
 * Python tracebacks put the useful class on the LAST line, not the first, and
 * that line is what names the actual failure ("PermissionError: ..."). Anything
 * shaped `Name: detail` or a bare `Name` at line start is treated as a class.
 */
const ERROR_CLASS_SHAPE = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning))\b/;

export interface ChildStderrSummary {
  /** Exception/error class name when one is recognizable. */
  error_class?: string;
  /** First meaningful stderr line, redacted. */
  stderr_first_line?: string;
}

function redact(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    redacted = redacted.replace(new RegExp(pattern.source, flags), "[REDACTED]");
  }
  return redacted;
}

/**
 * Reduce raw stderr to at most an error class plus one redacted line. Returns
 * an empty object for empty or whitespace-only stderr, so a receipt field is
 * absent rather than present-and-empty when the child said nothing.
 */
export function summarizeChildStderr(stderr: string): ChildStderrSummary {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return {};

  // Prefer the last class-shaped line (Python traceback tail); fall back to the
  // first line so non-Python children still surface something useful.
  const classLine = [...lines]
    .reverse()
    .find((line) => ERROR_CLASS_SHAPE.test(line));
  const chosen = classLine ?? lines[0];
  const errorClass = classLine?.match(ERROR_CLASS_SHAPE)?.[1];

  return {
    ...(errorClass ? { error_class: errorClass } : {}),
    stderr_first_line: redact(chosen as string),
  };
}
