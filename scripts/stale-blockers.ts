/**
 * Report open issues whose referenced issues/PRs are all CLOSED.
 *
 * WHY. GitHub auto-closes issue<-PR (a closing keyword in a merged PR) but
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
 * Run it at close-run start and end, alongside scripts/sync-issues.ts:
 *   bun run scripts/stale-blockers.ts
 */

const repoIssueRef = /#(\d{2,4})\b/g;

type IssueRow = { number: number; title: string; body: string | null };
type StateRow = { number: number; state: string };

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args[0]} failed: ${err.trim()}`);
  return out;
}

const open: IssueRow[] = JSON.parse(
  await gh(["issue", "list", "--state", "open", "-L", "500", "--json", "number,title,body"]),
);
const allIssues: StateRow[] = JSON.parse(
  await gh(["issue", "list", "--state", "all", "-L", "1000", "--json", "number,state"]),
);
const allPrs: StateRow[] = JSON.parse(
  await gh(["pr", "list", "--state", "all", "-L", "1000", "--json", "number,state"]),
);

const state = new Map<number, string>();
for (const row of allIssues) state.set(row.number, row.state);
for (const row of allPrs) if (!state.has(row.number)) state.set(row.number, row.state);

let flagged = 0;
for (const issue of open.sort((a, b) => a.number - b.number)) {
  const refs = [...(issue.body ?? "").matchAll(repoIssueRef)]
    .map((m) => Number(m[1]))
    .filter((n, i, arr) => n !== issue.number && arr.indexOf(n) === i)
    .sort((a, b) => a - b);
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
