---
lane: correctness
severity: MEDIUM
status: active
order: 105
provenance: "issue 864 L5 embedding move; found by a combined test run, not by review"
---

# A process-wide settings reader must be restored by whoever replaced it

When a module's configuration moves out of `process.env` and into an injected
reader, the reader lives in ONE module-level slot for the whole process. Whoever
installs a reader owns putting the previous one back.

`server/embedding/provider.ts` holds `let readSettings` and
`setEmbeddingSettingsReader(read)`. Two callers register: the `src/` adapter
registers an env parse at import, and `server/main.ts` registers a config-backed
reader when a server starts. Last writer wins, which is correct at runtime — a
started server should answer from its own config.

It is wrong the moment a server STOPS. `startServer` originally registered and
never restored, so a server that started and shut down left its own config
answering for everything that ran afterwards. In a test process, "afterwards" is
the next test file.

The receipt: `server/main.pg.test.ts` and `src/operator-doctor.test.ts` in one
run were 114 pass / 0 fail before the move, 112 pass / 2 fail after it, and 151
pass / 0 fail once `shutdown` restored the reader. The two failures were in
`src/operator-doctor.test.ts`, which sets `EMBEDDING_BASE_URL` at test time and
expects the provider to see it — it never did again, because a dead server's
reader was still installed.

**What to check in review.** For any injected singleton (a reader, a clock, a
spawner, a transport):

- Does the setter RETURN the value it replaced? If not, restoration is
  impossible and the design is already wrong.
- Does every caller that replaces it restore it on every exit path — normal
  shutdown AND failed start? A `try/finally` around the shutdown body is the
  cheap shape.
- Neither file's own tests catch this. Each passes alone; only the combined run
  shows it. When a change introduces a process-wide slot, run the new module's
  tests TOGETHER with the tests of anything that starts a server, in one
  process, and compare the count to the same combined run at `origin/main`. A
  per-file green is not evidence here.

This is the same class as the `mock.module` leak entry: shared mutable
process-wide state whose contamination is invisible to any single-file run.
