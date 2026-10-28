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
 * ADDITIVE BY DEFAULT; `--rewrite-all` IS THE LOSSY OPT-IN. Operator ruling,
 * 2026-09-03 (issue 1109): "Additive only. No lossy full re-sync of
 * _plans/issues/; mirrors regenerate additively from here (new files, existing
 * Resolution sections untouched)."
 *
 * The reason is a property of the MIGRATED forge, not of this renderer. It
 * serves no user record for pre-migration authors and returns no timeline for
 * 115 closed issues, so a faithful full re-run renders those mirrors WITHOUT
 * the Resolution sections that are already committed. The old write path
 * overwrote every file unconditionally and deleted every file outside the
 * current keep set, which turns that gap into permanent loss of the reasoning
 * the mirrors exist to preserve --
 * docs/decisions/archaeology-survives-the-squash.md forbids exactly that.
 *
 * So by default this writes only files that are ABSENT, skips every file that
 * already exists, and leaves stale files in place. Passing `--rewrite-all`
 * restores the original overwrite-and-prune behavior; it is lossy against a
 * forge that cannot serve the timelines, and is only correct when the operator
 * has decided the re-render is faithful. Either way the counts are announced,
 * per this repo's "nothing is adjusted silently" rule.
 *
 * CROSS-REFERENCES ARE NOT A LIST OF CLOSING PRs. #659 is cross-referenced by
 * four PRs and closed by one. They are used ONLY to resolve a closing COMMIT to
 * the PR whose merge commit it is. Listing candidates would put several
 * directions on an issue that took one and leave the reader unable to tell
 * which -- an ambiguous answer fails the ruling as surely as a missing one.
 */

import { existsSync, globSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  forgeGet,
  forgeListComments,
  forgeListPaged,
  type ForgeComment,
} from "./forge-api.ts";

/**
 * Where the mirror is written. Overridable so a fixture run can prove the
 * sweep end to end without writing into the repository's own mirror.
 */
const OUT_DIR = process.env.SYNC_ISSUES_OUT_DIR ?? "_plans/issues";

/**
 * The lossy opt-in. Absent (the default), the sweep is additive: absent files
 * are written, existing files are left exactly as committed, and stale files
 * are left in place. See the header for why the default is not a full mirror.
 */
const REWRITE_ALL = process.argv.includes("--rewrite-all");

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
  /**
   * True when the closer was INFERRED rather than reported. Forgejo records no
   * closer on a close event, so it is recovered from the merged cross-
   * references; the rendered linkage says which of the two it was.
   */
  closerInferred?: boolean;
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

/**
 * The retired production host, removed from everything the mirror writes.
 *
 * Operator ruling 2026-10-04 (issue 1678): the host is retired and its name leaves
 * the tree. Forge titles and bodies still carry it, so redacting the mirror by
 * hand would be undone on the next sync; the generator does it instead. The
 * name and address are built from parts, the same family the purge checks in
 * scripts/done-means/retired-host-purge-*.sh match, so this file does not name
 * the host either. The address match refuses a trailing digit, so a
 * neighbouring address is left alone.
 */
const RETIRED_HOST_NAME = new RegExp("oldhost" + "01", "gi");
const RETIRED_HOST_IP = new RegExp("10\\.0\\.1\\." + "21(?!\\d)", "g");

export function redactRetiredHost(text: string): string {
  return text
    .replace(RETIRED_HOST_NAME, "retired-host")
    .replace(RETIRED_HOST_IP, "retired-host-ip");
}

