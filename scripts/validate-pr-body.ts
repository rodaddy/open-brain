interface ValidationResult {
  bypassed: boolean;
  errors: string[];
}

const bypassMarker = "review-gate-bypass: rico-approved";

function section(body: string, name: string): string {
  const lines = body.split(/\r?\n/);
  const heading = `## ${name}`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading);
  if (start === -1) return "";

  const end = lines.findIndex(
    (line, index) => index > start && line.trim().startsWith("## "),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

function requireSpecificLine(
  sectionBody: string,
  label: string,
  errors: string[],
): void {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sectionBody.match(
    new RegExp(`^-\\s*${escaped}:[^\\S\\r\\n]*([^\\r\\n]+)$`, "im"),
  );
  const value = match?.[1]?.trim() ?? "";
  if (!value || value === "-" || value.toLowerCase() === "n/a") {
    errors.push(`Critical Self-Review field '${label}' needs specific content.`);
  }
}

function checked(sectionBody: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^-\\s*\\[[xX]\\]\\s*${escaped}`, "im").test(sectionBody);
}

export function validatePrBody(body: string): ValidationResult {
  const errors: string[] = [];

  if (body.toLowerCase().includes(bypassMarker)) {
    return { bypassed: true, errors };
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

    const smeLine = criticalSelfReview.match(
      /^-\s*SME review-memory update:\s*(.+)$/im,
    )?.[1] ?? "";
    const updatedChecked = /\[[xX]\]\s*`?docs\/sme\/`?\s*updated/.test(smeLine);
    const notApplicableMatch = /\[[xX]\]\s*not applicable because:\s*(.+)$/i.exec(smeLine);
    const notApplicableBecause = notApplicableMatch?.[1]?.trim() ?? "";
    if (updatedChecked === Boolean(notApplicableMatch)) {
      errors.push("SME review-memory update must check exactly one disposition.");
    } else if (notApplicableMatch && (!notApplicableBecause || notApplicableBecause === "-")) {
      errors.push("SME review-memory not-applicable disposition needs a reason.");
    }
  }

  const reviewGate = section(body, "Review Gate");
  if (!reviewGate) {
    errors.push("Missing '## Review Gate' section.");
  } else {
    for (const label of [
      "Critical self-review fields above are filled",
      "MEDIUM+ review findings were captured",
      "Live Open Brain checks are linked below",
    ]) {
      if (!checked(reviewGate, label)) {
        errors.push(`Review Gate checkbox must be checked: ${label}`);
      }
    }
  }

  return { bypassed: false, errors };
}

if (import.meta.main) {
  const body = process.env.PR_BODY ?? "";
  const title = process.env.PR_TITLE ?? "";
  const result = validatePrBody(body);

  if (result.bypassed) {
    console.log(`PR body validation bypassed for ${title}: ${bypassMarker}`);
    process.exit(0);
  }

  if (result.errors.length > 0) {
    console.error("PR body validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    console.error(`Use '${bypassMarker}' only when Rico explicitly approves a bypass.`);
    process.exit(1);
  }

  console.log(`PR body validation passed for ${title || "untitled PR"}.`);
}
