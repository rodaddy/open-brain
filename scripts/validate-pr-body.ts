import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

interface ValidationResult {
  errors: string[];
}

interface ValidationOptions {
  contractParityRequired?: boolean;
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

function requireDoneMeans(sectionBody: string, errors: string[]): void {
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

  const repoRoot = resolve(import.meta.dir, "..");
  const candidate = resolve(repoRoot, value);
  const insideRepo =
    candidate === repoRoot || candidate.startsWith(`${repoRoot}${sep}`);
  if (isAbsolute(value) || !insideRepo || !existsSync(candidate)) {
    errors.push(
      `Verification field 'Done-means' must name an existing repo-relative path; not found: ${value}`,
    );
  }
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
  const verification = section(body, "Verification");
  if (!verification) {
    errors.push("Missing '## Verification' section.");
  } else {
    requireSpecificLine(verification, "Done-means", errors, "Verification");
    requireDoneMeans(verification, errors);
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

  return { errors };
}

if (import.meta.main) {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const result = validatePrBody(body, {
    contractParityRequired:
      process.env.CONTRACT_PARITY_REQUIRED?.toLowerCase() === "true",
  });

  if (result.errors.length > 0) {
    console.error("PR body validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`PR body validation passed for ${title || "untitled PR"}.`);
}
