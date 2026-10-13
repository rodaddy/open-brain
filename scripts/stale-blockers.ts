/**
 * Report open issues whose referenced issues/PRs are all CLOSED.
 *
 * WHY. The forge auto-closes issue<-PR (a closing keyword in a merged PR) but
 * NEVER issue<-issue: "blocked on #419" is prose to the forge, so when #419
 * closes, every issue citing it sits open until something looks. Operator,
 * 2026-08-05: "419 is closed and done, but the two things that are looking at
 * it still aren't. I don't think we're doing a good job at keeping track of
 * what we're actually closing."
 *
 * WHAT IT IS NOT. All-refs-closed is a CANDIDATE signal, not a verdict — an
 * issue's own acceptance may still be unmet. Each flagged issue gets verified
 * against live state before anyone closes it. This script only makes the
 * candidates impossible to miss.
 *
 * READING THE FORGE. This repo moved off GitHub on 2026-08-30; `origin` is
 * git.example.internal and `gh` does not reach it, so the three `gh issue list` /
 * `gh pr list` shell-outs this used to make returned nothing at all. Every read
 * now goes through scripts/forge-api.ts, which owns the base URL, the auth
 * header and the error shape in one place.
 *
 * ONE LIST, NOT THREE. Forgejo's `/issues?state=all` returns issues AND pull
 * requests in the same collection — a row carrying a `pull_request` object is a
 * PR. That is why the old script's separate `gh pr list` call has no Forgejo
 * counterpart here: one paged walk supplies both halves of the state map.
 *
 * Run it at close-run start and end, alongside scripts/sync-issues.ts:
 *   bun run scripts/stale-blockers.ts
 */

import { forgeListPaged } from "./forge-api.ts";

const repoIssueRef = /#(\d{2,4})\b/g;

/** One row of Forgejo's `/issues?state=all` list, issues and PRs alike. */
type ForgeRow = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  pull_request?: { merged?: boolean } | null;
};

/**
 * The state word this script compares against.
 *
 * Forgejo says "open"/"closed" and records merge separately, so a merged pull
 * request is reported as MERGED rather than CLOSED — the same two words the
 * reference check below already understood.
 */
function stateOf(row: ForgeRow): string {
  if (row.pull_request?.merged) return "MERGED";
  return row.state.toUpperCase();
}

/** Every distinct number referenced by an issue's body, excluding itself. */
function referencesOf(row: ForgeRow): number[] {
  return [...(row.body ?? "").matchAll(repoIssueRef)]
    .map((m) => Number(m[1]))
    .filter((n, i, arr) => n !== row.number && arr.indexOf(n) === i)
    .sort((a, b) => a - b);
}

const rows = await forgeListPaged<ForgeRow>("/issues?state=all", (row) => row.id);

const state = new Map<number, string>();
for (const row of rows) state.set(row.number, stateOf(row));

const open = rows
  .filter((row) => !row.pull_request && row.state.toUpperCase() === "OPEN")
  .sort((a, b) => a.number - b.number);

// Announced, never silent: the reader is told what the one list actually held
// rather than left to infer it from the flagged count.
console.log(
  `read ${rows.length} rows from the forge (${open.length} open issues); ` +
    `pull requests are in the same collection and supply their own state`,
);

let flagged = 0;
for (const issue of open) {
  const refs = referencesOf(issue);
  if (refs.length === 0) continue;
  const openRefs = refs.filter((n) => state.get(n) === "OPEN");
  const closedRefs = refs.filter(
    (n) => state.get(n) === "CLOSED" || state.get(n) === "MERGED",
  );
  if (openRefs.length === 0 && closedRefs.length > 0) {
    flagged += 1;
    console.log(
      `#${issue.number} ${issue.title}\n    every referenced item is closed: ${closedRefs.map((n) => `#${n}`).join(" ")}`,
    );
  }
}
console.log(
  flagged === 0
    ? "\nNo open issue references only-closed work."
    : `\n${flagged} open issue(s) reference only closed work — verify each against live state before closing.`,
);