/** Filesystem-safe, stable, and readable in a search hit. */
export function slug(title: string): string {
  return redactRetiredHost(title)
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
/** A field the forge may not have recorded, rendered without inventing one. */
function orUnknown(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "unknown";
  return value;
}

/** When the issue was closed, preferring the timeline event over the row. */
function closedAtOf(i: Issue, closedEvent: TimelineNode | undefined): string {
  return orUnknown(closedEvent?.createdAt ?? i.closedAt);
}

/** Who closed the issue, per the timeline event. */
function closedByOf(closedEvent: TimelineNode | undefined): string {
  return orUnknown(closedEvent?.actor?.login);
}

/** Why the issue was closed, preferring the timeline event over the row. */
function stateReasonOf(i: Issue, closedEvent: TimelineNode | undefined): string {
  return orUnknown(closedEvent?.stateReason ?? i.stateReason);
}

/** The closing pull request and the sentence explaining how it was linked. */
type Closure = { pr: TimelineNode["source"] | null; linkage: string };

/** Cross-referenced pull requests, the only source of a closing PR's body. */
function crossReferencedPulls(timeline: TimelineNode[]): TimelineNode[] {
  return timeline.filter(
    (n) =>
      n.__typename === "CrossReferencedEvent" && n.source?.__typename === "PullRequest",
  );
}

/** The last ClosedEvent on the timeline, or undefined when there is none. */
function closedEventOf(timeline: TimelineNode[]): TimelineNode | undefined {
  return timeline.filter((n) => n.__typename === "ClosedEvent").pop();
}

/**
 * Resolve the closer to a pull request.
 *
 * A PullRequest closer carries only its number, so the cross-reference is what
 * supplies title and body; when the reference is absent the number is still the
 * truth and is rendered alone. A Commit closer is correlated by merge SHA.
 */
/** The pull-request-closer branch: the cross-reference supplies title and body. */
function closureFromPull(
  number: number,
  crossRefs: TimelineNode[],
  inferred: boolean,
): Closure {
  const found = crossRefs.find((n) => n.source?.number === number)?.source;
  return {
    pr: found ?? { __typename: "PullRequest", number },
    linkage: inferred
      ? "Inferred: the forge records no closer on a close event, and this is the last pull request merged at or before the close."
      : "The forge recorded this pull request as the closer.",
  };
}

/** The commit-closer branch: correlate the SHA against merge commits. */
function closureFromCommit(sha: string, crossRefs: TimelineNode[]): Closure {
  const pr = crossRefs.find((n) => n.source?.mergeCommit?.oid === sha)?.source ?? null;
  return {
    pr,
    linkage: pr
      ? `Closed by commit \`${sha}\`, which is the merge commit of this pull request.`
      : `Closed by commit \`${sha}\`. No cross-referenced pull request has that merge commit, so the PR could not be identified from the timeline.`,
  };
}

/**
 * Resolve the closer to a pull request.
 *
 * A PullRequest closer carries only its number, so the cross-reference is what
 * supplies title and body; when the reference is absent the number is still the
 * truth and is rendered alone. A Commit closer is correlated by merge SHA.
 */
function closureOf(
  closer: NonNullable<TimelineNode["closer"]> | null,
  crossRefs: TimelineNode[],
  inferred = false,
): Closure {
  if (closer?.__typename === "PullRequest") {
    return closureFromPull(closer.number, crossRefs, inferred);
  }
  if (closer?.__typename === "Commit") {
    return closureFromCommit(closer.oid, crossRefs);
  }
  return { pr: null, linkage: "" };
}

/**
 * The closing PR's body, quoted line by line.
 *
 * Reproduced BYTE-FOR-BYTE, and quoted rather than inlined. Both halves matter
 * and were found by this change's own check:
 *
 *  - Byte-for-byte: even trimming the trailing newline makes the artifact a
 *    paraphrase of the PR rather than a copy of it, and the whole point is that
 *    the reasoning survives intact.
 *
 *  - Quoted: PR bodies in this repo carry their OWN `## Summary`,
 *    `## Verification`, `## Critical Self-Review` headings. Inlined, those
 *    become top-level sections of the artifact, so the PR's structure
 *    masquerades as the issue's and a reader (or a section-scoped search)
 *    cannot tell where the quoted body ends. Blockquoting keeps every line
 *    inside the Resolution while leaving the text readable and searchable.
 */
function quotedBody(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
}

/** The header facts of a resolved closure, one bullet each. */
function resolvedHeader(
  i: Issue,
  pr: NonNullable<TimelineNode["source"]>,
  linkage: string,
  closedEvent: TimelineNode | undefined,
): string[] {
  const title = pr.title ? ` — ${pr.title}` : "";
  return [
    `Closed by **PR #${pr.number}**${title}`,
    "",
    `- Linkage: ${linkage}`,
    `- Merge commit: \`${orUnknown(pr.mergeCommit?.oid)}\``,
    `- Merged at: ${orUnknown(pr.mergedAt)}`,
    `- PR state: ${orUnknown(pr.state)}`,
    `- Issue closed: ${closedAtOf(i, closedEvent)} by ${closedByOf(closedEvent)} (${stateReasonOf(i, closedEvent)})`,
    "",
  ];
}

/** The quoted PR body, or the statement that there is none to quote. */
function resolvedBody(pr: NonNullable<TimelineNode["source"]>): string[] {
  if (!pr.body?.trim()) {
    return [
      `_The closing PR has no body, so the reasoning behind this direction was never written down._`,
      "",
    ];
  }
  return [
    `### Direction taken and why — PR #${pr.number} body`,
    "",
    quotedBody(pr.body),
    "",
  ];
}

/** The Resolution body for a closed issue that names a pull request. */
function resolvedLines(
  i: Issue,
  pr: NonNullable<TimelineNode["source"]>,
  linkage: string,
  closedEvent: TimelineNode | undefined,
): string[] {
  return [...resolvedHeader(i, pr, linkage, closedEvent), ...resolvedBody(pr)];
}

/** Where the closing rationale might be, when no pull request closed it. */
function rationalePointer(i: Issue): string[] {
  const lastComment = i.comments?.[i.comments.length - 1];
  if (!lastComment) return [];
  const who = orUnknown(lastComment.author?.login);
  return [
    `The closing rationale, if it was written anywhere, is in the discussion below — most recently by ${who} on ${lastComment.createdAt}.`,
    "",
  ];
}

/**
 * The Resolution body for a closed issue no pull request closed.
 *
 * States what the timeline actually has and names no PR: an issue closed
 * without one is a real outcome, and saying so is the honest artifact.
 */
function unresolvedLines(
  i: Issue,
  closer: NonNullable<TimelineNode["closer"]> | null,
  linkage: string,
  closedEvent: TimelineNode | undefined,
): string[] {
  const commit = closer?.__typename === "Commit" ? [`- ${linkage}`, ""] : [];
  return [
    "Closed without a pull request.",
    "",
    `- Issue closed: ${closedAtOf(i, closedEvent)} by ${closedByOf(closedEvent)}`,
    `- State reason: ${stateReasonOf(i, closedEvent)}`,
    "",
    ...commit,
    ...rationalePointer(i),
  ];
}
/**
 * The Resolution section for a closed issue: the direction taken and why.
 *
 * Returns "" for an open issue, or for a closed one whose timeline was never
 * fetched -- an artifact that cannot see the timeline must stay silent rather
 * than assert the issue resolved itself.
 *
 * Three shapes: the closer is a pull request, the closer is a commit whose SHA
 * matches a cross-referenced PR's merge commit, or there is no closer at all
 * (closed by hand). The third renders what the timeline actually has and names
 * no PR.
 *
 * The closing PR's BODY is reproduced IN FULL. It is the direction-and-why
 * payload -- in this repo it carries the done-means RED/GREEN evidence and the
 * critical self-review -- so a link without it would record that something
 * happened while losing the reasoning this whole artifact exists to preserve.
 */
function resolutionOf(i: Issue): string {
  if (i.state !== "CLOSED" || !i.timeline?.length) return "";

  const closedEvent = closedEventOf(i.timeline);
  const closer = closedEvent?.closer ?? null;
  const { pr, linkage } = closureOf(
    closer,
    crossReferencedPulls(i.timeline),
    closedEvent?.closerInferred === true,
  );

  const body = pr?.number
    ? resolvedLines(i, pr, linkage, closedEvent)
    : unresolvedLines(i, closer, linkage, closedEvent);

  return ["## Resolution", "", ...body].join("\n");
}

/** One issue as mirror markdown, with the retired host redacted throughout. */
export function render(i: Issue): string {
  return redactRetiredHost(renderRaw(i));
}

function renderRaw(i: Issue): string {
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
      (c) => `### ${c.author?.login ?? "unknown"} — ${c.createdAt}\n\n${c.body.trim()}`,
    )
    .join("\n\n---\n\n");

  return `${withResolution}\n---\n\n## Discussion (${i.comments.length})\n\n${thread}\n`;
}

