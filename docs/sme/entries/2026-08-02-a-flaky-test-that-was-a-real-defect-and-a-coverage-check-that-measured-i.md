---
lane: correctness
order: 49
---
## A "flaky test" that was a real defect, and a coverage check that measured itself

**Provenance:** issue #498, PR for `fix/498-chunk-write-flake`. Severity: HIGH.
Status: active.

`src/chunk-write.pg.test.ts` was intermittently red on the shared-Postgres CI
runner with a 5000ms timeout and a `thoughts_parent_id_fkey` violation. It was
filed, reasonably, as runner contention: non-deterministic, passing locally in
1.6s, and the isolated `db-integration` job was always green. The proposed
options were all infrastructure ones, plus "raise the timeout."

The cause was a product bug. `chunkText` did not terminate its loop: once `end`
clamped to `text.length` it stayed pinned there, so `end - overlap` stopped
advancing and the `start + 1` progress floor crawled the cursor forward ONE
CHARACTER per iteration, emitting a shrinking copy of the tail for each
remaining character. A 14,000-char entry produced 410 chunks instead of ~11,
ending with a chunk whose text was `"."`.

The tell was available without any CI access: **the spurious count tracked
`overlap`, not the input.** Same text at overlap=400 gave 410 chunks; at
overlap=200, 208. A count that moves with a tuning parameter and not with the
data is not a slow test, it is a wrong loop.

The cost was never limited to CI. `embedText` (`src/embedding.ts`) spends one
network embed call per segment, so every long entry in production paid ~400
round-trips instead of ~11, and `log-thought` wrote the junk rows to `thoughts`.
Raising the timeout would have removed the only signal pointing at it.

The second trap was in the fix's own verification. Three drafts of the coverage
check located chunks with `text.indexOf(chunk.text)`, which is unsound for
repetitive text: `indexOf` matches an EARLIER identical occurrence, so the cover
map fills at wrong offsets and reports phantom gaps. Chunk 1 truly began at
offset 1209; `indexOf` anchored it at 19, because the phrase repeated every 35
characters. Each draft was caught only by running it against the buggy AND the
fixed chunker and getting byte-identical failures from both.

### Review Questions

- Is a "flaky infrastructure" test actually flaky? Before accepting contention,
  slowness, or load as the cause, ask what work the test performs and whether
  that amount is CORRECT. A test doing 400 round-trips where 11 are right looks
  exactly like a slow runner.
- Does any count scale with a tuning parameter (overlap, batch size, window)
  rather than with the input? That is the signature of a loop whose advance and
  whose termination condition disagree.
- For a loop that both clamps an end offset and relies on a `max(next, cur + 1)`
  floor to guarantee progress: what happens on the iteration where the clamp
  binds? The floor will happily walk one unit at a time forever, and it looks
  like progress.
- Does the fix's own verifier fail on the UNFIXED code? Run it both ways. A
  verifier that reports identical failures before and after is measuring itself,
  and a green one that was never red proves nothing.
- Does the assertion cover both directions -- nothing lost AND nothing spurious?
  Checking only "no text is lost" passes a chunker that emits 400 duplicates;
  checking only the count passes one that drops the tail.
- Was the unit under test covered at all? `chunkText` had ZERO unit tests; it was
  exercised only through a live-Postgres suite asserting storage properties, so
  a 37x row-count error registered as "CI is slow."
