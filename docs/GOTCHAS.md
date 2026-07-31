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