/** Run a command to completion, returning stdout and failing loudly. */
/**
 * ---------------------------------------------------------------------------
 * READING THE FORGE
 * ---------------------------------------------------------------------------
 * This repo moved off GitHub on 2026-08-30; `origin` is git.example.internal and
 * `gh` does not reach it, so the three shell-outs this script used to make --
 * `gh issue list`, `gh api graphql` for timelines, and `gh repo view` for the
 * owner/name -- returned nothing at all. Every read now goes through
 * scripts/forge-api.ts, which owns the base URL, the auth header and the error
 * shape in one place.
 *
 * WHAT FORGEJO ACTUALLY RETURNS, measured against git.example.internal on
 * 2026-08-30 rather than assumed. Three differences drive the code below:
 *
 *  1. `/issues` MIXES PULL REQUESTS IN. `gh issue list` returned issues only;
 *     Forgejo's list returned 23 pull requests among 30 rows on page 1. A row
 *     carrying a `pull_request` object is a PR and is dropped, otherwise the
 *     mirror would fill with PR files nobody asked for and the counts would lie.
 *
 *  2. THE TIMELINE HAS NO CLOSER. Forgejo's `close` event carries an empty
 *     `ref_commit_sha` and a null `ref_issue` -- measured on issues 1011 and
 *     1018, whose closing pull requests 1023 and 1032 are recorded nowhere on
 *     the close event itself. GitHub's `closer { PullRequest | Commit }` has no
 *     equivalent here, so the closing PR is resolved from the MERGED `pull_ref`
 *     rows instead: the last one merged at or before the close time.
 *
 *  3. THE CROSS-REFERENCE CARRIES NO MERGE COMMIT. A `pull_ref` row's
 *     `ref_issue.pull_request` has `merged`, `merged_at`, `draft` and
 *     `html_url` -- no SHA. The rendered `Merge commit:` line therefore reads
 *     `unknown` on this forge, which is honest; inventing a SHA would be worse.
 *
 * The renderer is UNCHANGED and still consumes the internal `TimelineNode`
 * shape. Forgejo's rows are adapted into it by `adaptTimeline` below, so the
 * recorded fixtures in scripts/done-means/fixtures/ keep measuring the same
 * renderer they always did.
 */

