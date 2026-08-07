# Salvage Index — pre-squash unique work, 2026-08-02

**Status: WRITTEN.** These are preserved patch files, not merged code and not
reviewed code. Nothing in this directory has been applied to `main`, run, or
typechecked. Treat every entry as a draft recovered from a branch that was
about to be deleted.

## Why this exists

Operator ruling, 2026-08-02: collapse the open-brain branch fleet down to one
or two branches and zero extra worktrees, with all the work brought into the
branches. This directory is the preservation half of that collapse. Before any
local branch was deleted, its unique delta against `main`
(`git diff main...<branch>`) was captured as a patch file and committed here,
so a `git branch -D` removes a pointer, never content.

Recovery of any entry:

```bash
git apply _plans/salvage/2026-08-02/<file>.patch      # or --3way
```

Branch reflogs also retain the original tips for 90 days, so this is the
second of two recovery paths, not the only one.

## What was NOT captured here

| Branch | Reason no patch file |
|---|---|
| `docs/hook-additionalcontext-inline-bound-2026-08-01` | Patch is **0 bytes** — `main...branch` is ahead 0 / behind 22. Its content already landed in `main`. Open PR **#466**; the branch lives on `origin`. |
| `outside-main` | `git diff main...outside-main` fails with **"no merge base"** — it shares no history with `main`. This is the **#483 racer junk fixture** per the 2026-08-03 sweep report (`git-buttondown.md`). Deliberately not preserved. |

## Cherry-picks attempted

The four lane branches that carried uncommitted work were salvage-committed on
their own branches first, then a real cherry-pick of that salvage commit was
attempted into this branch. Two applied; two conflicted and were aborted, and
for those the patch file is the preservation.

| Salvage commit | Branch | Cherry-pick |
|---|---|---|
| `5f1f958` | `feat/322-live-recall-gate` | **PICKED** → `801fd35` |
| `e42304d` | `feat/327-durable-memory-section` | **CONFLICT (add/add)**, aborted — `main` already carries files at both paths. Patch file only. |
| `0f9518a` | `feat/332-recall-concept-extractor` | **PICKED** → `a555888` |
| `c0170f4` | `feat/344-spool-scheduler` | **CONFLICT (content, 5 files)**, aborted — Python client diverged under it. Patch file only. |

Each of the four salvage commits was verified present inside its own patch file
before its branch was deleted; for `feat/344-spool-scheduler` all 13 salvaged
paths were confirmed individually.

## The patches

Sizes are the patch bytes; "files" is `git diff --name-only main...<branch> | wc -l`.
"behind/ahead" is `git rev-list --left-right --count main...<branch>`.

