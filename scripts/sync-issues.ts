/**
 * Mirror every issue in this repo into _plans/issues/ as searchable markdown.
 *
 * WHY. Issue bodies live on the forge. Nothing in this working tree can search
 * them, diff them, or recover them when a session drops -- so the same design
 * questions get re-asked: what was the original goal, did we already plan that,
 * did we make this once? Operator, 2026-07-28: "we keep a copy of all issues
 * that are created ... so we don't have to keep trying to remember what was the
 * original goal."
 *
 * COMMENTS ARE THE POINT, NOT THE BODY. The opening body says what someone
 * thought at the time; the comments carry the corrections that reshaped it.
 * #390's body describes the Light stage, but the reasoning that made it
 * model-free is in a comment. A mirror without comments would miss exactly the
 * material this exists to preserve.
 *
 * EVERYTHING IS INDEXED, NO TRIAGE. Operator decision, 2026-07-28: index all of
 * them rather than classifying substantive-vs-side-quest first. Triage by title
 * misjudges -- a chore-sounding title can hide the reasoning for a whole class
 * of bug -- and a misfiled issue is invisible, which is the failure this is
 * meant to fix. Noisier search beats lost context.
 *
 * THESE FILES ARE GENERATED. They are overwritten on every run, so hand edits
 * are lost. Authored thinking goes in _plans/<n>-<slug>.md, which this never
 * touches. The header in each generated file says so.
 *
 * Going forward the markdown comes FIRST: write _plans/<slug>.md, and that is
 * what becomes the issue body. This script then backfills the discussion.
 *
 * A CLOSED ISSUE SHOWS ITS RESOLUTION. Operator ruling, 2026-08-09: "the
 * mirrors are not mirrors. They are artifacts that need to exist locally and we
 * should treat them as such when completed, we should show that they are
 * completed. And so when we do an AQMD search, they're known to be completed,
 * and they explain the direction we went in and why we went in them."
 *
 * The gap that ruling names: rendering `State: CLOSED` and a timestamp says a
 * node finished, never how. The resolution -- which direction was taken and why
 * -- lives in the closing PR: its body carries the done-means evidence and the
 * critical self-review this repo requires, and its merge commit is what
 * actually landed. None of it was reaching the artifact, so a search found the
 * question and not the answer.
 *
 * WHY THE TIMELINE AND NOT `closedByPullRequestsReferences`. Measured
 * 2026-08-09: that connection returns EMPTY for #681 even though PR #687 closed
 * it, because lanes here squash-merge into a wip branch rather than the default
 * branch, so GitHub's auto-close linkage never registers. Building on it would
 * render an empty Resolution for exactly the issues that have one -- asserting
 * absence, which is worse than omitting the section. The timeline carries it in
 * three shapes, all handled by resolutionOf() below.
 *
 * CROSS-REFERENCES ARE NOT A LIST OF CLOSING PRs. #659 is cross-referenced by
 * four PRs and closed by one. They are used ONLY to resolve a closing COMMIT to
 * the PR whose merge commit it is. Listing candidates would put several
 * directions on an issue that took one and leave the reader unable to tell
 * which -- an ambiguous answer fails the ruling as surely as a missing one.
 */

const OUT_DIR = "_plans/issues";

/**
 * The sweep runs only when this file is EXECUTED, never when it is imported.
 *
 * Without this guard, importing `render` to test it also fired the whole
 * `gh issue list` sweep and rewrote every file in `_plans/issues/` -- observed
 * on this change's own first RED run. A check that mutates the tree it is
 * measuring cannot be trusted about it.
 */
const IS_MAIN = import.meta.main;

type TimelineNode = {
  __typename: string;
  // ClosedEvent
  createdAt?: string;
  actor?: { login: string } | null;
  stateReason?: string | null;
  closer?:
    | { __typename: "PullRequest"; number: number }
    | { __typename: "Commit"; oid: string }
    | null;
  // CrossReferencedEvent
  source?: {
    __typename: string;
    number?: number;
    title?: string;
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid: string } | null;
    body?: string;
  } | null;
};

