import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

interface ValidationResult {
  errors: string[];
  /**
   * Human-readable notes about decisions this validator made for itself —
   * currently, which tree answered the `Done-means` path.
   *
   * AGENTS.md "nothing is adjusted silently" (operator ruling 2026-08-08): a
   * verdict whose BASIS is invisible cannot be checked by the person reading
   * the transcript. Issue #706 asks for this by name: "Announce which tree
   * answered — 'resolved in worktree' vs 'resolved in branch <name>'".
   * These are not errors and never affect the exit code.
   */
  notes: string[];
}

interface ValidationOptions {
  contractParityRequired?: boolean;
  /**
   * The tree under review — where the PR's own files live.
   *
   * ISSUE #706. `.claude/hooks/pr-body-gate.ts` spawns this validator out of
   * `$CLAUDE_PROJECT_DIR`, the PRIMARY CHECKOUT, which sits on the base branch.
   * A lane works in a worktree and its done-means check is a NEW file on the
   * lane branch, so resolving `Done-means` against the validator's own tree
   * structurally refused every PR that introduced its own check — and the only
   * escapes were false receipts (naming a different, pre-existing check that
   * never judged the lane) or a bogus `not applicable`. A gate whose cheapest
   * escape is a false receipt trains exactly the reflex LAW 0 forbids.
   *
   * Defaults to the invoking cwd, which is what the hook already knows (it
   * reads the lane's cwd from its payload) and what CI already has (the
   * workflow checks out the PR ref and runs from it).
   */
  reviewRoot?: string;
  /**
   * A git ref containing the PR's files, consulted when the path is on disk in
   * no available tree — the `gh pr create` case where the lane's commit exists
   * but the file is in no checkout this process can see.
   */
  headRef?: string;
  /** Repository to ask about `headRef`. Defaults to `reviewRoot`. */
  repoDir?: string;
}

const PLACEHOLDER_REASONS = new Set(["-", "n/a", "na", "none", "todo", "tbd"]);

function isPlaceholderReason(value: string): boolean {
  return !value || PLACEHOLDER_REASONS.has(value.toLowerCase());
}

