# Open Brain SME Review Knowledge

This directory is the review-swarm memory for Open Brain work. It turns prior
PR review output into reviewer-specific knowledge so future swarms do not start
from zero.

## Source Material

Seeded from:

- PR #72: OpenBrain Python client review comment and fixes
- PR #73: AgentMemory facade review comment and fixes
- PR #74: memory safety layer review comment, GitGuardian cleanup, and fixes
- PR #75: DreamEngine review comment and fixes
- PR #76: runtime model docs review comment and fixes
- Issues #77-#82: post-merge review issues created from misses in #72-#76

## How Future Swarms Should Use This

Before spawning reviewers, inject the matching SME file into that reviewer lane:

- `correctness.md` -> correctness reviewer
- `adversarial.md` -> adversarial critic
- `quality.md` -> quality reviewer
- `security.md` -> security reviewer
- `domain-backend.md` -> backend/domain reviewer
- `gotcha-agent.md` -> extra Open Brain gotcha reviewer

The gotcha reviewer is mandatory for `python/openbrain-memory/**` changes. It
exists because the first swarm cycle still missed P1/P2 issues later captured
as #77-#82.

## Capture Rules

**Write a new file in `entries/`, then run the build. Never edit a lane file.**

The six lane files (`correctness.md`, `adversarial.md`, `quality.md`,
`security.md`, `domain-backend.md`, `gotcha-agent.md`) are GENERATED. Each
carries a banner saying so. A hand edit survives exactly until the next build
and is then silently destroyed.

```bash
# 1. one file per finding; the name is the date and a slug of the title
$EDITOR docs/sme/entries/2026-08-07-my-finding-title.md

# 2. regenerate the lane indexes
bun scripts/build-sme-indexes.ts
```

An entry file is frontmatter plus the finding body, verbatim:

```markdown
---
lane: correctness
order: 66
---
## [2026-08-07] Short imperative title

**Severity:** HIGH
**Source:** PR #123
**Scope:** `src/tools/*.ts`
**Status:** active

### Pattern
...
```

`lane` picks the destination file. `order` places the entry within that lane —
append to the end by using one past the current highest, since the corpus is
NOT sorted by date and sorting it would rewrite every lane file. Optional
`section: harvest-522` places an entry under that lane's harvest divider, and
optional `gap: N` controls the blank lines emitted after the entry (default 1).

**Why one file per finding.** Every swarm lane used to append to the same six
files, and git cannot union-merge prose — on 2026-08-06 that meant three manual
union merges of `correctness.md` in one night. Two lanes writing two findings
now write two different files, and git merges them without a human.

- Capture MEDIUM+ review misses, accepted fixes, and new issue feedback.
- Keep entries specific to Open Brain behavior, not generic coding advice.
- Include provenance: issue or PR number, severity, source reviewer lane when
  known, and status.
- If a finding is fixed, keep the pattern if it could recur.
- If later work invalidates a pattern, mark it `Status: superseded` instead of
  deleting it. Superseded entries stay in `entries/` — the history matters.

## PR Comment Requirements

For each issue PR, the PR comment must document:

- Critical self-review receipt from the author/controller, kept separate from
  swarm findings.
- Swarm lanes run and model/effort.
- Gotcha-agent findings from `gotcha-agent.md`.
- Findings fixed, grouped by severity.
- Findings intentionally deferred, with linked issue if any.
- Validation evidence from local tests/builds/checks.
- Whether any existing SME entry should be updated after the PR.

The critical self-review must attack the proposed change before review swarms
or CI are treated as evidence. It should cover highest-risk changed behavior,
wrong assumptions, missing tests, migration/deploy risk, security/permission
risk, downstream client/runtime risk, rollback/cleanup concerns, fixes made
before PR, and known residual risk. If it finds a material issue, fix it before
requesting review or mark it deferred only with explicit Rico approval.

## Trust Model

These files are committed repo knowledge, but they are not infallible. Treat
them as active hypotheses that must be verified against current code and the
current issue acceptance criteria. Do not re-report a historical issue unless
the pattern is still present or has regressed.