type Issue = {
  number: number;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: { login: string } | null;
  labels: { name: string }[];
  milestone: { title: string } | null;
  body: string;
  comments: {
    author: { login: string } | null;
    createdAt: string;
    body: string;
  }[];
  /** Present only for closed issues; the source of the Resolution section. */
  stateReason?: string | null;
  timeline?: TimelineNode[];
};

/** Filesystem-safe, stable, and readable in a search hit. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * The Resolution section for a closed issue: the direction taken and why.
 *
 * Returns "" for an open issue, or for a closed one whose timeline was never
 * fetched -- an artifact that cannot see the timeline must stay silent rather
 * than assert the issue resolved itself.
 *
 * Three shapes, measured over the 25 most recently closed issues (2026-08-09):
 * closer is a PullRequest (20), closer is a Commit whose SHA matches a
 * cross-referenced PR's merge commit (2, e.g. #681 -> 31589d1 -> #687), and
 * closer is null (3, closed by hand). The third renders what the timeline
 * actually has and names no PR: an issue closed without one is a real outcome,
 * and saying so is the honest artifact.
 *
 * The closing PR's BODY is reproduced IN FULL. It is the direction-and-why
 * payload -- in this repo it carries the done-means RED/GREEN evidence and the
 * critical self-review -- so a link without it would record that something
 * happened while losing the reasoning this whole artifact exists to preserve.
 */
function resolutionOf(i: Issue): string {
  if (i.state !== "CLOSED" || !i.timeline?.length) return "";

  const closedEvent = i.timeline
    .filter((n) => n.__typename === "ClosedEvent")
    .pop();
  const crossRefs = i.timeline.filter(
    (n) => n.__typename === "CrossReferencedEvent" && n.source?.__typename === "PullRequest",
  );

  const closer = closedEvent?.closer ?? null;
  let pr: TimelineNode["source"] | null = null;
  let linkage = "";

  if (closer?.__typename === "PullRequest") {
    pr = crossRefs.find((n) => n.source?.number === closer.number)?.source ?? null;
    // The cross-reference carries the PR's title/body; the closer carries only
    // its number. If the reference is absent the number is still the truth.
    if (!pr) pr = { __typename: "PullRequest", number: closer.number };
    linkage = "GitHub recorded this pull request as the closer.";
  } else if (closer?.__typename === "Commit") {
    const sha = closer.oid;
    pr = crossRefs.find((n) => n.source?.mergeCommit?.oid === sha)?.source ?? null;
    linkage = pr
      ? `Closed by commit \`${sha}\`, which is the merge commit of this pull request.`
      : `Closed by commit \`${sha}\`. No cross-referenced pull request has that merge commit, so the PR could not be identified from the timeline.`;
  }

  const lines: string[] = ["## Resolution", ""];

  if (pr?.number) {
    lines.push(
      `Closed by **PR #${pr.number}**${pr.title ? ` — ${pr.title}` : ""}`,
      "",
      `- Linkage: ${linkage}`,
      `- Merge commit: \`${pr.mergeCommit?.oid ?? "unknown"}\``,
      `- Merged at: ${pr.mergedAt ?? "unknown"}`,
      `- PR state: ${pr.state ?? "unknown"}`,
      `- Issue closed: ${closedEvent?.createdAt ?? i.closedAt ?? "unknown"} by ${closedEvent?.actor?.login ?? "unknown"} (${closedEvent?.stateReason ?? i.stateReason ?? "unknown"})`,
      "",
    );
    if (pr.body?.trim()) {
      // The body is reproduced BYTE-FOR-BYTE, and it is quoted rather than
      // inlined. Both halves matter and were found by this change's own check:
      //
      //  - Byte-for-byte: even trimming the trailing newline makes the artifact
      //    a paraphrase of the PR rather than a copy of it, and the whole point
      //    is that the reasoning survives intact.
      //
      //  - Quoted: PR bodies in this repo carry their OWN `## Summary`,
      //    `## Verification`, `## Critical Self-Review` headings. Inlined, those
      //    become top-level sections of the artifact, so the PR's structure
      //    masquerades as the issue's and a reader (or a section-scoped search)
      //    cannot tell where the quoted body ends. Blockquoting keeps every line
      //    inside the Resolution while leaving the text readable and searchable.
      const quoted = pr.body
        .split("\n")
        .map((line) => (line.length ? `> ${line}` : ">"))
        .join("\n");
      lines.push(
        `### Direction taken and why — PR #${pr.number} body`,
        "",
        quoted,
        "",
      );
    } else {
      lines.push(
        `_The closing PR has no body, so the reasoning behind this direction was never written down._`,
        "",
      );
    }
  } else {
    // No PR: state what the timeline has, and say plainly that no PR closed it.
    lines.push(
      "Closed without a pull request.",
      "",
      `- Issue closed: ${closedEvent?.createdAt ?? i.closedAt ?? "unknown"} by ${closedEvent?.actor?.login ?? "unknown"}`,
      `- State reason: ${closedEvent?.stateReason ?? i.stateReason ?? "unknown"}`,
      "",
    );
    if (closer?.__typename === "Commit") {
      lines.push(`- ${linkage}`, "");
    }
    const lastComment = i.comments?.[i.comments.length - 1];
    if (lastComment) {
      lines.push(
        `The closing rationale, if it was written anywhere, is in the discussion below — most recently by ${lastComment.author?.login ?? "unknown"} on ${lastComment.createdAt}.`,
        "",
      );
    }
  }

  return lines.join("\n");
}