/** One row of Forgejo's `/issues/{n}/timeline`. */
type ForgeTimelineRow = {
  type: string;
  created_at: string;
  body?: string | null;
  user?: { login?: string } | null;
  ref_commit_sha?: string | null;
  ref_issue?: {
    number: number;
    title?: string;
    state?: string;
    body?: string;
    pull_request?: { merged?: boolean; merged_at?: string | null } | null;
  } | null;
};

/** One row of Forgejo's `/issues?state=all` list. */
type ForgeIssueRow = {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user?: { login?: string } | null;
  labels?: { name: string }[] | null;
  milestone?: { title: string } | null;
  pull_request?: unknown;
};

/** Forgejo says "open"/"closed"; the renderer and its fixtures say "CLOSED". */
function upperState(state: string): string {
  return state.toUpperCase();
}

/**
 * Forgejo timeline rows, adapted to the internal shape the renderer consumes.
 *
 * Only the event types the renderer actually reads are mapped. `close` becomes
 * a ClosedEvent, and each merged `pull_ref` becomes a CrossReferencedEvent
 * carrying the pull request's title, state, merged-at and body. Everything else
 * on the timeline -- comments, pushes, branch deletions, label changes -- is
 * dropped, because the renderer has no use for it and carrying it would only
 * widen the surface a future reader has to reason about.
 */