function section(body: string, name: string): string {
  const lines = body.split(/\r?\n/);
  const heading = `## ${name}`.toLowerCase();
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === heading,
  );
  if (start === -1) return "";

  const end = lines.findIndex(
    (line, index) => index > start && line.trim().startsWith("## "),
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

function requireSpecificLine(
  sectionBody: string,
  label: string,
  errors: string[],
  sectionName = "Critical Self-Review",
): void {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sectionBody.match(
    new RegExp(`^-\\s*${escaped}:[^\\S\\r\\n]*([^\\r\\n]+)$`, "im"),
  );
  const value = match?.[1]?.trim() ?? "";
  if (!value || value === "-" || value.toLowerCase() === "n/a") {
    errors.push(
      `${sectionName} field '${label}' needs specific content.`,
    );
  }
}

/** The tree this validator file itself ships in. */
const OWN_TREE = resolve(import.meta.dir, "..");

/**
 * Does `value` name an existing path INSIDE `root`?
 *
 * The containment guard is unchanged from the original single-tree rule and is
 * applied per candidate tree: an absolute value, or one that escapes the root
 * via `..`, is refused no matter which tree is being consulted. Widening WHERE
 * the path may live must not widen WHAT may be named.
 */
function existsInTree(root: string, value: string): boolean {
  if (isAbsolute(value)) return false;
  const candidate = resolve(root, value);
  const inside = candidate === root || candidate.startsWith(`${root}${sep}`);
  return inside && existsSync(candidate);
}

/**
 * Is `value` a path committed in `ref` within `repoDir`?
 *
 * `git cat-file -e <ref>:<path>` answers exactly this and nothing else: it exits
 * 0 when the object exists and non-zero otherwise, without materialising the
 * file. A ref that does not contain the path — or a repo that cannot answer at
 * all — is a plain false, so this can only ever ADD a resolution, never turn the
 * rule into a blanket pass.
 */
function existsInRef(repoDir: string, ref: string, value: string): boolean {
  if (isAbsolute(value) || value.includes("..")) return false;
  const probe = spawnSync("git", ["cat-file", "-e", `${ref}:${value}`], {
    cwd: repoDir,
    encoding: "utf8",
  });
  return probe.status === 0;
}

function requireDoneMeans(
  sectionBody: string,
  errors: string[],
  notes: string[],
  options: ValidationOptions,
): void {
  const match = sectionBody.match(
    /^-\s*Done-means:[^\S\r\n]*([^\r\n]+)$/im,
  );
  const value = match?.[1]?.trim() ?? "";
  const notApplicable = /^not applicable because:\s*(.*)$/i.exec(value);
  if (notApplicable) {
    if (isPlaceholderReason(notApplicable[1]?.trim() ?? "")) {
      errors.push(
        "Verification field 'Done-means' not-applicable form needs a specific reason.",
      );
    }
    return;
  }

  if (!value || value === "-" || value.toLowerCase() === "n/a") return;

  // RESOLUTION ORDER (issue #706). The tree under review is asked FIRST,
  // because that is the tree being merged and therefore the only one whose
  // answer is about this PR. The validator's own tree is the fallback for the
  // ordinary case where they are the same directory, or where the validator is
  // invoked from somewhere else entirely.
  const reviewRoot = resolve(options.reviewRoot ?? process.cwd());
  const trees: Array<{ label: string; root: string }> = [
    { label: "the tree under review", root: reviewRoot },
  ];
  if (reviewRoot !== OWN_TREE) {
    trees.push({ label: "the validator's own tree", root: OWN_TREE });
  }

  for (const tree of trees) {
    if (existsInTree(tree.root, value)) {
      notes.push(
        `Done-means resolved in ${tree.label}: ${tree.root}${sep}${value}`,
      );
      return;
    }
  }

  // On disk in no tree we can see. The file may still be committed on the
  // branch being merged — the `gh pr create` case the hook hits, where the lane
  // has pushed but no local checkout carries the file.
  const headRef = options.headRef?.trim();
  if (headRef) {
    const repoDir = resolve(options.repoDir ?? reviewRoot);
    if (existsInRef(repoDir, headRef, value)) {
      notes.push(
        `Done-means resolved in branch ${headRef} (${repoDir}), not on disk in any available tree`,
      );
      return;
    }
  }

  // Refused. The gate's purpose is unchanged: a path that exists in no tree and
  // on no named ref is still not a check that can declare anything done. The
  // message names WHERE it looked so the refusal is actionable rather than a
  // dead end.
  const looked = trees.map((tree) => tree.root).join(", ");
  errors.push(
    `Verification field 'Done-means' must name an existing repo-relative path; not found: ${value}` +
      ` (looked in: ${looked}${headRef ? `; and in ref ${headRef}` : ""})`,
  );
}

function checked(sectionBody: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^-\\s*\\[[xX]\\]\\s*${escaped}`, "im").test(sectionBody);
}

function exactlyOneDisposition(
  line: string,
  firstLabel: string,
  secondLabel: string,
  errorPrefix: string,
  errors: string[],
): void {
  const firstChecked = new RegExp(`\\[[xX]\\]\\s*${firstLabel}`).test(line);
  const secondMatch = new RegExp(
    `\\[[xX]\\]\\s*${secondLabel}:\\s*(.+)$`,
    "i",
  ).exec(line);
  const secondChecked = Boolean(secondMatch);
  const secondReason = secondMatch?.[1]?.trim() ?? "";
  if (firstChecked === secondChecked) {
    errors.push(`${errorPrefix} must check exactly one disposition.`);
  } else if (secondChecked && (!secondReason || secondReason === "-")) {
    errors.push(`${errorPrefix} not-applicable disposition needs a reason.`);
  }
}

function requireContractParityDisposition(
  sectionBody: string,
  errors: string[],
): void {
  const fixturesUpdated =
    /^-\s*Contract parity:\s*\[[xX]\]\s*fixtures updated\s*$/im.test(
      sectionBody,
    );
  const runtimeSpecific =
    /^-\s*Contract parity:\s*\[[xX]\]\s*runtime-specific because:\s*(.+)$/im.exec(
      sectionBody,
    );
  const runtimeSpecificReason = runtimeSpecific?.[1]?.trim() ?? "";

  if (fixturesUpdated === Boolean(runtimeSpecific)) {
    errors.push("Contract parity must check exactly one disposition.");
  } else if (runtimeSpecific && isPlaceholderReason(runtimeSpecificReason)) {
    errors.push("Contract parity runtime-specific disposition needs a reason.");
  }
}

export function validatePrBody(
  body: string,
  options: ValidationOptions = {},
): ValidationResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const verification = section(body, "Verification");
  if (!verification) {
    errors.push("Missing '## Verification' section.");
  } else {
    requireSpecificLine(verification, "Done-means", errors, "Verification");
    requireDoneMeans(verification, errors, notes, options);
  }

  const criticalSelfReview = section(body, "Critical Self-Review");
  if (!criticalSelfReview) {
    errors.push("Missing '## Critical Self-Review' section.");
  } else {
    for (const label of [
      "Highest-risk behavior",
      "Assumptions that could be wrong",
      "Missing/weak tests",
      "Security/permission risk",
      "Migration/deploy risk",
      "Downstream client/runtime risk",
      "Rollback/cleanup concern",
      "Fixes made before PR",
      "Known residual risk",
    ]) {
      requireSpecificLine(criticalSelfReview, label, errors);
    }

    const smeLine =
      criticalSelfReview.match(
        /^-\s*SME review-memory update:\s*(.+)$/im,
      )?.[1] ?? "";
    exactlyOneDisposition(
      smeLine,
      "`?docs/sme/`? updated",
      "not applicable because",
      "SME review-memory update",
      errors,
    );
  }

  const reviewGate = section(body, "Review Gate");
  if (!reviewGate) {
    errors.push("Missing '## Review Gate' section.");
  } else {
    for (const label of [
      "Critical self-review fields above are filled",
      "MEDIUM+ review findings were captured",
    ]) {
      if (!checked(reviewGate, label)) {
        errors.push(`Review Gate checkbox must be checked: ${label}`);
      }
    }

    const liveLine =
      reviewGate.match(/^-\s*Live Open Brain checks:\s*(.+)$/im)?.[1] ?? "";
    exactlyOneDisposition(
      liveLine,
      "linked below",
      "not applicable because",
      "Live Open Brain checks",
      errors,
    );
  }

  if (options.contractParityRequired) {
    const contractParity = section(body, "Contract Parity");
    if (!contractParity) {
      errors.push("Missing '## Contract Parity' section.");
    } else {
      requireContractParityDisposition(contractParity, errors);
    }
  }

  return { errors, notes };
}

if (import.meta.main) {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const result = validatePrBody(body, {
    contractParityRequired:
      process.env.CONTRACT_PARITY_REQUIRED?.toLowerCase() === "true",
    // Issue #706. The tree under review, and the branch being merged.
    //
    // PR_REPO_DIR defaults to the invoking cwd: the hook runs the validator
    // with the LANE's cwd, and CI runs it from the checked-out PR ref, so in
    // both places the default is already the right tree. PR_HEAD_REF is the
    // last resort for a path that is committed but in no visible checkout.
    reviewRoot: process.env.PR_REPO_DIR?.trim() || process.cwd(),
    headRef: process.env.PR_HEAD_REF?.trim() || undefined,
    repoDir: process.env.PR_REPO_DIR?.trim() || undefined,
  });

  // Notes print BEFORE the verdict and on both paths. Which tree answered is
  // the thing #706 asks to be visible, and it is most needed on a REFUSAL —
  // that is when someone has to work out why.
  for (const note of result.notes) {
    console.log(note);
  }

  if (result.errors.length > 0) {
    console.error("PR body validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`PR body validation passed for ${title || "untitled PR"}.`);
}
