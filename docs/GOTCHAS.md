# Gotchas — ways this repo has shot itself in the foot

Each entry is something that **cost real time and looked fine while it was
wrong**. Not style, not preference: a specific trap with the symptom you will
actually see, so the next person recognises it in minutes instead of an hour.

Different from `docs/sme/` — that is a review-swarm knowledge base organised by
reviewer lane. This is operational: the things that bite while you are running,
deploying, or measuring.

**Add an entry the moment you lose an hour to something.** Include the symptom
first — that is what a future reader is searching for — then the cause, then the
check that would have caught it early.

---

## The pattern behind almost all of these

**Silent success is the enemy.** Every entry below shares one shape: a thing
reported OK, exited 0, typechecked, or returned a clean empty result, while
being broken. A loud failure costs minutes. A quiet one costs a day and
poisons whatever you build on top of it.

When you add something to this repo, ask: *if this fails, how will anyone
know?* If the answer is "an empty result set" or "exit 0", that is the bug.

**The second pattern: inferring what one command would have told you.**
On 2026-07-30 an agent got seven separate calls wrong in one session and every
single one was a fact that was already checkable — the chunking design
(`aqmd search "chunking"`), the lane scope (one psql query), the promotion cap
(a 30-second test that overturned its own claim), core01's worker topology
(`curl .../health`), the deploy host (`AGENTS.md:104`, already written down).
None were judgment calls. Each was a lookup skipped in favour of a plausible
answer, and the plausible answer disagreed with reality every time.

The failure has a signature: **reasoning that sounds sound and cites nothing.**
Live infrastructure counts here as much as design docs do — a running service
answers questions about itself faster than you can theorise about it, and it
answers them correctly.

---

## Infrastructure

### The local Open Brain service dies and no one notices for days

**Symptom:** `/checkpoint` from any agent silently does nothing — the provider
exits 0, prints no receipt, and writes no session row. Every agent is affected
at once. `curl http://127.0.0.1:3100/health` times out (there is no `/health`
route; it hangs rather than 404s, so that probe proves nothing either way).

**Cause, measured 2026-07-28:** `scripts/local-clone-autostart.sh` — the script
`~/Library/LaunchAgents/com.rico.open-brain-local-clone.plist` names in
`ProgramArguments` — **was missing from the working tree**. It was committed in
`3a78156` and later vanished from `HEAD`. launchd cannot exec a file that is not
there, so the job failed with `EX_CONFIG` (exit 78) on every restart attempt for
three days. The one process still serving traffic was the last one started
*while the script existed* — it ran on Jul 27 code until it stopped answering.

**Checks:**

```bash
launchctl print gui/501/com.rico.open-brain-local-clone | grep -E "state|last exit"
# "last exit code = 78: EX_CONFIG" + "job state = spawn failed" = the exec target is missing/unrunnable
lsof -tiTCP:3100 -sTCP:LISTEN                    # a pid here does NOT mean it is answering
ps -o lstart -p "$(lsof -tiTCP:3100 -sTCP:LISTEN | head -1)"   # start time days old = it never restarted
tail -2 ~/Library/Logs/open-brain-local/autostart.out.log      # compare the newest timestamp to `date -u`
```

**A listening port is not a health check.** The process held 3100 the whole time
it was dead to clients. Judge liveness by *recent log timestamps*, not by
`lsof`.

**Recovery:** restore the script (`git checkout <commit> -- <path>`, `chmod +x`),
then **`bootout` + `bootstrap`** — `kickstart -k` alone kept returning the stale
`EX_CONFIG` and left a wedged wrapper holding no port. Kill leftover
`local-clone*` processes between the two.

**Verify the wrapper independently before blaming launchd** — it takes no
environment from your shell, so reproduce that:

```bash
env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /opt/homebrew/bin/bash scripts/local-clone-autostart.sh
```

Healthy output reaches `open-brain server started` in about one second.

**Prevention:** anything named by a launchd plist must be tracked in git. A
deleted-but-referenced script produces no error until the next restart, which
may be days later, and by then the cause looks unrelated to the deletion.

