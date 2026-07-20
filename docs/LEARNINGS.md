
## [2026-06-19] Mac-only temp path breaks env-gated tests on Linux CI
- Trigger: scripts/promote-lane-shared.test.ts used `process.env.DEV_TMP ?? "/Volumes/ThunderBolt/_tmp"` for mkdtempSync. That path is macOS-only; Linux CI runner → `ENOENT` on mkdtemp, then cascade `TypeError: path must be a string` in afterEach rmSync (tmpDir undefined).
- Fix: fall back to `node:os` `tmpdir()` not the Mac path: `process.env.DEV_TMP ?? tmpdir()`.
- Scope: any repo test that creates temp dirs and runs in both macOS dev and Linux CI. The Development CLAUDE.md `/Volumes/ThunderBolt/_tmp` rule is for agent scratch, NOT for committed test code that runs in CI.

## [2026-06-19] ReDoS: bounding inner segments doesn't fix an unanchored `*` prefix
- Trigger: secret-pattern regex `[a-z][a-z0-9+.-]*://...` was O(n^2). I "fixed" it by bounding the userinfo segments {1,256} and verified with 4ms on a colon-heavy input — FALSE POSITIVE. The blowup is the unanchored `*`-quantified PREFIX, which the engine restarts at every input position (triggers even on plain text with no `://`).
- Fix: replace the wildcard scheme prefix with a FIXED alternation `(?:https?|postgres|...)://`. Removes the restart-rescan. Verify with a SCALING test (10k/20k/40k/80k) on input that hits the prefix (e.g. "a"*n), asserting linear/sub-second — not a single small input.
- Scope: any secret/validation regex run on user/agent content. A ReDoS regression test (sub-second @ 80k) is cheap insurance.
- Meta-lesson: when verifying a ReDoS fix, the test input must exercise the SPECIFIC backtracking path, not just "some big string." I declared fixed on the wrong input twice this session.
