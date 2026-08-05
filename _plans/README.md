# _plans — local copies of what the issues say

Every issue this repo files gets a static mirror here, written **before or with**
the issue, never after it as a chore.

## Why this exists

Issue bodies live on the forge. An agent working in this repo cannot search
them, cannot diff them, and cannot recover them when a session drops. Over the
week of 2026-07-21..28 the same design decisions were re-derived several times
because the reasoning existed only in a chat transcript or an issue body that
nothing local could see.

A file here is:

- **searchable** — `_plans/` is in the qmd allowlist (`.qmd/open-brain.yml`), so
  `aqmd "..."` finds it like any other repo doc.
- **versioned** — it moves with the branch, and a change to the plan is a diff
  with an author and a reason.
- **survivable** — it does not depend on the forge being reachable, on an issue
  staying open, or on a session's context surviving compaction.

## What goes in one

The issue body, in full, plus the reasoning that produced it. If the issue says
"do X", the plan says why X and not Y, what was measured, and what is still
UNVERIFIED. The issue is the tracking artifact; the plan is the thinking.

Rejected alternatives stay in the file. The next session's most expensive
mistake is re-proposing something already ruled out, and a plan that records
only the winner cannot prevent it.

## The markdown comes first

Operator rule, 2026-07-28: **write the file, and that is what becomes the
issue.** Not "file the issue, then remember to mirror it" — that ordering
depends on a habit holding, and it did not hold. Compose the plan here, open the
issue from it, then run the sync to pick up the discussion.

## Naming

`<issue-number>-<slug>.md`, e.g. `435-436-dream-hosted-rem.md`. Plans written
before the issue exists use `draft-<slug>.md` and get renamed once the number is
known.

## `_plans/issues/` — generated mirrors, do not edit

`bun run sync-issues` writes one file per issue into `_plans/issues/`, body plus
full comment thread, and deletes files whose issue was retitled so a stale
duplicate cannot keep answering searches. **Every file there is overwritten on
each run.**

Comments are the reason it exists. An issue body says what someone thought at
the time; the comments carry the corrections that reshaped it. #390's body
describes the Light stage, but the reasoning that made it model-free is in a
comment.

## Stale-blocker sweep — run it with the mirror sync

`bun run scripts/stale-blockers.ts` names every open issue whose referenced
issues/PRs are ALL closed. GitHub auto-closes issue←PR (closing keyword on
merge) but never issue←issue — "blocked on #419" is prose to the forge, so
dependents outlive their blockers silently (operator, 2026-08-05). A flagged
issue is a CANDIDATE: verify its own acceptance against live state before
closing. Run at close-run start and end, alongside `sync-issues`.

Everything is indexed — no substantive-vs-side-quest triage. Classifying by
title misjudges, and a misfiled issue is invisible, which is the failure this is
meant to fix. Noisier search beats lost context.

Run the sync after filing or closing issues, then refresh the qmd index so new
searches see them.

## Relationship to the other doc folders

| Folder | Holds |
|---|---|
| `docs/` | how the system is designed and why — the standing reference |
| `docs/roadmap/` | explorations that may never become work |
| `docs/decisions/` | decision records extracted from closed issues |
| `_plans/` | the local mirror of open, filed work |

A plan that is finished and merged does not move; it stays as the record of what
that issue actually asked for. `docs/decisions/` is where the durable outcome is
written if the decision outlives the issue.
