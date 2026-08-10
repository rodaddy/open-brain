#!/usr/bin/env bun
/**
 * Driver for scripts/done-means/issue-resolution-artifacts.sh.
 *
 * Feeds recorded GitHub timeline payloads through the SHIPPED renderer from
 * `scripts/sync-issues.ts` and writes one JSON receipt of what the rendered
 * artifact actually contains. It asserts nothing: the shell check owns every
 * verdict, this file owns only observation. That split is deliberate — a driver
 * that graded itself would let a green receipt describe its own expectations
 * rather than the renderer's behaviour.
 *
 * WHY IT IMPORTS RATHER THAN RE-IMPLEMENTS. Re-deriving the rendering here
 * would prove this file agrees with itself. The import is what makes the
 * measurement about `sync-issues.ts`.
 *
 * On the pre-change generator `sync-issues.ts` exports nothing and executes its
 * `gh issue list` sweep at import time. The import therefore FAILS on the
 * unfixed tree, which is the RED this driver is meant to produce; it reports
 * that failure as a receipt rather than crashing silently, so every clause in
 * the shell check stays reachable and prints.
 */

const OUT = process.env.DONE_MEANS_RESOLUTION_OUT;
if (!OUT) {
  console.error("DONE_MEANS_RESOLUTION_OUT is required (no default: a receipt written somewhere unstated is a receipt nobody reads)");
  process.exit(1);
}

const FIXTURE = new URL("./fixtures/issue-resolution-timelines.json", import.meta.url);

type Receipt = Record<string, string | number | boolean>;
const receipt: Receipt = {};

const fixture = await Bun.file(FIXTURE).json();

/** The two facts every clause needs from a fixture shape, derived not typed. */
function closerOf(shape: any) {
  return shape.timeline.find((n: any) => n.__typename === "ClosedEvent")?.closer ?? null;
}
function prByMergeSha(shape: any, sha: string) {
  return shape.timeline.find(
    (n: any) => n.__typename === "CrossReferencedEvent" && n.source?.mergeCommit?.oid === sha,
  )?.source;
}
function prByNumber(shape: any, number: number) {
  return shape.timeline.find(
    (n: any) => n.__typename === "CrossReferencedEvent" && n.source?.number === number,
  )?.source;
}

// --- import the shipped renderer -------------------------------------------
let render: ((issue: any) => string) | null = null;
let importError = "";
try {
  const mod: any = await import("../sync-issues.ts");
  if (typeof mod.render === "function") {
    render = mod.render;
  } else {
    importError = `sync-issues.ts exports no render() (keys: ${Object.keys(mod).join(",") || "none"})`;
  }
} catch (err) {
  importError = `import of sync-issues.ts threw: ${err instanceof Error ? err.message : String(err)}`;
}
receipt.render_imported = render !== null;
receipt.import_error = importError;
if (importError) console.log(`INFO  ${importError}`);

/**
 * Build the Issue object the renderer consumes from a fixture shape. The
 * body/comments are minimal on purpose: this check is about the Resolution
 * section, and the existing header/Discussion rendering is already shipped
 * behaviour that other clauses do not measure.
 */
function issueFrom(shape: any, state: "CLOSED" | "OPEN") {
  return {
    number: shape.number,
    title: shape.title,
    state,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: shape.closedAt ?? "2026-08-09T00:00:00Z",
    closedAt: state === "CLOSED" ? shape.closedAt : null,
    author: { login: "fixture" },
    labels: [],
    milestone: null,
    body: "fixture body",
    comments: [],
    stateReason: shape.stateReason,
    timeline: shape.timeline,
  };
}

