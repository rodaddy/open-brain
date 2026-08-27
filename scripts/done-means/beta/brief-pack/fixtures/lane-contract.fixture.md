# Lane Contract — Fixture

Status: WRITTEN 2026-08-27 (fixture).

## Ground rules

1. **Branch before work, never on `main`.**
2. **Done-means first, RED first.**
3. **The checker declares done, never the lane.**
4. **Truth grammar on every claim:** RUNNING / MERGED / WRITTEN / PROPOSED.

## Class vocabulary

Fixture vocabulary.

## Tightenings

- **2026-08-24 — A skill's executables that live outside the repo drift silently.**
  (provenance: PR #329.) Executables a skill owns live in that skill's `scripts/`; runtime homes get copies, never originals.

- **2026-08-23 — A bash entrypoint written on a Mac breaks on the cc-* boxes.**
  (provenance: lane report L-04.) Associative arrays and `mapfile` are bash 4; every entrypoint is bash-3.2 clean or it is broken on Linux.

- **2026-08-22 — Bare `node` off PATH resolves to nothing under launchd.**
  (provenance: PR #331.) System-invoked entrypoints exec the absolute node@24 keg path, never a bare name.

- **2026-08-21 — A check that exits 0 having examined nothing reads as a pass.**
  (provenance: issue #302.) Empty input is exit 3, never exit 0.

- **2026-08-20 — Truncating a brief to fit a budget hides the omission.**
  (provenance: lane report L-11.) Fail closed and list what was excluded; never silently drop.

- **2026-08-19 — `git worktree remove` is the only correct teardown.**
  (provenance: audit 07-30.) A plain `rm -rf` strands the .git/worktrees registration.

- **2026-08-18 — A green that was never red proves nothing.**
  (provenance: controller contract.) Capture the RED transcript before the fix.

- **2026-08-17 — Staging with `git add -A` sweeps another session's files.**
  (provenance: ArmPros incident.) Stage by explicit path and diff --cached before commit.

- **2026-08-16 — A localhost bind on 7141 shadows the librarian daemon.**
  (provenance: dev#219.) Local dev servers take 7100-7199 minus 7141.

- **2026-08-15 — Secrets leak through fixtures more often than through code.**
  (provenance: review swarm.) Fixtures are scanned like source.

- **2026-08-14 — Token estimates diverge between tokenizers.**
  (provenance: lane report L-07.) Declare the estimator: ceil(chars/4).

- **2026-08-13 — A TypeScript enum cannot be type-stripped.**
  (provenance: STANDARDS-typescript.md.) Use a string-literal union in new code.