/** A Forgejo `close` row, as the ClosedEvent the renderer consumes. */
function closeNode(row: ForgeTimelineRow): TimelineNode {
  return {
    __typename: "ClosedEvent",
    createdAt: row.created_at,
    actor: row.user?.login ? { login: row.user.login } : null,
    // Forgejo records no state reason on a close, and no closer either. The
    // closer is recovered from the merged pull_ref rows instead.
    stateReason: null,
    closer: null,
  };
}

/** A Forgejo `pull_ref` row, as the CrossReferencedEvent the renderer reads. */
function pullRefNode(
  ref: NonNullable<ForgeTimelineRow["ref_issue"]>,
  createdAt: string,
): TimelineNode {
  const pull = ref.pull_request;
  return {
    __typename: "CrossReferencedEvent",
    createdAt,
    source: {
      __typename: "PullRequest",
      number: ref.number,
      title: ref.title,
      state: ref.state ? upperState(ref.state) : undefined,
      mergedAt: pull?.merged ? (pull.merged_at ?? null) : null,
      // Forgejo's cross-reference carries no merge SHA. Left absent rather than
      // guessed; the renderer prints "unknown" for it.
      mergeCommit: null,
      body: ref.body,
    },
  };
}

/**
 * Forgejo timeline rows, adapted to the internal shape the renderer consumes.
 *
 * Only the event types the renderer actually reads are mapped. `close` becomes
 * a ClosedEvent, and each `pull_ref` becomes a CrossReferencedEvent carrying
 * the pull request's title, state, merged-at and body. Everything else on the
 * timeline -- comments, pushes, branch deletions, label changes -- is dropped,
 * because the renderer has no use for it and carrying it would only widen the
 * surface a future reader has to reason about.
 */
