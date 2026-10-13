/** Markdown renderers for each Open Brain row type synced into the vault. */
import {
  fmtDate,
  injectLinks,
  listItems,
  PROJECT_GROUPS,
  tagLine,
  warmthStars,
} from "./helpers.ts";
import type { DecisionRow, PersonRow, SessionRow, ThoughtRow } from "./rows.ts";

const FOOTER_RULE = "---";

/**
 * Render an `unknown` metadata value as inline markdown text.
 *
 * Metadata columns are untyped JSON, so a value that reads like a scalar in
 * practice is `unknown` to the type checker. Scalars render verbatim; anything
 * structural is JSON-encoded rather than falling through to `[object Object]`.
 */
function inlineValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function footer(createdAt: string): string[] {
  return [FOOTER_RULE, `> Synced from Open Brain | ${fmtDate(createdAt)}`];
}

function personFrontMatter(row: PersonRow): (string | null)[] {
  return [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "relationships"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/person")}`,
    `warmth: ${row.warmth || 0}`,
    row.relationship_type ? `relationship_type: "${row.relationship_type}"` : null,
    row.email ? `email: "${row.email}"` : null,
    row.phone ? `phone: "${row.phone}"` : null,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    `# ${row.person_name}`,
    "",
  ];
}

function personFactTable(row: PersonRow): string[] {
  if (!row.relationship_type && !row.warmth) return [];
  const meta = row.metadata || {};
  const rows: (string | null)[] = [
    "| Field | Value |",
    "|---|---|",
    row.relationship_type ? `| Relationship | ${row.relationship_type} |` : null,
    row.warmth ? `| Warmth | ${warmthStars(row.warmth)} |` : null,
    row.last_contact ? `| Last Contact | ${fmtDate(row.last_contact)} |` : null,
    row.email ? `| Email | ${row.email} |` : null,
    row.phone ? `| Phone | ${row.phone} |` : null,
    meta.imessage ? `| iMessage | ${inlineValue(meta.imessage)} |` : null,
    "",
  ];
  return rows.filter((line): line is string => line !== null);
}

function prose(
  heading: string,
  body: string | null,
  people: Map<string, string>,
  projects: Set<string>,
): string[] {
  if (!body) return [];
  return [heading, "", injectLinks(body, people, projects), ""];
}

export function renderPerson(
  row: PersonRow,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const lines: (string | null)[] = [
    ...personFrontMatter(row),
    ...personFactTable(row),
    ...prose("## Context", row.context, people, projects),
    ...prose("## Notes", row.notes, people, projects),
    ...footer(row.created_at),
  ];
  return lines.filter((l) => l !== null).join("\n");
}

function alternativeLines(alternatives: unknown[]): string[] {
  if (!alternatives || alternatives.length === 0) return [];
  const lines = ["## Alternatives Considered", ""];
  for (const alt of alternatives) {
    if (typeof alt === "string") {
      lines.push(`- ${alt}`);
      continue;
    }
    if (typeof alt === "object" && alt !== null) {
      const a = alt as Record<string, unknown>;
      const option = inlineValue(a.option) || "Option";
      const detail = inlineValue(a.reason) || inlineValue(a.pro);
      lines.push(`- **${option}**: ${detail}`);
    }
  }
  lines.push("");
  return lines;
}

export function renderDecision(
  row: DecisionRow,
  project: string,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const lines = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "decisions"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/decision")}`,
    `project: "${project}"`,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    `# ${row.title}`,
    "",
    "## Rationale",
    "",
    injectLinks(row.rationale, people, projects),
    "",
    ...alternativeLines(row.alternatives),
    ...prose("## Context", row.context, people, projects),
    ...footer(row.created_at),
  ];
  return lines.join("\n");
}

export function renderThought(
  row: ThoughtRow,
  project: string,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const lines = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "thoughts"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/thought")}`,
    `project: "${project}"`,
    `source: "${row.source}"`,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    injectLinks(row.content, people, projects),
    "",
    ...footer(row.created_at),
  ];
  return lines.join("\n");
}

function sessionSection(heading: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [heading, "", listItems(items), ""];
}

export function renderSession(
  row: SessionRow,
  people: Map<string, string>,
  projects: Set<string>,
): string {
  const projectLabel = row.project || "General";
  const lines = [
    "---",
    `ob_id: "${row.id}"`,
    `ob_table: "sessions"`,
    `ob_synced: "${new Date().toISOString()}"`,
    `tags: ${tagLine(row.tags, "ob/session")}`,
    `project: "${projectLabel}"`,
    `created: ${fmtDate(row.created_at)}`,
    `created_by: "${row.created_by}"`,
    `namespace: "${row.namespace}"`,
    "---",
    "",
    `# Session: [[${projectLabel}]] -- ${fmtDate(row.created_at)}`,
    "",
    "## Summary",
    "",
    injectLinks(row.summary, people, projects),
    "",
    ...sessionSection("## Key Decisions", row.key_decisions),
    ...sessionSection("## Blockers", row.blockers),
    ...sessionSection("## Next Steps", row.next_steps),
    ...footer(row.created_at),
  ];
  return lines.join("\n");
}

/** Generate project MOC (Map of Content) index */
export function renderProjectMOC(projectName: string, vaultRelPath: string): string {
  // For grouped projects, list sub-project folders with dataview
  const isGroup = PROJECT_GROUPS[projectName] !== undefined;
  const subProjects = PROJECT_GROUPS[projectName] || [];

  const subLinks = isGroup ? subProjects.map((s) => `- [[${s}]]`).join("\n") : "";

  return `---
ob_synced: "${new Date().toISOString()}"
tags: [ob/project, ob/moc]
project: "${projectName}"
---

# ${projectName}

> Map of Content for **${projectName}** -- auto-generated from Open Brain.

${isGroup ? `## Sub-Projects\n\n${subLinks}\n\n---\n` : ""}
## Sessions

\`\`\`dataview
TABLE created as "Date", project as "Sub-Project"
FROM "${vaultRelPath}"
WHERE ob_id AND ob_table = "sessions"
SORT created DESC
\`\`\`

---

## Decisions

\`\`\`dataview
TABLE created as "Date"
FROM "${vaultRelPath}"
WHERE ob_id AND ob_table = "decisions"
SORT created DESC
\`\`\`

---

## Thoughts

\`\`\`dataview
TABLE created as "Date", source as "Source"
FROM "${vaultRelPath}"
WHERE ob_id AND ob_table = "thoughts"
SORT created DESC
\`\`\`
`;
}