**The "no one notices" half is now closed (#536).** The capture `Stop` hook
prints one line to stderr the first time a session's write fails --
`open-brain unreachable - turn held for replay` -- and one more when writes
start landing again. It is a STATE CHANGE, not an event: a long outage is one
line, not one per turn, latched on disk (`apps/capture/outage.py`) because each
Stop is a fresh process. Session survival is unchanged; only the silence went.

**And the state change is rate-bound, because a state change alone was not
enough.** A FLAPPING service changes state on every Stop, so the latch by itself
still spoke on every Stop — measured 6 notices across 6 alternating Stops. That
is not exotic: the capture request timeout is 0.7s with a single attempt, so one
slow response is a complete outage-and-recovery pair. After a reported outage
the latch stays quiet for `FLAP_COOLDOWN_SECONDS` (5 minutes); a window opened
inside that period is ridden out silently at BOTH ends, since a recovery whose
outage was never printed reads as a recovery from nothing. The recovery line
carries the window's failed-turn count when it exceeds one. Same shape as the
server-side tracing tracker (#534).

**If the notice is missing, check the latch's lock before anything else.** The
latch waits only `LOCK_WAIT_SECONDS` (0.25s) for the watermark file it shares,
then gives up and says nothing — deliberately, because `Stop` has a 5s deadline
and the harness kills the hook at 10s. On the original 30s wait a held lock kept
one Stop running 31.09s, which would have been a killed hook and a lost capture.
Silence under contention is the design, not a defect.

So an outage is now visible WITHOUT the checks above. If those checks are ever
needed again because nothing appeared on screen, the notice path itself is what
to suspect first -- and note it reports reachability from the CAPTURE hook only.
A provider `/checkpoint` failing while capture succeeds is a different fault
and still shows up as the `spool N` count on the gate line, not as this line.

### `.env` is missing keys that `.env.example` documents

**Symptom:** embeddings silently fail — candidates are written with a NULL
vector, invisible to semantic search and to `candidate-dedupe`. The backfill
reports `filled: 0, failed: 1000` with no explanation. The provider itself is
healthy and answers `curl` directly.

**Cause, 2026-07-28:** `.env` had 11 keys; `.env.example` documents 25 more.
The whole embedding block was absent, so `EMBEDDING_MODEL` fell back to its
default `gemini-embedding-001` (`src/embedding.ts:34-35`) — a model the local
MLX server does not serve. Every call was rejected.

**Check:**

```bash
comm -23 <(rg -o "^[A-Z_]+" .env.example | sort -u) <(rg -o "^[A-Z_]+" .env | sort -u)
```

**Still outstanding:** the embedding block was added; ~22 other documented keys
are still missing from `.env`. They have defaults, and a default that silently
points somewhere wrong is exactly this trap again.

### The service reads a different env file than you do

`local-clone-autostart.sh` sources
`/Volumes/ThunderBolt/open-brain-local/local-clone.env` (mode 600, enforced),
**not** the repo's `.env`. Editing `.env` does not affect the running service,
and vice versa. Two files, two lifetimes — check which one you are looking at
before concluding a value is set.

## Testing

### A green `bun test` may have run none of the database tests

**Symptom:** "tests pass" while the database half never executed.

**Cause:** `*.pg.test.ts` files gate on an env var and **skip silently**:

```ts
const dbDescribe = DB_URL ? describe : describe.skip;   // decompose-entry.pg.test.ts:43
```

A skipped suite reports as a clean run. Mocked bound-parameter assertions prove
the right value was passed; they do not prove the FK accepts it, the index is
used, or the query returns anything.

**Run them:**

```bash
OPENBRAIN_TEST_DATABASE_URL="postgres://rico@127.0.0.1:5432/open_brain_local_20260724" \
  bun test src/tools/__tests__/decompose-entry.pg.test.ts
```

The clone database is named in `.env` (`DB_NAME`). `psql -lt` lists them if not.

### Bare `psql` connects to the wrong database

**Measured 2026-07-30 — and the operator counted it as roughly the twentieth
time.** A plain `psql -c "..."` fails with:

```
FATAL:  database "rico" does not exist
```

Postgres defaults the database name to the OS user. The connection settings live
in `.env` (gitignored), and a fresh shell has not loaded them.

**Always source `.env` first, in the same command:**

```bash
set -a && . ./.env && set +a && psql -t -A -c "select count(*) from ob_session_events;"
```

`set -a` exports every variable the file defines, so `PGHOST`/`PGPORT`/
`PGDATABASE`/`PGUSER` reach the `psql` child process. Without it the shell
assigns them and exports nothing, which fails identically to not sourcing at all.
A subshell (`cd`, a new Bash tool call) does not inherit them — re-source every
time.

### Every `dev:*` lane is scope-bound; a mismatched write is refused

**Measured 2026-07-30.** Appending to `dev:open-brain` as a different agent
returns, and writes nothing:

```json
{"error": "scope_validation", "conflicts": ["agent", "platform"],
 "message": "Existing lane scope does not match requested append scope",
 "retryable": false}
```

Every `dev:*` lane in the clone is bound to `agent=shared`, `source=development`
(`select session_key, agent, source from ob_session_lanes where session_key like
'dev:%'`). The lane owns its scope; the caller does not get to pick one.

This is a good error — it names the conflicting fields and says
`retryable: false`. Contrast the retired bridge, which collapsed every failure
into a bare `{ ok: false }` and produced backfill receipts reading only
`"session summary citation persistence failed"`. **When a write path swallows
the server's reason, the next person debugging it starts from zero.**

### A test can assert the bug

**Measured 2026-07-28:** `decompose-entry.test.ts` asserted
`expect(insertCalls[0]?.params?.[9]).toBeNull()` — parameter 9 is `parent_id`.
The column was supposed to hold the source entry's id. The test encoded the
defect as the contract and passed for months.

**Always prove a test can fail.** Revert the fix, watch the test go red, restore
it. If it stays green either way it is asserting nothing. Every fix in this repo
should be able to state its before/after counts — e.g. "10 pass; reverting the
one-line fix gives 9 pass 1 fail."

## Schema

### A declared-but-unpopulated column is worse than a missing one

**Symptom:** a join returns zero rows and reads as "there is no data" rather
than "the link was never written." Partial indexes on `WHERE col IS NOT NULL`
index nothing while reporting healthy.

**Measured 2026-07-28:** `011_chunking.sql:2` declared
`thoughts.parent_id UUID REFERENCES thoughts(id) ON DELETE CASCADE` with an
index at `:4`. `decompose-entry.ts` bound a literal `null` to it while
populating `chunk_index` correctly beside it. Every chunk knew it was Nth of
something and nothing recorded of *what*. Lineage lived only in the
`promoted_from` JSON — real provenance, but not joinable — so no read path could
reassemble a decomposed entry and none was ever written.

A missing column fails loudly the first time you write the query. A null one
typechecks, satisfies every constraint, and returns an empty result.

**Prevention — make the database refuse the half-written form.** Migration 044
does this for `candidate_memory`:

```sql
CHECK ((parent_id IS NULL) = (chunk_index IS NULL))
```

Verified: the `UPDATE` that would create a chunk with an index and no parent is
rejected. Pair a lineage column with a constraint that makes the broken state
unrepresentable, and assert the join in a pg test.

### `occurred_at` is the ordering key, not `created_at`

**Symptom:** time-windowed queries return a fraction of what you expect. A
backfilled corpus appears to have almost no history. `session_seq` is NULL on
most rows, so within-session order is arbitrary.

**Measured 2026-07-28:** `scripts/backfill-transcripts.ts` named `created_at` as
its last INSERT column and bound the transcript timestamp to it, never naming
`occurred_at` — NULL on all 20,535 backfilled rows, 77% of `ob_raw_turns`.
Nothing failed; the insert succeeded and the counts looked right.

`032_raw_turns.sql:158-161` states the contract exactly: *"occurred_at is
Graphiti's reference_time: when the turn HAPPENED... created_at would silently
scramble the conversation."* `036:60` derives `session_seq` from
`ORDER BY occurred_at, id`, so 17,554 rows also came out unsequenced.

**This was not cosmetic.** Re-cutting exchanges after the repair changed the
result materially: orphans **411 → 47** (364 agent turns had appeared to precede
any operator turn purely because null-ordered rows sorted arbitrarily) and
AskUserQuestion heads **97 → 153**.

**Check after any bulk insert:**

```sql
SELECT count(*) FILTER (WHERE occurred_at IS NULL) AS null_ts,
       count(*) FILTER (WHERE session_seq IS NULL)  AS null_seq,
       count(*) AS total FROM ob_raw_turns;
```

Both counts must be 0. `occurred_at` = when it was said; `created_at` = when it
was stored. For a backfill those differ by days, and conflating them dates the
whole corpus to the moment the script ran.

## Process

### Search before you propose structure — it is 0.1 seconds

**Measured 2026-07-28:** `qmd search "chunk"` returned `src/chunking.ts` and
`src/decomposition.ts` at 86% in **0.11s**, and the semantic form surfaced
issues #192 and #247 — the design record — which reading files never found.
Skipping it cost about an hour of rediscovering a design that was already
written down, and produced three wrong proposals along the way (raise a
constant; add part/sequence columns that already existed as `chunk_index`;
widen the design gate to trust adjustable local copies).

The trap: hunting a specific constant *feels* like a grep, not a question. It
is not. The constant is the symptom; "how does this repo split oversized
entries" is the question, and one BM25 word answers it.

`.claude/hooks/design-lookup-gate.ts` now blocks mutating tools until a lookup
**on that subject** exists in the session. An unrelated lookup no longer counts
— the first version tested recency, so any lookup unlocked any edit and a
session that read many design docs was permanently unlocked.

### `_DOCS/STANDARDS-*.md` are adjustable copies, not authority

They are seeded from `/Volumes/ThunderBolt/Development/_DOCS/` and then adjusted
per repo — that is why they are copies rather than symlinks. Do not cite one to
override a live instruction or a repo-local rule, and do not treat reading one
as having consulted authority.

### Write paths as `/mnt`, not `/Volumes`

`/mnt` is a root symlink to `/Volumes` on this Mac (verified: both report
filesystem ID `100001d0000001a`) and is the real path on the Linux boxes. Using
`/mnt` in anything tracked or shared costs nothing here and works there.

### Rewriting from the old code carries its defects across

**Symptom:** the new implementation contains a constant nobody chose, with a
comment explaining a reason that is no longer true.

Operator, 2026-07-30: *"I don't think you should be ingesting shit from the old
TypeScript files. You should either be doing that stuff directly in Python, or
you should stub it out."*

The mechanism is momentum. Reading a 423-line file to rewrite it makes every
constant a judgment call, and those get made deep into the file by someone who
has stopped reading critically. Two survived that process in the deployed
adapter:

- `turn-capture.ts:386` — `redact(cleaned).slice(0, 1_500)` shortens every
  distilled capture. No error, no receipt. Violates the never-shorten rule in
  `docs/CODING_STANDARDS.md:160`.
- `raw-turns.ts:268` — shortens at 200,000, commented *"Mirrors the server's
  per-turn cap"*. **The server deleted that rule.**
  `src/tools/ingest-raw-turn.ts:30` records it rejected whole turns and took up
  to 99 good ones with them.

**A mirrored rule outlives the rule it mirrors**, and the duplicate looks
correct because it cites a reason. That is the argument against porting by
reading.

**The check:** build from `docs/decisions/` and acceptance criteria — what must
be TRUE — not from the file. Where the old code is the only source of a fact
(the exact bytes a hook must emit), stub it and ask.

Corroborating evidence that these were never one idea: `MAX_CONTEXT_CHARS` is
**3,000** in `qmd-startup.ts` and **12,000** in `takeover.ts`. Same name, 4×
apart, nothing linking them.

### A pydantic settings section must not be its own `BaseSettings`

**Symptom:** a committed config file silently beats an exported environment
variable, with nothing logged. Measured 2026-07-30:

```
db.host = from-json.example     (the environment said from-env.example)
```

**Cause:** each section carried `env_prefix` as its own `BaseSettings`, so each
ran an INDEPENDENT environment source *while being constructed* — before the
parent consulted its source chain. The parent then saw an already-built object
and the JSON layer outranked it.

**Fix:** sections are plain `BaseModel`; only the top-level `Settings` is a
`BaseSettings`. Both exemplars are built that way.

**The check:** test the DIRECTION, not just that config loads.
`docs/standards/typescript-exemplar/src/exemplar/config.ts:29` warns about this
exact failure in the sibling exemplar: *"documented precedence that nothing
verified. A comment is not a guarantee."*

Related traps found in the same work:

- `validation_alias` REPLACES the field name, so a JSON layer spelling `{"host":
  ...}` is rejected as an extra while pydantic reports the alias missing. Needs
  `populate_by_name=True`.
- A parent `BaseSettings` does NOT read a nested `BaseModel` field's own alias —
  verified: with `DB_HOST` set, `S().database.host` returned the field default.
- `extra="forbid"` does NOT catch a typo'd prefixed environment variable;
  pydantic-settings only collects variables matching a declared field, so
  `OPENBRAIN_NOPE=1` loads clean. Needs an explicit scan.
- A field declaring no alias has NO environment spelling at all — it exists in
  the model and no operator can set it.

### Check whether the thing already exists before building it

**Symptom:** a new module that duplicates a boundary the repo already owns.

`utils/admission.py` was planned as the keystone of a port. Three checks, all
under a minute, killed it:

- **Neither exemplar has one.** Both `utils/` are three files — datetime, http,
  logging. A fourth concept with no precedent is complexity for its own sake.
- **This repo has five modules covering it**: `src/contract.ts`,
  `contract-schemas.ts`, `validation-errors.ts`, `chunk-write.ts`,
  `chunking.ts`.
- **`docs/decisions/contract-is-the-agent-surface.md`** already decides where
  refusals are declared: the contract, because a contract-driven agent cannot
  read a code comment.

This entry exists because the same session ALSO nearly created a third gotchas
file while `docs/GOTCHAS.md` and `docs/sme/gotcha-agent.md` both already
existed. `aqmd search` found it in 0.1s.

### A fake credential in a test fixture blocks your own commit

**Symptom:** `gitleaks` reports `leaks found: 1` on a file you know contains no
real secret, and the commit is refused.

Measured 2026-07-31: a redaction test used the literal
`ghp_abcdefghij0123456789` to prove masking works. gitleaks matched it as
`generic-api-key` (entropy 4.4) and blocked the commit.

The finding was a false positive — but the fixture is still wrong. A literal
that *looks* like a token trips the scanner on every commit, every CI run, and
every future scan. **A fixture that cries wolf teaches people to reach for
`--no-verify`**, which is far more expensive than the fixture being slightly
indirect.

**The check:** assemble fake credentials from parts at runtime, so nothing
token-shaped exists on disk:

```python
_FAKE_BODY = "0123456789" + "abcdefghij"
FAKE_GITHUB_TOKEN = "ghp" + "_" + _FAKE_BODY
```

The redaction patterns are still genuinely exercised — the value is
token-shaped when the test runs, just not when the scanner reads the file.

### Finding a problem mid-implementation is a miss, not a save

**Symptom:** every time the operator asks a question, a new problem surfaces.

Operator, 2026-07-30: *"every time I poke at you you find something new that's
a problem."* Three in one session, all checkable BEFORE writing, with the files
already open:

| the question | what one check would have shown |
|---|---|
| "why is there TS in my Python" | the source being read was never stated |
| "what's with the 5,000 character thing" | a number written without saying it was an input size |
| "can the config be shared" | `diff` of section names: ours `log`, exemplar `logging` |

**The check:** before writing, state what the existing design says with
`file:line`, what is about to be written, and how it will be proven wrong. Being
unable to cite the design is the signal to read, not to start typing. Compare
names and shapes against `docs/standards/*-exemplar/` as a step, not as a
reaction to being asked.

### The transcript record shape: four assumptions that are all wrong

**Measured 2026-07-31** against a live 26.5 MB session transcript in
`~/.claude/projects/`, while writing `apps/capture/records.py`. Every one of
these is the obvious guess, and every one of them is wrong.

| assumption | measured |
|---|---|
| `type == "user"` means the operator | 2,561 user records, **234** typed by a person. The rest are tool results replayed as user-role messages. |
| `userType` distinguishes them | reads `"external"` on **all 2,563**, tool results included. Looks like the answer, separates nothing. |
| `message.content` is a string | `str` on 256 records, **`list` on 2,305**. Operator turns are always `str`; the list shape is tool results. |
| every record has a `uuid` | the **first three lines of every transcript** (`last-prompt`, `mode`, `permission-mode`) have none. Requiring it crashes on line 1. |

**`promptSource` is the discriminator.** Three values: `typed` (206), `queued`
(28), `system` (2). The first two are the operator; `system` is injected text
they never wrote. Tool results carry the key not at all.

Reading the real file took one `jq` pipeline. Inferring the shape from the
adapter being replaced would have produced a capture path that silently stored
command output as operator turns.

### The 8-entry window was the normal path failing, not an edge case

`raw-turns.ts:188` reads the last eight transcript entries per `Stop` hook.
Measured on this repo's own session transcript, 2026-07-31:

- **225 of 234 operator turns (96%)** produced more entries than that window reads
- the largest single turn produced **1,646** entries

`_plans/418-prov-9-hook-entrypoints.md` estimated 553 as the worst case. The
real one is three times that. A window sized for "one exchange" was never
reading a whole turn once tool calls existed.

**The watermark's non-obvious requirement:** advance the offset only to the last
**newline**, never to end-of-file. A hook can fire while Claude Code is mid-write,
so the tail may be half a JSON object; committing that position parks the next
read inside a record and corrupts every read after it. Leave the partial tail
unconsumed and the next read picks it up whole.

### A test that passes while the code is broken

While proving the step-6 guards, the live-transcript split test passed with the
watermark **entirely disabled** (`start = 0`). It asserted `>=` on a count and a
subset on a set of ids -- both true no matter what the reader did.

Rewritten to the exact property (`head.turns + tail.turns == whole.turns`,
split at three points), it fails at all three the moment the watermark is
ignored.

**The check:** a guard is proven by removing it and watching the suite go red.
Same defect class as ruff `PLR1702` without `preview`, `aqmd up` on an
unenumerated directory, and `bun test` without `OPENBRAIN_TEST_DATABASE_URL` --
a check that examines nothing reports success.

### `git stash` to answer a question puts conflict markers in your next commit

**2026-07-31.** To check whether two doctest failures predated a change, the
files were stashed, the test re-run, and the stash popped. The pop printed
*"The stash entry is kept in case you need it again"* -- which reads like a
courtesy and is actually **"the pop conflicted."** `.gitignore` came back with
six conflict markers in it, staged and one command from being committed.

Two separate mistakes:

1. **The question did not need a stash.** "Do these failures predate my work?"
   is answered by `git stash list`-free means: run the failing doctests, read
   the error. They were `DatabaseSettings` validation errors -- visibly nothing
   to do with the new modules.
2. **The pop's output was skimmed.** In a repo with unrelated dirty files, a
   pop can conflict in a file you never touched. `.gitignore` here carries the
   `secrets/` allowlist, so committing markers would have broken a boundary
   that decides what reaches git.

**The check:** after any `stash pop`, run `git diff --diff-filter=U --name-only`
before staging. And prefer reading over mutating the working tree when the
question is "was this already true" -- `git stash` is a mutation.

### Reading a growing file from a saved offset is LOG SHIPPING, not a novel design

**2026-07-31.** `apps/capture/watermark.py` + `transcript.py` were written from
first principles as if resumable file reading were a new problem. It is not. It
is the oldest problem in log processing, with dedicated libraries, a formal
spec, and twenty years of prior art:

| prior art | what it is |
|---|---|
| `logtail2` (logcheck) | the original, ~2001 |
| `pygtail` | Python port of logtail2; offset file, rotation, `--paranoid` |
| `ponytail` | truncation + rename detection, straggler reads, offset file |
| OpenTelemetry filelog receiver | the formal spec for truncation policy |
| Vector / Fluent Bit / NXLog | production implementations |

**The search cost one query. Not searching cost a hand-rolled implementation
with a real bug in it (below).** Searching the local repo index and the
prior-art clones is NOT the same as searching the ecosystem: the clones are all
graph/memory systems, so none of them read log files, and their absence proved
nothing.

**The rule:** when about to write a process, search the Python ecosystem for it
BEFORE writing. Repo search answers "does this project already do it"; web
search answers "has the world already solved it". Both are required.

### Detecting a replaced file by SIZE is wrong; use (st_dev, st_ino)

**A live defect in `transcript.py`, found by searching rather than by testing.**

The committed check is `start = offset if offset <= size else 0` -- it only
notices a file that got SMALLER. The industry-standard detection is the
device+inode pair:

- **copytruncate** rotation: same inode, size shrinks -> size check catches it
- **rename/create** rotation: **new inode, size can be anything** -> size check
  MISSES IT ENTIRELY

If a transcript is replaced and the new one grows past the old offset before the
next hook fires, the size check passes and the reader **silently skips every
turn in between** -- the exact permanent-loss failure the watermark exists to
prevent.

Also insufficient on its own: inode numbers are REUSED after delete, so a new
file can inherit the old one's inode. Robust readers pair `(st_dev, st_ino)`
with a fingerprint of the first N bytes.

**No test caught this** because every test writes to the same inode. A test
suite built on the same assumption as the code cannot find the assumption.

### Search the ECOSYSTEM before writing a mechanism, not just the repo

**2026-07-31, operator:** *"Every time you come up with a process that you should
be doing, you should go out and do a web search to see if there's a well-known
Python package that can do it."*

Repo search and web search answer DIFFERENT questions:

| search | answers |
|---|---|
| `aqmd` / `rg` in this repo | does this project already do it |
| prior-art clones (`aqmd research`) | do comparable systems do it |
| **web** | **has the world already solved it** |

Only the third would have found that resumable file reading is log shipping.
The clones are all graph/memory systems, so none of them read log files, and
their silence proved nothing. Two of three searches ran; the missing one was
the one that mattered.

**Standing rule now:** any mechanism (storage, parsing, retry, scheduling,
detection, formatting) gets an ecosystem search BEFORE the first line is
written, and hand-rolling requires stating in the code why each candidate was
unsuitable -- which `_DOCS/STANDARDS-core.md:215` already required.

**But a package is not automatically the answer.** Operator, same session:
*"not just throw-in package for package sake."* The evaluation is well-known,
commonly used, highly rated -- and a package that does only PART of the job well
is still worth taking. Three candidates were rejected here on evidence:
`pygtail` (GPL v2, no type hints, possibly discontinued), `ponytail` (2 releases,
unverified licence), `diskcache` (pickles values, no release since 2023, typed
helpers by one author, one self-documented as untested). Their DESIGNS were
taken instead, with attribution.

### WAL does not give you concurrent writers

Believed before checking, and wrong: `PRAGMA journal_mode=WAL` was assumed to
make multi-process writing safe. It does not. **SQLite allows one writer at a
time in every mode.** WAL only lets readers run alongside that writer.

What actually prevents `database is locked` is the **busy timeout**, and it must
be set explicitly. In Python, `sqlite3.connect(path, timeout=N)` is the busy
timeout; the C-library default is 0, which produces rare-but-constant failures
under load rather than an obvious break.

Two more that cost a test cycle each:

- **`PRAGMA journal_mode=WAL` cannot run inside a transaction.** With
  `autocommit=False` (the modern, recommended form) a transaction is already
  open at connect, so the pragma raises *"cannot change into wal mode from
  within a transaction"*. WAL is a persistent property of the database FILE, so
  set it once at creation in autocommit mode, never per connection.
- **`with connection:` commits but does NOT close.** It is a transaction context
  manager, not a resource one. Pair it with `contextlib.closing` or leak handles.

### Pull the package source; secondhand judgment gets facts wrong

**2026-07-31, operator:** *"if the Python packages are all open source, you can
go pull the repos down and see what the fuck they do."*

`AGENTS.md` already says prior art is read **"from source, not marketing"** --
but that rule was being applied only to the six graph/memory clones, not to
packages under evaluation. Cloning `ponytail`, `pygtail`, and `diskcache` took
one command and immediately produced five things no amount of doc-reading gave:

1. **A factual error in a committed artifact.** `ponytail` was recorded in
   `ATTRIBUTION.md` and a commit message as "unverified licence". Its LICENSE
   file says **CC0 1.0** -- public domain, the most permissive there is. The
   rejection reasoning was published before the fact was checked.
2. **Independent confirmation of the design.** `_has_file_rotated` checks
   `dev_no` then `inode_no`; `_load_offset` discards the offset when inode, dev,
   OR `offset > size` disagree. Same three conditions arrived at separately.
3. **The staging-file pattern it uses** (`.tmp` + `os.rename`) is the one we
   removed in favour of sqlite3 -- confirming the pattern was right and that
   sqlite3 is a real improvement for multi-process use, not a lateral move.
4. **A gap in our code**, visible only in source: on rotation ponytail keeps the
   OLD file handle open for `watch_rotated_file_seconds` (default 300) and
   drains stragglers. Ours abandons it. Measured: a line appended to the old
   inode before rotation is lost, and sits unread on disk.
5. **Why it is not a drop-in anyway:** `readlines()` is an infinite generator
   built for a daemon. A `Stop` hook runs once and exits.

**Straggler gap: real but currently unreachable.** Verified 2026-07-31 -- Claude
Code names each transcript by session UUID and never rotates; no `.1`, `.old`,
or `.bak` artifact exists anywhere under `~/.claude/projects/`. Recorded rather
than fixed, so it is not rediscovered from scratch, and so it is fixed the day
transcripts do rotate.

### Async is the house style; `time.sleep` is not the alternative

**Operator, 2026-07-31:** *"you should never be using time.sleep. That's just
fucking bad practice. We should be async only."*

`docs/standards/STANDARDS-python.md` already assumes async throughout:
`pytest-asyncio` with `asyncio_mode = "auto"` (:951), `AsyncMock` never
`MagicMock` (:952), `asyncio.CancelledError` caught separately (:855).

**`asyncio_mode` must be `"auto"`, and it is the same defect class as everything
else in this file.** Under the default `"strict"`, an unmarked `async def test_`
is COLLECTED, NOT AWAITED, and REPORTED AS PASSING. A check that examines
nothing reports success -- exactly like ruff `PLR1702` without `preview` and a
mypy path that resolves to nothing.

**What async does NOT buy here, stated so nobody claims otherwise later:**
there is no true async file I/O in Python. `aiofiles` and `anyio` both run the
same blocking `read()` in a worker thread, so `asyncio.to_thread` is the stdlib
form of precisely what they do, with no dependency. Converting local file reads
buys an `await` keyword and a consistent boundary -- NOT concurrency. It is
worth doing because the boundary is what later callers (the OB HTTP client,
Postgres writes) genuinely need, not because it makes a hook faster.

### A busy timeout that never applies: SQLite will not wait on a lock UPGRADE

**A live defect in `1f6e586`, found only because the operator asked whether a
blocking wait was really unavoidable.**

`WatermarkStore._advance` does `SELECT` (enforce forward-only) then `INSERT`.
Under sqlite3's DEFAULT deferred transaction that takes a READ lock and then
tries to UPGRADE to a write lock. **SQLite refuses to wait on an upgrade** --
two readers each waiting to write is an unresolvable deadlock -- so it returns
`database is locked` in **0ms**, ignoring `busy_timeout` entirely.

Measured 2026-07-31, two real processes, same database:

| form | result |
|---|---|
| deferred read-then-write (what shipped) | **FAILED in 0ms** |
| plain single write | waited 659ms, succeeded |
| `BEGIN IMMEDIATE` read-then-write (the fix) | waited 712ms, succeeded |

`LOCK_WAIT_SECONDS = 30.0` was set, verified as `PRAGMA busy_timeout = 30000`,
and **doing nothing on the one path it existed to protect** -- the two-worker
contention on core01 it was added for.

**Setting a timeout is not the same as being protected by one.** The constant
looked right, the pragma read back right, and the behaviour was wrong. Only a
test that holds a real lock from a real SECOND PROCESS shows it: SQLite resolves
same-connection and in-process contention immediately and correctly, so an
in-process "holder" proves nothing. Same family as every other entry here -- a
check that examines nothing reports success.

**Two more traps in the fix itself:**

- **`connection.commit()` is a NO-OP under `autocommit=True`.** An explicitly
  begun transaction is then never committed and is discarded on close. Every
  write silently did nothing and `offset_for` returned 0. Issue `COMMIT` and
  `ROLLBACK` as SQL when managing transactions by hand.
- `autocommit=False` opens a deferred transaction at connect, which makes an
  explicit `BEGIN IMMEDIATE` an error. Managing transactions explicitly requires
  `autocommit=True`.

**The wait itself was never the problem.** Measured: the contended write waited
712ms while the worst event-loop stall was 11.3ms (the probe's own tick). SQLite
hands the wait to the OS scheduler rather than polling, CPython releases the GIL
around `sqlite3_step()`, and the call runs inside `asyncio.to_thread`. The GIL
was never what slowed this down, and a free-threaded build would not have fixed
it -- the bug was a transaction that refused to wait at all.

## 2026-08-02 field traps

### A hanging local `/health` does not mean Open Brain is down

**Symptom:** the local clone's `/health` hangs and `SELECT 1` stretches past the
pool's 5-second window, making the service look dead.

**Cause, measured 2026-08-02:** the shared local PostgreSQL 18 instance serves
multiple projects by design. A neighbour's scratch-database tests run
`CREATE/DROP DATABASE WITH FORCE` per test and caused forced-checkpoint storms:
72 forced checkpoints in 3 minutes, with `pg_stat_checkpointer.num_requested =
21,212` against `num_timed = 1,057`.

**Check before declaring an outage:** inspect `pg_stat_checkpointer` and
concurrent workloads. The Open Brain service recovers in place after the churn.
Do **not** propose isolating the neighbour: the shared instance is the operator's
deliberate dogfood design, confirmed 2026-08-02.

### `core.bare=true` makes a normal checkout claim it has no work tree

**Symptom:** `scripts/local-clone-deploy.sh` stops at its dirty-tree guard
(lines 104-105) with:

```
fatal: this operation must be run in a work tree
```

**Cause, observed twice within about 30 minutes on 2026-08-02:** something
concurrent set this repo's main-checkout local config to `core.bare=true`. The
actor remains **UNATTRIBUTED**.

**Recovery:**

```bash
git config --local core.bare false
git rev-parse --is-inside-work-tree
```

The second command must return `true`. Deploy workers now re-assert this before
running.

### A bare launchd label fails, and the old process can fake deploy success

**Symptom:** `launchctl kickstart` fails with `Unrecognized target specifier`,
but `scripts/local-clone-deploy.sh` only warns, then prints a successful
post-deploy health receipt.

**Cause:** `kickstart` requires the service-target form
`gui/$UID/<label>`; the bare label is not a valid target. On
2026-08-02T04:12:18Z the health check passed against the **old process still
serving**, producing a false deploy receipt.

A fix PR is open on `fix/deploy-runbook-and-kickstart`. Until that lands, a green
health response after a restart warning does not prove the new process started.

### `ob_raw_turns` does not prove a distilled provider capture

**Symptom:** the deploy runbook's dogfood smoke reports no raw-turn increase and
looks like the provider capture failed.

**Cause:** the smoke counted the wrong table. A provider capture writes a
distilled event to `ob_session_events`; `ob_raw_turns` measures raw-turn
ingestion only.

**Live proof, 2026-08-02:** the provider returned a `saved` / `durable` receipt,
`ob_raw_turns` changed by 0, and event
`2496e009-a2a3-48af-9aa5-6ea1996c9c1a` was present in
`ob_session_events`.

### A one-shot Codex worker can exit 0 after doing nothing

**Symptom:** a Codex/Terra one-shot exits 0 while printing deferral prose such as
`work is running in the background` or `publication remains pending`.

**Observed twice on 2026-08-01/02:** the worker completed partial or no work, but
its process status looked successful. Never relay that output as done. Verify the
artifact against live state -- GitHub or the filesystem -- and relaunch with an
explicit execution contract: finishing means the artifact URL is printed in the
worker's own output.

### `AskUserQuestion` had an impossible design-lookup gate

**Symptom:** `AskUserQuestion` was blocked unconditionally; no subject lookup
could unlock it.

**Cause:** `mutationSubject()` returned `file_path`, which is always empty for a
question, so no lookup could ever match. Fixed 2026-08-02 in commit `bfb9389` on
`audit/router-dedupe-matrix-2026-08-02`: a question's subject is now its question
text.

### Bare `python3 resume.py` can select an interpreter without the package

**Symptom:** invoking `resume.py` with bare `python3` dies with
`ModuleNotFoundError` because system Python 3.13 does not have
`openbrain_memory`.

**Fix:** a self-re-exec guard routes through the uv tool interpreter. Branch
`fix/brain-resume-interpreter`, commit `b12200f`, was applied to the live
Development tree on 2026-08-02.

**Related find:** Development `main` did not contain the canonical resume
workflow commits; the live file was ahead of its own history. The repair branch
carries all three commits.

## 2026-08-02 worker-layer traps (phase 2)

### The Codex worker layer dies in waves, killing every concurrent session

**Symptom:** every in-flight `claudex terra`/`claudex sol -p` worker returns
`Execution error` at the same instant. Solo workers launched afterwards die the
same way. A trivial probe against the same route still answers, and the proxy
process itself is untouched, so nothing looks down.

**Observed 2026-08-02:** mass-death events at `01:48` and about `03:32` took out
all concurrent sessions, followed by further solo deaths. Because the probe
answers and the proxy is alive, the layer reads as healthy while it is
destroying real work.

**Mitigation that held:** route heavy build lanes as native Claude Workflow
agents rather than through the Codex worker layer, and require per-step
journaling from every worker. Journaling is what caps the loss — a wave kills
the session, not the record of what it had already finished.

### A Codex worker that reads the Workflow-first policy appoints itself controller

**Symptom:** a worker's output reads like a deferral — `still running elsewhere`
— and no artifact exists. The worker exited without doing the work.

**Cause:** the worker reads the Workflow-first routing policy, concludes it
should delegate, spawns a sub-node, and exits. The child dies with the parent,
so the delegated work never lands, and the parent's last words describe work it
believes is still in progress somewhere.

**Five occurrences on 2026-08-02.** The standard prompt clauses that stopped it,
now required on every worker launch:

- YOU are the implementer.
- No delegation, no sub-agents.
- Synchronous only.
- Finishing means the artifact URL appears in YOUR own output.
- Append a per-step journal entry after every step.

### Test machinery from killed lanes wedged the live dogfood database

**Symptom:** the live dogfood service degrades; 97 backends are connected and
queries stall.

**Cause, measured 2026-08-02:** lanes killed by the worker mass-death left their
test machinery mid-transaction against the **dogfood** database. 63 orphaned
`DELETE FROM thoughts` statements were queued behind a wedged
`DROP TRIGGER test_poison_thought_trg` — test DDL running against dogfood — which
was itself queued behind three long-running scans. Every layer was waiting on the
one below it.

**Containment that worked, in this order:** terminate the orphaned `DELETE`
backends, cancel the three blocking scans, then let the `DROP TRIGGER` complete
on its own. The trigger was gone, the backend count fell to 11, and the service
returned to healthy.

**Standing rule, now in every worker prompt:** tests NEVER touch dogfood.
Live-Postgres tests go through `OPENBRAIN_TEST_DATABASE_URL`, an isolated test
database, or the playground — never `open_brain_local_20260724`.

### The design-lookup gate's limitation wall blocks frozen contract spellings

**Symptom:** the gate refuses a write whose only "limit" is a literal that
already exists in a frozen contract or a vendor's config schema — there is no new
cap being proposed, but the wall cannot tell the difference.

**Operator-approved exemptions, 2026-08-02**, each for a spelling the author does
not own:

- `pino-roll` rotation configuration, for log-file operations.
- The standard SQL row clause, plus existing tool arguments — the `search_brain`
  `limit` argument, the `list_stale` envelope, `trimmed_chunk_text`.
- Realtime envelope field names — counter and budget keys.

Commits `b9c6a55`, `130b977`, and `fdee699` on
`audit/router-dedupe-matrix-2026-08-02`.

**The pattern to apply when extending this:** a vendor or contract spelling is
not a size proposal. Memory content stays unbounded, and prose proposing a *new*
cap is still walled. The exemption is for literals that are already fixed
somewhere else.

### Swapping back to core01 is one env var — and a missing token looks exactly like a dead host

**The single switch.** While this machine is in dev/dogfood mode its brain is
the local service, and the *only* thing that says so is `OPENBRAIN_BASE_URL` in
`~/.local/share/openbrain-memory/env/claudex-observation.env` — verified
2026-08-02 pointing at `http://127.0.0.1:3100`. When dev mode ends and this
machine goes back to core01 as its brain, repoint that one variable at core01
(`10.71.1.21:3100`) and refresh `OPENBRAIN_TOKEN` to the matching consumer
token. There is no second place to edit and no code change to make.

**Why this is now safe to forget.** `_ob/scripts/ob-memory-provider.ts` used to
carry `OPENBRAIN_BASE_URL: "http://10.71.1.21:3100"` as a silent built-in
default (observed 2026-08-02 at line 221), so an unset or unsourced env file did
not fail — it quietly hydrated the session from **core01** while every other
part of the session believed it was on the local dogfood brain. The provider is
being changed to source the env file and fail loud when either
`OPENBRAIN_BASE_URL` or `OPENBRAIN_TOKEN` is missing, naming the variable. After
that change a forgotten repoint is a named error instead of a session's worth of
memory written to the wrong brain. Do not reintroduce a host default to "make it
work again" — the default is the bug.

**The diagnostic that cost two sessions.** `OB ✗ gate unavailable` against a
service whose `/health` answers fine is **not** a host outage. The provider
needs BOTH variables; a present URL with a missing token produces the same
message as an unreachable host. Order of checks:

1. Are `OPENBRAIN_BASE_URL` **and** `OPENBRAIN_TOKEN` both present and exported
   in the session? (Name the variable in your report — never the token value.)
2. Is the env file sourced at all, and does its URL match the brain you think
   you are on?
3. *Only then* probe host availability.

Two sessions diagnosed a missing token as a core01 outage, and core01 was probed
healthy mid-incident — the healthy probe was read as noise instead of as the
answer. A healthy `/health` next to a failing gate is positive evidence the
problem is credentials or environment, not the network.

---

## 2026-08-04 client-install traps

These four all bit while putting the direct client stack on a second machine.
Full procedure: `docs/client-install-runbook.md`.

### A stale MCP registration answers instead of the direct stack — and `/mcp` in an error is the tell

**Symptom.** Recall or a hook fails, and the error names a URL ending in `/mcp`.
The direct client stack is installed, the env file is right, `/health` answers,
and it still does not work.

**Cause.** A retired MCP-lane registration is still configured on the box —
`claude mcp list` shows an open-brain entry — and it is being reached instead of
the direct client.

**The tell is exact: the direct stack NEVER uses a `/mcp` URL.** Its base URL is
a bare `scheme://host:port`. So a `/mcp` path appearing anywhere in an error
message is not a routing detail to investigate; it is positive proof that the
retired lane is configured and answering. There is no configuration in which the
direct stack legitimately produces that URL.

**Check and fix.**

```bash
claude mcp list
claude mcp remove <name>   # any open-brain entry
```

`setup-client.sh` prints this reminder and the current registrations at the end
of every install, because a fresh install onto a box that used to run the MCP
lane is exactly when this happens.

### The hook wrapper and the installed package are a MATCHED PAIR, and the mismatch is silent

**Symptom.** Every hook exits 0. Receipts look fine. No rows are written and no
canon is injected. The box looks completely healthy and is doing nothing.

**Cause.** Three facts that compound:

1. `config.unknown_prefixed_variables` **rejects** any `OPENBRAIN_*` variable
   that matches no declared setting — and rejects the **whole environment**, not
   the one variable.
2. The hook entrypoints **swallow every exception** (fail-open observer
   contract).
3. So a wrapper passing a variable the installed package does not declare turns
   **every hook on the box** into a clean exit 0 with zero capture and zero
   injection.

This has happened three times with three variables: `OPENBRAIN_OBSERVATION_*`,
`OPENBRAIN_SPOOL_PATH`, and `OPENBRAIN_ALLOW_INSECURE_HTTP`.

**The ordering rule (PR #544).** Install the package that declares the variable
**first**, then edit the wrapper to pass it. PR #544 verified this empirically in
that order — the old install raised `UnknownEnvironmentVariableError` with the
variable present; the reinstalled package accepted it and resolved
`allow_insecure_http=True` on both sections. Reversed, the box goes dark between
the two steps.

**The empty-string half, which re-armed the same defect.** The wrapper's
`env -i VAR="${VAR:-}"` style **cannot express "absent"** — an unset variable
reaches the child as an **empty string**. For the bool `allow_insecure_http`,
pydantic rejected `""` with `Input should be a valid boolean`, both
`load_capture_settings` and `load_canon_settings` raised, the entrypoints
swallowed it, and every hook on a host that **never opted in** went silently
dead. The fix for #525 re-created the #525 defect class.

Two layers guard it now: a validator in `config.py` mapping `""` to the default
`False`, and a conditional in the wrapper that prepends the assignment only when
non-empty — the conditional is what protects an **older** installed package that
predates the validator, which is exactly the state of a client mid-upgrade.

**Rule:** a non-string pass-through goes in the wrapper's conditional block,
never in the `env -i` list. A string tolerates the empty spelling; a bool, an
int, or an enum does not.

**The check that catches it.** Not exit code, and not `/health` — both pass on a
dead box. Start a fresh session and read the CANON PACK section counts. Zero
counts, or no pack, is this bug.

### Clients cannot install from GitHub — wheels from the Mini are the paved road

**Symptom.** `uv tool install git+ssh://git@github.com/rodaddy/open-brain...`
fails on a client box, and reaching for a package index does not help either.

**Cause.** The repo is private and the client boxes have no deploy key. There is
also no published index: `python/openbrain-memory/pyproject.toml` records that
its `fleet-nats` dependency is **not** on PyPI and lives in a private monorepo.
Docs showing `uv pip install openbrain-memory==<version>` imply an index that
does not exist for these packages.

**The paved road.** Build wheels on the Mini and stage them —
`scripts/client-bundle.sh` does this, into
`/Volumes/ThunderBolt/open-brain-local/air-bundle/`, and the bundle's
`setup-client.sh` installs from `--find-links` against the bundle's own
`wheels/`. That reuses the wheelhouse convention the Mini already runs on
(`OPENBRAIN_MEMORY_FIND_LINKS`, default
`~/.local/share/openbrain-memory/wheels`) rather than inventing a second one.

Do not burn time looking for an install route from the client. There isn't one;
the artifact has to be carried.

### `OPENBRAIN_BASE_URL` is a BARE `scheme://host:port` — no path, ever

**Symptom.** Requests 404, or fail in a way that mentions a path segment nobody
configured on purpose.

**Cause.** A path was appended to the base URL — `/mcp`, `/api`, a trailing
route. The client appends its own paths (`/health` and the rest) to whatever it
is given, so a base URL with a path produces `…/mcp/health`.

**The correct spellings**, and only these two shapes:

```
https://ob.rodaddy.live        # preferred — TLS, no opt-in needed
http://10.71.1.20:3100         # LAN plain http — needs OPENBRAIN_ALLOW_INSECURE_HTTP=1
```

`openbrain_memory.client._validate_base_url` permits plain `http` only for
loopback, so the LAN spelling is refused outright without the opt-in declared by
#525 / PR #544. Prefer `https://ob.rodaddy.live`: no opt-in, no plain-text
bearer token on the wire, and one fewer silent-failure mode.

`127.0.0.1` is correct **on the Mini only** and needs no opt-in there. The bundle
copies the Mini's env file verbatim, so a client staged from a loopback-pointed
env file must have its `OPENBRAIN_BASE_URL` edited — that is a required step, not
a nicety.

**Written down is not enforced.** The paragraph above predates the first real
client install and did not prevent it: the Air was installed from an unedited
loopback env file anyway. `setup-client.sh` now REFUSES a loopback base URL
rather than warning, with `OPENBRAIN_ALLOW_LOOPBACK_CLIENT=1` to run the script
on the Mini itself. A rule that only exists in a doc is a rule the install can
skip.

### The provider CLI takes JSON on stdin — the namespace comes from the ENVIRONMENT

**Symptom.** A request that looks exactly like the documented example fails with
`namespace must be a non-empty string`, and nothing in the error mentions an
environment variable. Adding `"namespace"` to the request body does not fix it —
it produces a receipt that lists `namespace` under
`ignored_optional_request_keys` **and** fails on `namespace` in the same JSON
object.

**Cause.** Two separate things, both fixed now, both worth knowing:

- The CLI has **no argv interface**. `openbrain-memory recall --query …` returns
  `arguments are not supported` and never reaches the brain. It reads ONE
  bounded JSON object on stdin with `operation` inside it. The shipped prover in
  `setup-client.sh` used the argv form, so it reported `[FAIL]` on every install
  regardless of whether the install worked — a check whose failure carried no
  information.
- Identity is environmental, not a request field. `OPENBRAIN_BASE_URL`,
  `OPENBRAIN_TOKEN`, and `OPENBRAIN_NAMESPACE` are read from the environment;
  the one documented in-request override is `{"config": {"namespace": "…"}}`
  (`docs/memory-contract.md`). A top-level `namespace` is now rejected with an
  error that says where it actually lives.

**The example is a request body, and a body carries no identity.** That is why
following it on a clean shell fails. `openbrain-memory --help` now carries an
`environment` block naming the three variables next to the example they qualify.

**Also fixed: scope errors arrive all at once.** Validation used to surface one
missing field per attempt, so assembling a scope by hand cost a round trip per
field — the Air hit `namespace`, satisfied it, then hit `server_id`, then the
next. Every error was true and every error was a fraction of the answer. All
five (`agent`, `platform`, `server_id`, `channel_id`, `session_key`) are now
reported in a single receipt.
