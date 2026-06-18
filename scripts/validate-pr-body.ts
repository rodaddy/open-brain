const body = process.env.PR_BODY ?? "";
const title = process.env.PR_TITLE ?? "";

const bypassMarker = "review-gate-bypass: rico-approved";
const errors: string[] = [];

function section(name: string): string {
  const lines = body.split(/\r?\n/);
  const heading = `## ${name}`.toLowerCase();
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading);
  if (start === -1) return "";

  const end = lines.findIndex(
    (line, index) => index > start && line.trim().startsWith("## "),
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

function requireSpecificLine(sectionBody: string, label: string): void {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sectionBody.match(new RegExp(`^-\\s*${escaped}:\\s*([^\\n]+)$`, "im"));
  const value = match?.[1]?.trim() ?? "";
  if (!value || value === "-" || value.toLowerCase() === "n/a") {
    errors.push(`Critical Self-Review field '${label}' needs specific content.`);
  }
}

if (body.toLowerCase().includes(bypassMarker)) {
  console.log(`PR body validation bypassed for ${title}: ${bypassMarker}`);
  process.exit(0);
}

const criticalSelfReview = section("Critical Self-Review");
if (!criticalSelfReview) {
  errors.push("Missing '## Critical Self-Review' section.");
} else {
  for (const label of [
    "Highest-risk behavior",
    "Assumptions that could be wrong",
    "Missing/weak tests",
    "Security/permission risk",
    "Known residual risk",
  ]) {
    requireSpecificLine(criticalSelfReview, label);
  }

  if (!/SME review-memory update:\s*\[[ xX]\]/.test(criticalSelfReview)) {
    errors.push("Critical Self-Review must record whether docs/sme review-memory was updated or not applicable.");
  }
}

const reviewGate = section("Review Gate");
if (!reviewGate) {
  errors.push("Missing '## Review Gate' section.");
} else if (!/Critical self-review fields above are filled/.test(reviewGate)) {
  errors.push("Review Gate must include the critical self-review confirmation checklist.");
}

if (errors.length > 0) {
  console.error("PR body validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  console.error(`Use '${bypassMarker}' only when Rico explicitly approves a bypass.`);
  process.exit(1);
}

console.log(`PR body validation passed for ${title || "untitled PR"}.`);