export function render(i: Issue): string {
  const labels = i.labels.map((l) => l.name).join(", ") || "none";
  const closed = i.closedAt ? `\nClosed: ${i.closedAt}` : "";
  const milestone = i.milestone ? `\nMilestone: ${i.milestone.title}` : "";

  const head = `<!-- GENERATED by scripts/sync-issues.ts. Do not edit: this file is
     overwritten on every sync. Authored plans live in _plans/<n>-<slug>.md. -->

# #${i.number} — ${i.title}

State: ${i.state}
Author: ${i.author?.login ?? "unknown"}
Labels: ${labels}
Created: ${i.createdAt}
Updated: ${i.updatedAt}${closed}${milestone}

---

${i.body?.trim() || "_(no body)_"}
`;

  // The Resolution sits directly under the header, ABOVE the discussion: a
  // reader (or a search hit) meeting a completed node should learn how it ended
  // before scrolling a thread whose earlier turns were superseded by it.
  const resolution = resolutionOf(i);
  const withResolution = resolution ? `${head}\n---\n\n${resolution}` : head;

  if (!i.comments.length) return withResolution;

  // Comments in chronological order: a correction only makes sense after the
  // thing it corrects.
  const thread = i.comments
    .map(
      (c) =>
        `### ${c.author?.login ?? "unknown"} — ${c.createdAt}\n\n${c.body.trim()}`,
    )
    .join("\n\n---\n\n");

  return `${withResolution}\n---\n\n## Discussion (${i.comments.length})\n\n${thread}\n`;
}

/** Run a command to completion, returning stdout and failing loudly. */
async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    console.error(await new Response(proc.stderr).text());
    process.exit(1);
  }
  return out;
}

