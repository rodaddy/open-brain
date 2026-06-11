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

- Capture MEDIUM+ review misses, accepted fixes, and new issue feedback.
- Keep entries specific to Open Brain behavior, not generic coding advice.
- Include provenance: issue or PR number, severity, source reviewer lane when
  known, and status.
- If a finding is fixed, keep the pattern if it could recur.
- If later work invalidates a pattern, mark it `Status: superseded` instead of
  deleting it.

## PR Comment Requirements

For each issue PR, the PR comment must document:

- Swarm lanes run and model/effort.
- Gotcha-agent findings from `gotcha-agent.md`.
- Findings fixed, grouped by severity.
- Findings intentionally deferred, with linked issue if any.
- Validation evidence from local tests/builds/checks.
- Whether any existing SME entry should be updated after the PR.

## Trust Model

These files are committed repo knowledge, but they are not infallible. Treat
them as active hypotheses that must be verified against current code and the
current issue acceptance criteria. Do not re-report a historical issue unless
the pattern is still present or has regressed.