function renderSafely(issue: any): { text: string; threw: boolean; error: string } {
  if (!render) return { text: "", threw: true, error: importError };
  try {
    return { text: render(issue), threw: false, error: "" };
  } catch (err) {
    return { text: "", threw: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The Resolution section only — so a match cannot come from the issue body.
 *
 * The section ends at the next TOP-LEVEL `## ` heading that is not part of the
 * quoted PR body. Because the renderer blockquotes that body, its own `## `
 * headings arrive as `> ## ` and do not terminate the section — which is
 * precisely why the quoting exists.
 */
function resolutionSection(text: string): string {
  const start = text.indexOf("## Resolution");
  if (start === -1) return "";
  const rest = text.slice(start + "## Resolution".length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The section with blockquote markers removed, for matching body content. */
function unquoted(section: string): string {
  return section
    .split("\n")
    .map((line) => (line.startsWith("> ") ? line.slice(2) : line === ">" ? "" : line))
    .join("\n");
}

// === (a) commit closer: #681 -> 31589d1 -> #687 =============================
{
  const shape = fixture.commit_closer;
  const closer = closerOf(shape);
  const sha: string = closer?.oid ?? "";
  const pr = prByMergeSha(shape, sha);

  receipt.commit_closer_issue_number = shape.number;
  receipt.commit_closer_expected_pr = pr?.number ?? "MISSING";
  receipt.commit_closer_expected_sha = sha || "MISSING";
  receipt.commit_closer_body_chars_source = (pr?.body ?? "").length;

  // A phrase from deep inside the real PR body, derived from the fixture rather
  // than typed here: a hardcoded phrase would keep passing after a re-record.
  //
  // It must be a CONTIGUOUS run of the body. The first version of this filtered
  // to long words and joined them, which fabricated a string that appears
  // nowhere in the body — so the clause failed against a correct renderer. A
  // derived expectation is only useful if it is derived from what is actually
  // there, and it is verified below before any assertion rests on it.
  const bodyLines: string[] = (pr?.body ?? "")
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 40 && !l.startsWith("#"));
  const phrase = bodyLines.length ? bodyLines[bodyLines.length - 1]! : "";
  receipt.commit_closer_expected_body_phrase = phrase || "MISSING";
  // Self-check on the expectation itself: if the phrase is not in the source
  // body, the clause would be measuring the driver's arithmetic, not the
  // renderer. Recorded so a broken derivation is visible instead of read as a
  // renderer defect.
  receipt.commit_closer_phrase_is_in_source = phrase ? (pr?.body ?? "").includes(phrase) : false;

  const { text, threw, error } = renderSafely(issueFrom(shape, "CLOSED"));
  receipt.commit_closer_rendered = text.length > 0;
  receipt.commit_closer_threw = threw;
  receipt.commit_closer_error = error;

  const section = resolutionSection(text);
  receipt.commit_closer_has_resolution = section.length > 0;
  receipt.commit_closer_has_generated_header = text.includes("GENERATED by scripts/sync-issues.ts");
  receipt.commit_closer_names_pr_number = pr ? section.includes(`#${pr.number}`) : false;
  receipt.commit_closer_names_sha = sha ? section.includes(sha) || section.includes(sha.slice(0, 7)) : false;
  receipt.commit_closer_names_merged_at = pr?.mergedAt ? section.includes(pr.mergedAt) : false;
  receipt.commit_closer_names_body = phrase ? unquoted(section).includes(phrase) : false;

  // Whether the WHOLE source body survived into the artifact.
  //
  // The renderer blockquotes the body (each line prefixed `> `) so the PR's own
  // `## ` headings cannot masquerade as artifact sections. So the measurement
  // un-quotes the rendered section and requires the result to CONTAIN the source
  // body as one contiguous, byte-identical run. Any dropped, reordered or
  // altered line makes the run non-contiguous and reports 0, so clause (a) goes
  // red rather than passing on a partial copy.
  const body: string = pr?.body ?? "";
  let carried = 0;
  if (body && section) {
    carried = unquoted(section).includes(body) ? body.length : 0;
  }
  receipt.commit_closer_body_chars_rendered = carried;
}

// === (b) direct PR closer ===================================================
{
  const shape = fixture.pr_closer;
  const closer = closerOf(shape);
  const pr = closer?.number ? prByNumber(shape, closer.number) : null;
  const { text, threw, error } = renderSafely(issueFrom(shape, "CLOSED"));
  const section = resolutionSection(text);
  receipt.pr_closer_rendered = text.length > 0;
  receipt.pr_closer_threw = threw;
  receipt.pr_closer_error = error;
  receipt.pr_closer_has_resolution = section.length > 0;
  receipt.pr_closer_names_pr_number = pr ? section.includes(`#${pr.number}`) : false;
}

// === (c) closed with no PR: #636 ============================================
{
  const shape = fixture.no_pr;
  const { text, threw, error } = renderSafely(issueFrom(shape, "CLOSED"));
  const section = resolutionSection(text);
  const closedEvent = shape.timeline.find((n: any) => n.__typename === "ClosedEvent");
  receipt.no_pr_issue_number = shape.number;
  receipt.no_pr_rendered = text.length > 0;
  receipt.no_pr_threw = threw;
  receipt.no_pr_error = error;
  receipt.no_pr_has_resolution = section.length > 0;
  receipt.no_pr_states_close_facts =
    section.includes(closedEvent?.actor?.login ?? " ") &&
    section.includes(closedEvent?.stateReason ?? " ");
  // Any `#<digits>` inside the section that is not the issue's own number would
  // be an attributed PR. The issue's own number is excluded so a heading that
  // legitimately repeats it cannot read as a false positive.
  const refs = [...section.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  receipt.no_pr_names_a_pr = refs.some((n) => n !== shape.number);
}

// === (d) control: an OPEN issue ============================================
{
  const shape = fixture.commit_closer; // same timeline, OPEN state
  const { text, threw, error } = renderSafely(issueFrom(shape, "OPEN"));
  receipt.open_issue_rendered = text.length > 0;
  receipt.open_issue_threw = threw;
  receipt.open_issue_error = error;
  receipt.open_issue_has_resolution = resolutionSection(text).length > 0;
}

await Bun.write(OUT, JSON.stringify(receipt, null, 2) + "\n");
console.log(`INFO  receipt written: ${OUT}`);
for (const key of ["render_imported", "commit_closer_has_resolution", "no_pr_rendered", "open_issue_has_resolution"]) {
  console.log(`INFO  ${key}=${receipt[key]}`);
}