function adaptTimeline(rows: ForgeTimelineRow[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  for (const row of rows) {
    if (row.type === "close") {
      nodes.push(closeNode(row));
    } else if (row.type === "pull_ref" && row.ref_issue) {
      nodes.push(pullRefNode(row.ref_issue, row.created_at));
    }
  }
  return nodes;
}

/**
 * Point the ClosedEvent at the pull request that actually closed the issue.
 *
 * Forgejo does not record a closer, so it is inferred: of the merged pull
 * requests cross-referencing this issue, the last one merged at or before the
 * close. Issue 1021 cross-references two merged pull requests (1023 and 1032)
 * and issue 1011 exactly one, which is why "the merged one" is not enough and
 * the close time is the discriminator.
 *
 * When nothing qualifies the closer stays null and the renderer says the issue
 * was closed without a pull request -- the honest answer, not a guess.
 */
function attachInferredCloser(nodes: TimelineNode[]): TimelineNode[] {
  const closed = nodes.find((n) => n.__typename === "ClosedEvent");
  if (!closed) return nodes;

  const closedAt = Date.parse(closed.createdAt ?? "");
  const merged = nodes
    .filter((n) => n.__typename === "CrossReferencedEvent" && n.source?.mergedAt)
    .map((n) => ({ node: n, at: Date.parse(n.source?.mergedAt ?? "") }))
    .filter((m) => Number.isFinite(m.at))
    .sort((a, b) => a.at - b.at);

  const inWindow = Number.isFinite(closedAt)
    ? merged.filter((m) => m.at <= closedAt)
    : merged;
  const chosen = (inWindow.length ? inWindow : merged).pop();
  if (chosen?.node.source?.number) {
    closed.closer = {
      __typename: "PullRequest",
      number: chosen.node.source.number,
    };
    closed.closerInferred = true;
  }
  return nodes;
}

/**
 * Timelines for every CLOSED issue, keyed by number.
 *
 * Only closed issues are fetched: an open issue has no resolution to render, so
 * reading its timeline would buy nothing. One request per closed issue is the
 * shape Forgejo offers -- there is no batch timeline endpoint -- and the reads
 * are sequential so a sweep never opens a burst of connections at the forge.
 */
async function fetchTimelines(numbers: number[]): Promise<Map<number, TimelineNode[]>> {
  const byNumber = new Map<number, TimelineNode[]>();
  for (const n of numbers) {
    const rows = await forgeGet<ForgeTimelineRow[]>(`/issues/${n}/timeline`);
    if (!Array.isArray(rows)) {
      // Measured against git.example.internal on 2026-08-31: this endpoint returns
      // a bare `null` for some migrated issues (#9 among them) rather than an
      // empty array. Announced, never silent, and skipped rather than fatal --
      // aborting the whole sweep over one unreadable timeline would leave the
      // mirror half-written, and the renderer already stays silent about a
      // Resolution it cannot see.
      console.log(
        `note: the forge returned no timeline for #${n}; it renders without a Resolution`,
      );
      continue;
    }
    byNumber.set(n, attachInferredCloser(adaptTimeline(rows)));
  }
  console.log(`timelines: ${byNumber.size} closed issue(s)`);
  return byNumber;
}

/**
 * A comment row as the forge returns it.
 *
 * `ForgeComment` from forge-api.ts carries the fields every caller needs; the
 * author is read here as well, so the local shape widens it rather than casting
 * at each use.
 */
type ForgeCommentRow = ForgeComment & { user?: { login?: string } | null };

/** An author login, as the renderer's optional actor shape. */
function loginOf(user: { login?: string } | null | undefined) {
  return user?.login ? { login: user.login } : null;
}

/** A Forgejo issue row, adapted to the shape the renderer consumes. */
function adaptIssue(row: ForgeIssueRow, comments: ForgeCommentRow[]): Issue {
  return {
    number: row.number,
    title: row.title,
    state: upperState(row.state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? null,
    author: loginOf(row.user),
    labels: (row.labels ?? []).map((l) => ({ name: l.name })),
    milestone: row.milestone ? { title: row.milestone.title } : null,
    body: row.body ?? "",
    comments: comments.map((c) => ({
      author: loginOf(c.user),
      createdAt: c.created_at,
      body: c.body,
    })),
  };
}

/**
 * Every issue in the repo, pull requests excluded, each with its comments.
 *
 * `forgeListPaged` owns the walk, including the stop condition this forge needs
 * (its list endpoints ignore `?page=` and repeat page 1). Rows are keyed by
 * `id`, which is unique across issues and pull requests alike.
 */
async function fetchIssues(): Promise<Issue[]> {
  const rows = await forgeListPaged<ForgeIssueRow>(
    "/issues?state=all",
    (row) => row.id,
  );
  const issuesOnly = rows.filter((row) => !row.pull_request);
  const dropped = rows.length - issuesOnly.length;
  if (dropped > 0) {
    // Announced, never silent: the forge list mixes pull requests in and the
    // reader is told how many were dropped rather than left to infer it.
    console.log(
      `note: ${dropped} of ${rows.length} rows from /issues were pull requests and were not mirrored`,
    );
  }

  const issues: Issue[] = [];
  for (const row of issuesOnly) {
    const comments = await forgeListComments(row.number);
    issues.push(adaptIssue(row, comments));
  }
  return issues;
}

/**
 * `--check`: prove the forge is readable and the rows have the shape the
 * renderer needs, WITHOUT writing anything.
 *
 * One page, not the whole sweep. The question a check answers is whether the
 * reader still works against the live forge -- credentials, base URL, row
 * shape -- and a full sweep would answer it slowly while rewriting 400 files
 * as a side effect, which is exactly what a check must not do.
 */
async function checkOnly(): Promise<number> {
  const rows = await forgeGet<ForgeIssueRow[]>("/issues?state=all&page=1");
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error("check: /issues?state=all returned no rows");
    return 1;
  }
  const issuesOnly = rows.filter((row) => !row.pull_request);
  const sample = issuesOnly[0] ?? rows[0];
  if (
    !sample ||
    typeof sample.number !== "number" ||
    typeof sample.title !== "string"
  ) {
    console.error("check: the first row has no number/title; the row shape changed");
    return 1;
  }
  console.log(
    `check: ${rows.length} rows on page 1 (${issuesOnly.length} issues, ` +
      `${rows.length - issuesOnly.length} pull requests); shape ok, nothing written`,
  );
  return 0;
}

if (!IS_MAIN) {
  // Imported for its renderer (done-means checks do this). Nothing below runs.
} else if (process.argv.includes("--check")) {
  process.exit(await checkOnly());
} else {
  const issues = await fetchIssues();
  issues.sort((a, b) => a.number - b.number);

  // Attach timelines so closed issues can render their Resolution. A closed issue
  // missing from this map renders no Resolution rather than a false one -- the
  // silence is deliberate and is pinned by the done-means check.
  const closedNumbers = issues.filter((i) => i.state === "CLOSED").map((i) => i.number);
  const timelines = await fetchTimelines(closedNumbers);

  let unresolved = 0;
  for (const i of issues) {
    if (i.state !== "CLOSED") continue;
    const timeline = timelines.get(i.number);
    if (!timeline) {
      unresolved++;
      continue;
    }
    i.timeline = timeline;
  }
  if (unresolved > 0) {
    // Announced, never silent: a closed issue with no timeline renders without a
    // Resolution, and the reader is told how many rather than left to infer it.
    console.log(
      `note: ${unresolved} closed issue(s) had no timeline in the query result; they render without a Resolution`,
    );
  }

  // OUT_DIR must exist before either the scan below or the writes further down.
  // The Bun-runtime writer this replaced created missing parents implicitly;
  // writeFile does not, so on a fresh checkout -- or with SYNC_ISSUES_OUT_DIR
  // pointed at a new fixture directory -- the sweep would fail with ENOENT.
  await mkdir(OUT_DIR, { recursive: true });

  // A retitled issue would otherwise leave its old file behind as a stale
  // duplicate that still answers searches. Keep exactly one file per number.
  const keep = new Set(issues.map((i) => `${i.number}-${slug(i.title)}.md`));
  const existing = globSync("*.md", {
    cwd: OUT_DIR,
    withFileTypes: false,
  });
  let stale = 0;
  let staleLeft = 0;
  for (const f of existing) {
    if (keep.has(f)) continue;
    if (REWRITE_ALL) {
      await rm(`${OUT_DIR}/${f}`);
      stale++;
    } else {
      // Additive default: a file outside the keep set is NOT proof of a retitle.
      // It is equally a mirror this run could not see, and deleting it destroys
      // the committed Resolution it carries. Counted and reported, never removed.
      staleLeft++;
    }
  }

  let comments = 0;
  let withResolution = 0;
  let written = 0;
  let skipped = 0;
  for (const i of issues) {
    comments += i.comments.length;
    const path = `${OUT_DIR}/${i.number}-${slug(i.title)}.md`;
    if (!REWRITE_ALL && existsSync(path)) {
      // The committed file may carry a Resolution this run cannot re-derive.
      // Skipping it is the whole point of the additive default.
      skipped++;
      continue;
    }
    const text = render(i);
    if (text.includes("\n## Resolution\n")) withResolution++;
    await writeFile(path, text);
    written++;
  }

  const open = issues.filter((i) => i.state === "OPEN").length;
  console.log(
    `${issues.length} issues (${open} open, ${issues.length - open} closed), ` +
      `${comments} comments -> ${OUT_DIR}/`,
  );
  // Nothing is adjusted silently: the reader is told what this run did and did
  // NOT do, and which flag would have made it do the rest.
  if (REWRITE_ALL) {
    console.log(
      `mode --rewrite-all (LOSSY): wrote ${written} file(s), ` +
        `${withResolution} with a Resolution, removed ${stale} stale`,
    );
  } else {
    console.log(
      `mode additive (default): wrote ${written} new file(s), ` +
        `${withResolution} of them with a Resolution; ` +
        `skipped ${skipped} file(s) that already exist; ` +
        `left ${staleLeft} stale file(s) in place ` +
        `(pass --rewrite-all to overwrite and remove them -- lossy, see the header)`,
    );
  }
  // Two steps, both required: `update` re-indexes the files, `embed` builds the
  // vectors semantic search needs. Skipping embed leaves the new files findable
  // by keyword and invisible to `qmd query`.
  console.log("Now run: qmd update -c open-brain && qmd embed");
}