const TIMELINE_QUERY = `
query($owner:String!,$repo:String!,$cursor:String) {
  repository(owner:$owner,name:$repo) {
    issues(first:50, states:CLOSED, orderBy:{field:CREATED_AT,direction:DESC}, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        stateReason
        timelineItems(last:60, itemTypes:[CLOSED_EVENT,CROSS_REFERENCED_EVENT]) {
          nodes {
            __typename
            ... on ClosedEvent {
              createdAt
              actor { login }
              stateReason
              closer {
                __typename
                ... on PullRequest { number }
                ... on Commit { oid }
              }
            }
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest { number title state mergedAt mergeCommit { oid } body }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Timelines for every CLOSED issue, keyed by number.
 *
 * Paged at 50 issues per request because that is the shape of the connection,
 * not a spending decision: the whole repo costs ~14 rate-limit points (measured
 * 2026-08-09 -- 1 point returned 25 issues with their timeline items), against
 * a 5,000-point hourly budget GitHub grants. The sweep runs often, so the cost
 * was measured rather than assumed; it is noise.
 *
 * Only closed issues are queried. An open issue has no resolution to render, so
 * fetching its timeline would buy nothing.
 */
async function fetchTimelines(
  owner: string,
  repo: string,
): Promise<Map<number, { stateReason: string | null; timeline: TimelineNode[] }>> {
  const byNumber = new Map<number, { stateReason: string | null; timeline: TimelineNode[] }>();
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const args = [
      "gh", "api", "graphql",
      "-f", `query=${TIMELINE_QUERY}`,
      "-F", `owner=${owner}`,
      "-F", `repo=${repo}`,
    ];
    if (cursor) args.push("-F", `cursor=${cursor}`);

    const page = JSON.parse(await run(args));
    const conn = page?.data?.repository?.issues;
    if (!conn) {
      console.error("timeline query returned no issues connection:", JSON.stringify(page).slice(0, 400));
      process.exit(1);
    }
    for (const node of conn.nodes) {
      byNumber.set(node.number, {
        stateReason: node.stateReason ?? null,
        timeline: node.timelineItems.nodes as TimelineNode[],
      });
    }
    pages++;
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  console.log(`timelines: ${byNumber.size} closed issues over ${pages} page(s)`);
  return byNumber;
}

if (!IS_MAIN) {
  // Imported for its renderer (done-means checks do this). Nothing below runs.
} else {

const listed = await run([
  "gh",
  "issue",
  "list",
  "--state",
  "all",
  "--limit",
  "1000",
  "--json",
  "number,title,state,createdAt,updatedAt,closedAt,author,labels,milestone,body,comments",
]);

const issues: Issue[] = JSON.parse(listed);
issues.sort((a, b) => a.number - b.number);

// Attach timelines so closed issues can render their Resolution. A closed issue
// missing from this map renders no Resolution rather than a false one -- the
// silence is deliberate and is pinned by the done-means check.
const repoNwo = (await run(["gh", "repo", "view", "--json", "owner,name", "-q", ".owner.login + \"/\" + .name"])).trim();
const [owner, repoName] = repoNwo.split("/");
if (!owner || !repoName) {
  // Loud, not asserted away: an unparseable repo name would otherwise send the
  // timeline query somewhere undefined and render every issue resolution-less.
  console.error(`could not parse owner/name from \`gh repo view\`: ${JSON.stringify(repoNwo)}`);
  process.exit(1);
}
const timelines = await fetchTimelines(owner, repoName);

let resolved = 0;
let unresolved = 0;
for (const i of issues) {
  if (i.state !== "CLOSED") continue;
  const t = timelines.get(i.number);
  if (!t) {
    unresolved++;
    continue;
  }
  i.stateReason = t.stateReason;
  i.timeline = t.timeline;
  resolved++;
}
if (unresolved > 0) {
  // Announced, never silent: a closed issue with no timeline renders without a
  // Resolution, and the reader is told how many rather than left to infer it.
  console.log(`note: ${unresolved} closed issue(s) had no timeline in the query result; they render without a Resolution`);
}

// A retitled issue would otherwise leave its old file behind as a stale
// duplicate that still answers searches. Keep exactly one file per number.
const keep = new Set(issues.map((i) => `${i.number}-${slug(i.title)}.md`));
const existing = new Bun.Glob("*.md").scanSync({
  cwd: OUT_DIR,
  onlyFiles: true,
});
let stale = 0;
for (const f of existing) {
  if (!keep.has(f)) {
    await Bun.file(`${OUT_DIR}/${f}`).delete();
    stale++;
  }
}

let comments = 0;
let withResolution = 0;
for (const i of issues) {
  comments += i.comments.length;
  const text = render(i);
  if (text.includes("\n## Resolution\n")) withResolution++;
  await Bun.write(`${OUT_DIR}/${i.number}-${slug(i.title)}.md`, text);
}

const open = issues.filter((i) => i.state === "OPEN").length;
console.log(
  `${issues.length} issues (${open} open, ${issues.length - open} closed), ` +
    `${comments} comments, ${withResolution} with a Resolution -> ${OUT_DIR}/` +
    (stale ? `, removed ${stale} stale` : ""),
);
// Two steps, both required: `update` re-indexes the files, `embed` builds the
// vectors semantic search needs. Skipping embed leaves the new files findable
// by keyword and invisible to `qmd query`.
console.log("Now run: qmd update -c open-brain && qmd embed");

}
