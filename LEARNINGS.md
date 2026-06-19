
## [2026-06-19] Mac-only temp path breaks env-gated tests on Linux CI
- Trigger: scripts/promote-lane-shared.test.ts used `process.env.DEV_TMP ?? "/Volumes/ThunderBolt/_tmp"` for mkdtempSync. That path is macOS-only; Linux CI runner → `ENOENT` on mkdtemp, then cascade `TypeError: path must be a string` in afterEach rmSync (tmpDir undefined).
- Fix: fall back to `node:os` `tmpdir()` not the Mac path: `process.env.DEV_TMP ?? tmpdir()`.
- Scope: any repo test that creates temp dirs and runs in both macOS dev and Linux CI. The Development CLAUDE.md `/Volumes/ThunderBolt/_tmp` rule is for agent scratch, NOT for committed test code that runs in CI.