| Branch | behind/ahead | Files | Patch bytes | What it contains | Why kept |
|---|---|---|---|---|---|
| `audit/router-dedupe-matrix-2026-08-02` | 22/8 | 2 | 27,196 | Router dedupe matrix audit; hook cap-wall exemption for worktree cleanup | Open **PR #468**; head lives on origin |
| `chore/claude-md-agents-import` | 28/97 | 427 | 2,612,059 | Large CLAUDE.md/AGENTS.md import line plus Python admission-size work | Very large unmerged delta, no PR |
| `chore/cold-start-context-2026-08-02` | 22/2 | 2 | 17,329 | Measured cold-start context load, CLAUDE-only actions | Open **PR #467**; head on origin |
| `chore/openbrain-local-nats-tooling` | 98/1 | 3 | 12,478 | Local NATS bridge validator | Single unmerged commit, no PR |
| `docs/canon-seed-draft` | 23/2 | 1 | 30,776 | v2 canon seed draft with operator veto round-1 notes applied | Open **PR #462**; head on origin |
| `docs/research-index-search` | 28/1 | 2 | 4,125 | AGENTS guidance: search prior art via the research qmd index | Unmerged doc change |
| `feat/322-live-recall-gate` | 69/4 | 19 | 197,610 | Live recall gate + tonight's `docs/board-map.md` salvage commit | Salvage commit `5f1f958`; also cherry-picked |
| `feat/327-durable-memory-section` | 69/1 | 2 | 29,934 | Durable-memory context-pack section + tests; namespace-only isolation predicate argued in the header | Salvage commit `e42304d`; cherry-pick conflicted |
| `feat/332-recall-concept-extractor` | 69/1 | 2 | 32,132 | Recall concept extractor + handoff schema `openbrain.recall_concept_handoff.v1` | Salvage commit `0f9518a`; also cherry-picked |
| `feat/344-spool-scheduler` | 69/1 | 13 | 89,907 | Opt-in scheduled spool drain, TS peer + Python runtime, 2133 insertions | Salvage commit `c0170f4`; cherry-pick conflicted |
| `feat/380-raw-turns-ingest` | 41/15 | 72 | 670,465 | Raw turns ingest; code-brain expiry moves rows instead of filtering | Substantial unmerged work |
| `feat/410-uv-workspace` | 41/21 | 88 | 779,390 | uv workspace layout; #411 log-dir probe | Substantial unmerged work |
| `feat/463-context-pack-wave` | 22/19 | 108 | 655,183 | #463 rewrite: context pack + reflex pointers ported | Rewrite wave, origin head gone |
| `feat/463-curation-wave` | 22/17 | 95 | 379,699 | #463 rewrite: `get_entity` with namespace-isolation tests | Rewrite wave, origin head gone |
| `feat/463-curation-wave-2` | 22/23 | 117 | 564,659 | #463 rewrite: namespace discovery, repo facts, shared-truth promotion | Rewrite wave, origin head gone |
| `feat/463-foundation-wave` | 22/4 | 26 | 66,095 | #463 rewrite foundation; deployment tests isolated from local git env | Rewrite wave, origin head gone |
| `feat/463-gap-closure` | 22/32 | 155 | 957,457 | #463 rewrite: every named parity gap closed, four tools ported | Rewrite wave, origin head gone |
| `feat/463-memory-tools-wave` | 22/5 | 64 | 196,221 | #463 rewrite: memory-tools family ported | Rewrite wave, origin head gone |
| `feat/463-parity-net` | 22/5 | 39 | 125,592 | #463 rewrite: server parity gap map | Rewrite wave, origin head gone |
| `feat/463-phase5-remainder` | 22/34 | 163 | 1,042,413 | #463 rewrite: realtime writes, NATS config, ordered shutdown, two-worker proof | Rewrite wave, origin head gone |
| `feat/463-sdk-protocol-proof` | 22/33 | 157 | 987,450 | #463 rewrite proven over the real MCP SDK and real HTTP transport | Rewrite wave, origin head gone |
| `feat/463-search-pack-wave` | 22/17 | 95 | 443,899 | #463 rewrite: search and recall family ported | Rewrite wave, origin head gone |
| `feat/463-server-rewrite-charter` | 22/2 | 18 | 61,473 | #463 rewrite contract boundary scaffold | Rewrite wave, origin head gone |
| `feat/463-transport-wave` | 22/11 | 72 | 256,625 | #463 rewrite: transport and health shadow implementation | Rewrite wave, origin head gone |
| `feat/local-clone-autostart` | 29/1 | 4 | 9,425 | Keep the local Open Brain clone running across reboots | Unmerged dogfood tooling |
| `feat/qmd-per-repo-references` | 28/89 | 405 | 2,452,241 | Repo-local coding standards, consolidation plan, rejection-outcome design | Very large unmerged delta |
| `fix/373-nonsuperuser-restore` | 48/3 | 17 | 73,068 | #373: prove non-superuser restores | Unmerged fix |
| `fix/373-path-confinement` | 48/3 | 13 | 64,672 | #373: reject local clone symlink escapes | Unmerged security fix |
| `fix/correct-stale-spec-measurements` | 29/2 | 5 | 13,836 | Corrects stale measurements merged without verification | Unmerged doc correction |
| `fix/design-gate-operator-exemptions` | 22/7 | 2 | 4,165 | Design-gate operator exemptions (superseded by the `-v2` branch merged earlier) | Small unmerged delta |
| `goal/dream-e2e-grading` | 28/68 | 339 | 2,153,938 | Dream engine end-to-end grading goal run | Very large unmerged delta |
| `plan/fleet-rollout-0.9` | 10/1 | 1 | 33,204 | 0.9.x fleet rollout plan: three client families, one server repoint | Open **PR #500**; head on origin |
| `redo/purge-dead-db-host` | 28/23 | 39 | 319,406 | Purge of the dead DB host; #382 uncertainty recording | Substantial unmerged work |
| `rewrite/418-capture-port` | 28/130 | 580 | 3,697,997 | #418 capture port — largest rewrite line, 130 commits | Very large unmerged delta |
| `rewrite/418-hook-capabilities` | 28/135 | 580 | 3,736,366 | #418 hook capabilities — PostCompact rulings pinned to implementation commit | Largest unmerged delta, 135 commits |

## Provenance

- Prior sweep that reduced 76 branches → 40 and 32 worktrees → 5:
  `git-buttondown.md` (2026-08-03T02:54Z–03:06Z).
- This collapse run: `branch-collapse.md`.
- Both journals live in the temp workspace, which carries no persistence
  guarantee. This INDEX and its patches are the durable record, and they are
  durable because they are committed here.
