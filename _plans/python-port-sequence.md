# The Python port, in order

**Status:** PLAN. Steps 0-2, 4, 5, 6, 7, 9, 10 are DONE and committed; step 3
is WITHDRAWN; **step 8 is a first slice** — `stop.py` is real, live-proven,
review-swarmed (3 lanes incl. a Sol terminal audit; six findings fixed in
`967a3be`, delta-verified), every other verified event is an explicit stub
(see the step). **The spine is live-proven 2026-07-31:**
a turn round-trips transcript → watermark → `ingest_raw_turns` → playground
Postgres row, whole (300,024 chars intact), ordered (`occurred_at` set), and
replay-safe. The live gate caught two contract facts in-process tests could
not: the server requires `role` + `turn_index`, and namespace is TOKEN-derived
(a client-requested namespace is not what lands).
**Measured:** 2026-07-30 against the deployed adapter
(`~/.local/share/openbrain-memory/adapters/versions/sha256-cd5fb4e4.../`),
`src/tools/ingest-raw-turn.ts`, and `python/openbrain/`.
**Owns:** #418 (PROV-9). Blocks #420 (settings.json cutover).

The governing plan is `_plans/418-prov-9-hook-entrypoints.md` — scope, acceptance
criteria, and a rejected-list that stays rejected. This file is the **sequence**:
what lands in what order, what proves each step, and what must not come back.

---

## EXECUTION CONTRACT — read first, every session

Every rule here was violated by a prior session and cost operator time. The
capture times are the lane events (`ob_session_events`, lane `dev:open-brain`).

1. **No new bounds, ever.** Nothing in this package shortens, floors, or
   bounds content — see "A number in a test is an INPUT SIZE" below. A
   5,000-character bound was proposed 2026-07-30 22:15 AFTER the rule was
   already written. `docs/CODING_STANDARDS.md:160` settles it; do not ask.
2. **Never read the old TypeScript adapter** (22:39). Inputs are
   `docs/decisions/`, the 418 acceptance criteria, and `docs/standards/`. A fact
   only the old code holds → write a **stub**, record the question in
   `_plans/rewrite-gotchas.md`, and ask. Do not import the answer.
3. **Web-search before building any mechanism** (2026-07-31 01:06). Existing
   repo helper → well-known maintained library → stdlib → custom, in that
   order. Hand-rolling a solved problem is a defect.
4. **Never write a database or HTTP write path in this package.** The sibling
   package already owns it — see "The write path already exists" below. A
   second implementation is a defect on sight
   (`_plans/consolidation-2026-07-30.md:99`).
5. **End-to-end before hardening.** Measured 2026-07-31: 7 commits, 8 modules,
   184 tests — and zero database writes. Components hardened in isolation
   while the application did not exist. Step 7 (the spine) outranks every
   polish, refactor, or coverage task until a turn round-trips.
6. **Testing budget (operator, 2026-07-31).** The goal is all pieces DONE, not
   each piece tested to death: after-the-fact testing stays well under 30% of
   the coding time per piece. The five fast gates stay; per-step review swarms,
   live-gate expansion, and test-forging cycles are deferred to ONE hard-testing
   pass when every piece exists. Not NO testing — cheap gates per step, hard
   testing once at the end.
7. **A decision made in conversation is written into a file the same session**
   (20:07 — *"you said parked it, but you didn't write a file... it's gonna be
   fucking forgotten"*). Plans and decision records are the durable copy; the
   chat is not.

---

## What we are porting FROM, and why there is no TypeScript in `python/`

Five modules in the deployed adapter, outside this repo, deleted by #420:

| module | lines | imports from siblings |
|---|---|---|
| `claude-hook.ts` | 633 | **all five below** |
| `turn-capture.ts` | 423 | none |
| `raw-turns.ts` | 301 | none |
| `takeover.ts` | 381 | none |
| `qmd-startup.ts` | 137 | none |

**The coupling is a clean star.** Four leaves import nothing from each other;
only `claude-hook` depends on them. So the leaves port in any order,
independently, each with its own tests, and `claude-hook` lands last when its
dependencies already exist and are proven. There is no big-bang step.

`python/openbrain/` is 4 source files, all `.py`. Nothing `.ts` is copied into
it; the adapter is read as a reference and then deleted by #420.

---

## The three defects that must NOT survive the port

These are live, measured, and a naive port re-creates all three by copying
constants.

### 1. `turn-capture.ts:386` — silent content truncation. **UNFIXED, LIVE.**

```ts
const MAX_CAPTURE_CHARS = 1_500;
const bounded = redact(cleaned).slice(0, MAX_CAPTURE_CHARS);
```

Every distilled capture is cut at 1,500 characters. No error, no flag, no
receipt saying it happened.

`docs/CODING_STANDARDS.md:160`: *"Never truncate, cap, cut, or shorten anything
on an Open Brain read or write path."*

**The Python port stores the whole text.** Not a larger number — no cut.

### 2. `raw-turns.ts:268` — a cut mirroring a rule that no longer exists

```ts
const MAX_CONTENT_CHARS = 200_000;   // "Mirrors the server's per-turn cap"
content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content
```

**The server already removed it.** `src/tools/ingest-raw-turn.ts:30`:

> *"NO CONTENT CEILING. `content` was `z.string().max(200_000)`, which REJECTED
> an oversized turn outright — losing 100% of it rather than the overflow, and
> (because the client mirrors this check and fails the batch closed) taking up
> to 99 good turns with it."*

The client is still mirroring a deleted rule. Copying the constant into Python
would reload a defect the server side already paid to remove.

Note what the server comment says about *why* the number was never a safe
default: it *"was sized for TEXT. Change the encoder to take images or video and
200k stops being a generous bound and starts being a data-loss bug on ordinary
input."*

### 3. `raw-turns.ts:188` `limit ?? 8` and `:31` `TAIL_BYTES` — the window

`_plans/418-prov-9-hook-entrypoints.md:157`: **still live, still dropping.** The
interim patch fixed only the length floor and the `SIGNALS` allowlist. The
watermark is this issue's work.

---

## The duplication this port exists to end

20+ independent content-bound constants across the adapter. The clearest
evidence they were never one idea:

| constant | file | value |
|---|---|---|
| `MAX_CONTEXT_CHARS` | `qmd-startup.ts` | **3,000** |
| `MAX_CONTEXT_CHARS` | `takeover.ts` | **12,000** |

Same name, 4× apart, no relationship, nothing linking them. Plus
`MAX_CONTENT_CHARS`, `MAX_CAPTURE_CHARS`, `MAX_MESSAGE_CHARS` — four different
names for "how much text", each independently chosen.

`_plans/consolidation-2026-07-30.md:99`: *"A second implementation of an existing
rule is a defect on sight, even when it is correct today — because the next fix
will reach one copy and not the others, which is exactly how a 101 KB capture
came to vanish without an error."*

**The rule for every step below:** a value that is genuinely structural (a pipe
read size, a datatype maximum) is named ONCE in `utils/`, documented with what it
is and whose it is, and never silently applied. Everything else does not get a
bound at all.

---

## TWO APPLICATIONS, NOT ONE

Operator, 2026-07-31, after catching a format factory being designed into the
live hook path: *"those are distinctly different applications."*

| | **live adapter** — `apps/capture/` | **bulk ingester** — not yet built |
|---|---|---|
| what it is | the Python that sits inside Claude Code / Code / Pi, replacing the MCP Open Brain | a separate app that sucks in giant session files from anywhere |
| trigger | a `Stop` hook, once per turn | an operator runs it, rarely |
| reads | watermark → EOF: a few KB | a whole file: 27 MB measured |
| deadline | **5 seconds, hard** (`~/.claude/settings.json`) | none |
| watermark | the entire point | irrelevant; it wants everything |
| formats | **ONE** — whichever harness it is attached to | many: Claude, Code (base64 images), Hermes (no fixed shape) |
| failure | must never block the session | may retry, quarantine, resume |

**The live adapter must never see any of this.** No format factory, no
whole-file read, no bulk staging, no Hermes. A hook attached to one harness only
ever sees that harness's format, so format dispatch on the deadline-critical
path is complexity for a case that cannot occur.

**The bulk ingester REUSES the live ingester's parts** — operator: *"reuse
already working code, good."* `records.py` and the four `signal.py` modules are
pure functions over a line or a string, with no I/O and no state, so the bulk
app imports them directly and adds only its own format adapters. The factory
keyed on input type belongs THERE.

This split already exists in the TypeScript being ported:
`scripts/backfill-transcripts.ts` is a separate script
(`_plans/418-prov-9-hook-entrypoints.md:183`), not a mode of the hook.

**Staging store for the bulk side — decided 2026-07-31 02:15, recorded here
the same day:** the bulk ingester may load the whole giant file into SQLite
and yield each turn to its caller. Operator: *"big file goes in, SQLite...
rejiggers it into the proper manner and then pops off and yields each output."*
This belongs to the BULK app only; the live adapter never stages. (The
measurement above — +90 MB RSS to extract 85 KB — is why staging exists.)

---

## THE WRITE PATH ALREADY EXISTS — route through it, never rebuild it

Discovered late, 2026-07-31, after 7 commits of building components that had
nowhere to write: **`python/openbrain-memory/` is a finished, tested client
that already owns every write this application makes.** Nothing in
`python/openbrain/` talks to Postgres or HTTP. Verified: the only
`openbrain_memory` reference in the package today is a vocabulary import in
`models/turn.py`.

| lane | client call | server tool | the server already owns |
|---|---|---|---|
| **raw** (whole turns) | `AgentMemory.ingest_raw_turns` — `agent.py:611` | `src/tools/ingest-raw-turn.ts` | secret-value redaction (`:137`), scaffolding drop (`:205`), dedupe on `UNIQUE(namespace, turn_uuid)` (`agent.py:625`), no content ceiling (`:30`) |
| **distilled** (classified events) | `AgentMemory.append_event` — `agent.py:542` | `src/tools/append-session-event.ts` | lane resolution, embedding, content hashing (`:7`, `:137-190`) |

Both calls carry **spool durability** (`openbrain_memory/spool.py`): a send
that cannot reach the server is spooled and replayed, so a returned call is a
kept turn even with the service down — which is what lets a `Stop` hook meet
its 5-second deadline without ever dropping anything.

Consequences, so the next session does not re-derive them:

- **Which modules feed which lane.** `watermark`/`transcript`/`records` feed
  the RAW lane; `wrappers`/`paste`/`redaction`/`classify`/`signal` feed the
  DISTILLED lane. The raw lane sends the turn **untouched** — no client-side
  stripping, redacting, or classifying, because the server owns that judgment
  and client-side salience already failed once (`agent.py:619-625`: *"21 user
  turns and ZERO assistant turns captured on 2026-07-25"*).
- **Session lifecycle comes from `AgentMemory` too** (`agent.py:222`,
  `_require_session`). Do not invent one.
- **If a needed call shape is missing from the client**, that is a change to
  `python/openbrain-memory/` with its own tests — not a bypass from this
  package.

**Measured 2026-07-31, and it shows the two shapes are not interchangeable:**
`read_since(27.4 MB, offset=0)` returned 244 turns in 58ms but peaked at
**+90 MB RSS to extract 85 KB of operator text** — a ~1000x amplification, and
one transcript line was 1.28 MB on its own. That is the BULK call signature. A
live `Stop` hook reads from its watermark and touches a few KB. Testing the
live adapter through the bulk call proves the wrong thing: 18 of the current
tests read from offset 0 and only 8 resume from a watermark, which is inverted.

---

## Sequence

Each step is independently landable, independently testable, and reverts alone.
No step begins until the previous one's gates are green.

### Tight units — applies to EVERY step below

Operator, 2026-07-30: *"keep functions, classes, files, sub modules and modules
really tight, single purpose as much as possible."*

This is not a style preference; it is the mechanism that makes the rest of the
plan work. `_plans/418-prov-9-hook-entrypoints.md:145` records what one mixed
module cost: removing the length floor did not make `ok` capture, because
`SIGNALS` was independently dropping it. **Two mechanisms in one file, one
effect, and the first hid the second.** Separate files could not have hidden
each other that way.

Applied to every step:

- **One module, one job**, named for the job. If the module docstring needs
  "and" to say what it does, it is two modules. `turn-capture.ts` was 423 lines
  doing four jobs — strip wrappers, reject pasted output, redact secrets,
  classify — which is why it gets built here as four files.
- **One function, one decision.** A function that both computes and writes is
  two functions; the caller composes them. This is what makes each testable
  without fixtures.
- **A module states what it does NOT do.** The wrapper stripper does not decide
  whether the result is worth keeping. Writing the non-goal down is what stops
  the next edit quietly adding it.
- **No module imports a sibling to borrow one helper.** That helper belongs in
  `utils/` or it belongs duplicated — and if it is duplicated twice, it belongs
  in `utils/`. Sibling imports are how the star topology becomes a mesh.
- **The 500-line rule** from `docs/standards/STANDARDS-python.md`, with
  `config.py` the sole documented exception. A file approaching it is answering
  more than one question.
- **PLR1702 at 3** is the mechanical half of this, already enforced and proven
  to fail a 4-deep function.

The review pass after each step asks the complexity question directly (see
"Code review, on a schedule" below): an abstraction with one caller, a
parameter nothing varies, a wrapper that only forwards, a class that could be a
function. Delete it then, while it has one caller.

**A number in a test is an INPUT SIZE, never a bound.** The tests below feed
text of various lengths and assert every character comes back. Those sizes are
what the test writes; they are not thresholds, and nothing in the port measures
content length at all. `docs/CODING_STANDARDS.md:160` is the rule these tests
exist to prove compliance with.

The assertion is always `len(stored) == len(given)`, parameterised over a spread
of sizes, so any reintroduced shortening fails some case regardless of where it
sits. One fixed size would prove only that one size survives.

**Every step runs the same five gates**, and a step is not done until all five
pass:

```bash
uv run mypy src/openbrain                 # types
uv run ruff check --no-cache src tests    # incl. PLR1702 nesting law
uv run pytest -q                          # behaviour, in-process
OPENBRAIN_TEST_DATABASE_URL=postgres://.../open_brain_local_play \
  uv run pytest -q -m live                # behaviour, REAL Postgres
python scripts/pytools/generate_package_docs.py --check --path ...   # docs
```

### The live gate — against the playground, every step

`open_brain_local_play` exists for this: a real 3.8 GB clone of the dogfood
database, with live's schema, ownership, and data shape. In-process tests prove
the logic; they cannot prove a write survives a round trip through Postgres.

**Every step that touches a write path gets a live test**, not just the last one.
A capture that stores whole text in memory and gets shortened by the column
type, the driver, or an encoding is still data loss, and only the round trip
finds it.

The TS side already does this — `src/graph-derivation.live.test.ts:22` and
`scripts/promote-lane-shared.test.ts:31` both gate on
`OPENBRAIN_TEST_DATABASE_URL`.

**But copy the pattern, not its defect.** `AGENTS.md:172`: those tests *"SKIP
SILENTLY without OPENBRAIN_TEST_DATABASE_URL, so a green run may have tested
nothing."* That is the same class as ruff's `preview` warning and the qmd index
reporting `0 new` — a check that reports success while examining nothing.

So the Python live tests are marked `-m live` and **the marker is what makes the
skip loud**: `pytest -m live` with no database URL set FAILS with the reason,
rather than passing having run zero tests. A step's live gate is only satisfied
by a run that reports collected tests actually executing.

Playground rules that already exist and still apply
(`docs/local-playground.md`): re-pull with `scripts/local-clone-db.sh` when a
fresh snapshot is wanted; **never merge playground data back into live**; the
clone is disposable and rebuildable in ~3 minutes.

### Code review, on a schedule — not only at the end

Reviewing 1,800 ported lines at the end finds the wrong things: by then every
shortcut has callers and removing one is a refactor.

**After each step lands**, before the next begins, a review pass over that step's
diff alone, answering four questions:

1. **Did any bound come across that was not proven structural?** The standing
   check from `_plans/418-prov-9-hook-entrypoints.md:145` — *"fixing one filter
   is not evidence there is only one."*
2. **Is anything here a second implementation of something that already exists?**
   `_plans/consolidation-2026-07-30.md:99` — a second implementation is a defect
   on sight, even when it is correct today.
3. **What complexity is here that the behaviour does not require?** An
   abstraction with one caller, a parameter nothing varies, a wrapper that only
   forwards, a class that could be a function. Delete it now, while it has one
   caller.
4. **Would a reader learn the rule, or only the mechanism?** A comment saying
   what the code does is noise; one saying why the obvious alternative is wrong
   is the thing that stops it being reintroduced.

Findings that generalise go to `docs/sme/` per `AGENTS.md`, so the next review
starts smarter. A finding fixed but not recorded gets rediscovered.

At steps 5 and 8 — the two largest — the review is a **fresh-context** pass, per
the repo's PR gate, because by then the author has stopped being able to see the
code.

### ✅ Step 0 — the floor (`dc8f34a`, DONE)

`config.py` keystone, `utils/logging_config.py` three sinks, ruff rules that
actually fire.

Proven: a 4-deep function makes ruff exit 1; the same probe under the old config
exits 0. Removing `setup_logging` from `load_settings` makes the keystone test
fail.

### ✅ Step 1 — file config (`2791915`, DONE)

`secrets/` allowlist, `config.example.json`, JSON layers.

Found and fixed a real precedence inversion: sections were each their own
`BaseSettings`, so a `config.json` silently beat an exported `DB_HOST`.

### ✅ Step 2 — this plan

### Step 3 — ~~`utils/admission.py`~~ WITHDRAWN. Build from decisions instead.

**This step was wrong and is deleted, not deferred.** It proposed a new module
to own "what may be accepted". Three checks killed it, all under a minute:

- **Neither exemplar has one.** `python-exemplar/utils/` and
  `typescript-exemplar/utils/` are each three files — datetime, http, logging.
  A fourth concept with no precedent in either is exactly the invented
  complexity this rewrite is supposed to remove.
- **This repo already owns that boundary**: `src/contract.ts`,
  `src/contract-schemas.ts`, `src/validation-errors.ts`, `src/chunk-write.ts`,
  `src/chunking.ts`.
- **`docs/decisions/contract-is-the-agent-surface.md`** already decided WHERE
  refusals are declared — the contract, because a contract-driven agent's entire
  knowledge is what `get_contract` returns. A refusal declared in a Python
  module is unreachable by the agents that need it.

**What replaces it: nothing.** There is no content bound to centralise, because
there is no content bound. `docs/CODING_STANDARDS.md:160` settles it, and
`src/tools/ingest-raw-turn.ts:30` already removed the server's. Structural
facts (a pipe read size, a column type) are named at the one place they apply,
with whose rule it is, if and when one actually appears.

The property that mattered still gets proven, but as a test rather than a
module: **no function on a write path shortens a string.** That assertion lives
with the code it guards, in steps 5 and 6.

### The rule this withdrawal establishes

**Build from the decisions, not from the old file.**

Operator, 2026-07-30: *"I don't think you should be ingesting shit from the old
TypeScript files. You should either be doing that stuff directly in Python, or
you should stub it out until the new TypeScript applications are properly
written."*

Reading a 423-line module to rewrite it makes every constant in it a judgment
call, decided deep into the file under momentum. That is how
`MAX_CAPTURE_CHARS = 1_500` and a `MAX_CONTENT_CHARS` mirroring a deleted server
rule both survive.

So the inputs to every step below are:

| source | what it supplies |
|---|---|
| `docs/decisions/` | what must be TRUE |
| `_plans/418-prov-9-hook-entrypoints.md` | acceptance criteria |
| `docs/CODING_STANDARDS.md` | the rules |
| `docs/standards/*-exemplar/` | the shape to build in |

The old adapter is **not** on that list. Where it is the only source of a fact —
the exact bytes Claude Code expects on stdout per hook event — the step writes a
**stub**, records the question in `_plans/rewrite-gotchas.md`, and asks. It does
not import the answer out of a file scheduled for deletion.

`src/` is the same application being rewritten; building the new Python against
`src/contract.ts` (936 lines) couples the new thing to the old thing's shape.

### Step 4 — `models/turn.py`: the shapes, typed once

Pydantic models for `RawTurn` and `TurnSignal`, replacing the two hand-written TS
types. One definition each, validated at the boundary.

`_plans/consolidation-2026-07-30.md:49` — the Python side is already the model to
copy: 10 `Protocol` classes vs **0** named typed contracts in TS.

**Tests:** round-trip a real transcript record; a malformed one fails naming the
field.

### Step 5 — `apps/capture/`: written from the capture decision

**Built from `docs/decisions/capture-never-drops-a-turn.md`, not from
`turn-capture.ts`.** That decision states the required behaviour completely;
the old file is only one implementation of it, and a defective one.

**FOUR modules, because the decision names four distinct jobs** — and the old
423-line file mixing them is exactly what let one filter hide another:

| module | its one job | the decision says |
|---|---|---|
| `wrappers.py` | remove system-injected blocks | `:97` machinery the operator never typed |
| `paste.py` | reject on SHAPE — UI glyphs | `:87` *"different mechanism, different failure"* |
| `redaction.py` | mask secret VALUES, keep the statement | never drop a turn for holding a credential |
| `classify.py` | assign an `EventType` | `:14` may TYPE, may never DROP |

`:87` is explicit that paste-rejection is not a length test and must survive
independently of the removed floor. In separate files that independence is
structural rather than remembered.

`signal.py` composes them into `turn_signal`, and is the only module here that
imports the other four. Same star topology as the modules being replaced.

Non-goals, stated per module so the next edit does not add them: the wrapper
stripper does not judge worth; the redactor does not drop; the classifier does
not filter.

Carries forward, per `docs/decisions/capture-never-drops-a-turn.md`:
- **No length floor.** Not lowered — absent.
- `SIGNALS` stays **inverted**: no match falls back to `fact`, never `null`.
- The **pasted-output rejector stays** — different mechanism, different failure
  (a 1,035-char terminal paste stored as a `decision`, measured 2026-07-25).
- **`MAX_CAPTURE_CHARS` does not come across.**

**Tests** — the nine cases from `scripts/__tests__/capture-floor-removal.check.ts`
ported to pytest, plus:
- a one-character turn is captured (#418 acceptance)
- the measured 1,035-char pasted block is still rejected (#418 acceptance)
- **input length is preserved exactly, at every size tried** — the new one,
  pinning defect #1. Parameterised over a spread of input sizes that brackets
  the old 1,500 cut and keeps going well past it, asserting
  `len(stored) == len(given)` each time. These are INPUT sizes, not bounds:
  the test says "whatever you give it comes back whole", and the numbers only
  exist so a reintroduced cut at any threshold makes some case fail.
  A single fixed size would only ever prove that one number survives, and a cut
  placed above it would pass.

### Step 6 — `apps/capture/transcript.py`: the watermark, written fresh

**Built from #418's acceptance criteria, not from `raw-turns.ts`.** The
watermark REPLACES that module's approach rather than porting it, so reading it
supplies nothing except the two constants that must not come across.

**THREE modules**, splitting what the old file did in one:

| module | its one job |
|---|---|
| `watermark.py` | remember and advance a per-session byte offset |
| `transcript.py` | read records from an offset to EOF |
| `records.py` | turn one transcript line into a `RawTurn` |

The watermark is separated because it is the only part holding STATE. Mixing a
cursor into the reader is how "read the last N entries" became untestable
without a real transcript, and why the `8` was never noticed.

**Replaces the window with a per-session byte watermark.** Store the last
transcript offset ingested; each `Stop` reads from there to EOF. Retires both
`limit ?? 8` and `TAIL_BYTES`: reading forward from a known point does not need
to guess how far back to look. A missed hook self-heals on the next one.

**`MAX_CONTENT_CHARS` does not come across** (defect #2 — the server dropped it).

**DONE** — commit below. Built as specified, three modules, 55 tests.

**The worst case in this plan was low.** Measured 2026-07-31 against a live
26.5 MB transcript: **225 of 234 operator turns (96%)** produced more entries
than the 8-entry window reads, and the largest turn produced **1,646** entries,
not 553. The window was the normal path failing.

**Four record-shape assumptions were wrong**, all of them the obvious guess —
`type == "user"` is mostly tool results, `userType` separates nothing,
`message.content` has two shapes, and the first three lines of every transcript
carry no `uuid`. `promptSource` ∈ {`typed`, `queued`} is the discriminator.
Full table in `docs/GOTCHAS.md`. Reading the real file cost one `jq` pipeline;
inferring the shape would have shipped a capture path storing command output as
operator turns.

**Non-obvious requirement found while building:** the offset advances only to
the last **newline**, never to EOF. A hook can fire mid-write, so the tail may
be half a JSON object; committing that position corrupts every later read.

**Tests:**
- a turn producing 30+ transcript entries loses nothing (#418 acceptance)
- a 553-entry turn — the plan's worst case — loses nothing
- a 1,646-entry turn — the measured worst case — loses nothing
- a skipped hook is recovered by the next one
- **input length is preserved exactly, at every size tried**, pinning defect #2.
  Same shape as step 5: parameterised across sizes bracketing the old 200,000
  cut and continuing past it, asserting `len(stored) == len(given)`. Input
  sizes, not bounds.

### ✅ Step 7 — THE SPINE: one turn in the database, end to end. **DONE, live-proven.**

Landed as `apps/capture/deliver.py` (~100 lines, composition only) plus the
contract fields the live gate exposed: `TurnRole` + `occurred_at` on
`RawTurn` (`models/turn.py`), `timestamp` parsed in `records.py`,
`turn_index` assigned per send in `deliver.py` because the server treats it
as a per-invocation counter and orders by `(session_ref, occurred_at)`
(`src/tools/ingest-raw-turn.ts`, migration 036).

**This step outranks everything after it, and every polish task before it.**
The failure it corrects, measured 2026-07-31: 8 modules and 184 tests with
zero database writes — hardening in isolation while the application did not
exist.

One composition, in `apps/capture/`, and nothing new underneath it:

```
transcript file → read_since(watermark) → records → RawTurn
  → AgentMemory.ingest_raw_turns          (the sibling package, as-is)
  → row in ob_raw_turns                   (playground database)
  → watermark advances
```

**The watermark advances only after `ingest_raw_turns` returns.** A returned
call is a kept turn — the spool makes a failed send durable
(`openbrain_memory/spool.py`) — so advancing then never walks past an
unwritten turn. Advancing before the call is dropping
(`docs/decisions/capture-never-drops-a-turn.md`).

**No new mechanism.** This step is composition only: if it seems to need a
retry loop, a queue, a batch manager, or a config knob, that is the sibling
package's job and it already does it. See the write-path section above.

**Proof — the live gate is the point of this step:**
- `-m live` test: one real transcript turn round-trips through the client into
  `ob_raw_turns` on the playground clone; the row exists; every field survives.
- `len(stored) == len(given)` at the DB boundary, parameterised over the same
  size spread as steps 5–6 — the column, driver, and encoding are the last
  places a shortening can hide, and only this test looks there.
- a replayed batch is a no-op (server dedupe, `agent.py:625`).
- the reader-test emphasis rebalances here: the LIVE call shape is
  watermark → EOF, and the suite currently reads from offset 0 far more often
  than it resumes (24 `BEGINNING_OF_FILE` reads vs 14 resumes, counted
  2026-07-31 in `test_capture_transcript.py`). New tests assert the resume
  shape first; offset-0 is the bulk app's shape.

Environment: the local dogfood service and the playground clone
(`docs/local-playground.md`) — never merge playground data back into live.

### Step 8 — `apps/hooks/`: one module per event, written from behaviour

**FIRST SLICE LANDED 2026-07-31** (`6c7822e` fixtures, `64d37b0` entrypoints):
the real event-name set was captured from the live harness (2.1.220) into
`tests/fixtures/captured_hooks/` — 8 events; `PostCompact` never fired and has
no module (Open in `_plans/rewrite-gotchas.md`). `stop.py` is REAL and invokes
the spine through `session.py` (client construction lives there, so the
entrypoint stays a parse-and-exit shell); `dispatch.py` is the table; the other
seven events are explicit stubs whose capabilities are recorded as Open
questions, not invented. Live gate: a Stop payload round-trips into
`ob_raw_turns` (`test_capture_hooks_live.py`). REMAINING: real capabilities
for the stubbed events, and `PostCompact` if it exists in practice.

**ONE MODULE PER EVENT**, not one dispatcher holding six branches:

```
apps/hooks/session_start.py   apps/hooks/pre_compact.py    apps/hooks/stop.py
apps/hooks/user_prompt.py     apps/hooks/post_compact.py   apps/hooks/session_end.py
apps/hooks/dispatch.py        <- maps an event name to one of the above. Nothing else.
```

A 633-line file with six `if event === "..."` branches is six jobs sharing a
namespace: every branch can reach every helper, so a change for one event
silently reaches the others. Six files cannot do that. `dispatch.py` is a table
from name to callable — the enum+table shape
`docs/standards/STANDARDS-python.md` prefers over a branch chain, and small
enough to read in one screen.

`docs/standards/typescript-exemplar/src/exemplar/apps/hook/main.ts` is the
reference for what an entrypoint contains: parse stdin, call one capability,
write stdout. `_plans/418-prov-9-hook-entrypoints.md:111` — *"No business logic
in an entrypoint module."*

`claude-hook` lands **last** because it is the only module importing the others,
and by now all of them exist and are proven.

`_plans/418-prov-9-hook-entrypoints.md:111` — *"No business logic in an entrypoint
module."* The entrypoint parses stdin, calls into a capability, writes stdout.

**Tests:** each entrypoint exercised stdin → stdout/stderr/exit; output
byte-compatible with what Claude Code expects, proven against **captured real
input**, not a fixture someone wrote from the docs.

### ✅ Step 9 — `_githooks/` + `install.sh` — DONE (`49f47cd`)

Landed 2026-07-31: `pre-push` moved tracked (`git mv`, byte-identical) into
`_githooks/`, with `_githooks/install.sh` idempotently setting repo-local
`core.hooksPath` to the relative `_githooks`. Proven in a working checkout:
`git rev-parse --git-path hooks` resolves there and a dry pre-push executed
through it. The direct-pointer model was chosen over the python-exemplar's
copy-into-`.git/hooks` installer, which recreates exactly the
reviewable-vs-running divergence #311 fixes.

`core.hooksPath` points there. Closes #311, which was half-landed: `.githooks/`
is tracked but holds only `pre-push`, and `core.hooksPath` currently points at
untracked `.git/hooks` — so **the reviewable hook is not the hook git runs**.

The exemplar's `_githooks/` is **empty**, so there is nothing to copy; this is
written from the standard's description.

### ✅ Step 10 — console scripts, then hand off to #420 — DONE (`e499d1f`)

Landed 2026-07-31: one script, `openbrain-capture-stop = openbrain.apps.hooks.
stop:main` — the only entrypoint doing real work; the stubs earn scripts when
they earn behavior. The missing gate now exists: `test_console_scripts.py`
parses `[project.scripts]` from the shipped pyproject and imports every
declared `module:attr`, so a broken declaration fails pytest instead of
shipping a shim that dies at runtime. `settings.json` wiring stays #420's.

`[project.scripts]` declared only once targets exist — a declared entry point
whose module does not exist still installs a shim and dies at runtime, and
before this step **no lint, type, or test gate inspected entry-point
targets** — so a broken script shipped green.

Editing `settings.json` is #420, explicitly out of scope here.

---

## The standing check, every step

Before each step is called done, one question: **did any bound come across that
was not proven structural?**

`_plans/418-prov-9-hook-entrypoints.md:145` — removing the length floor did not
make `ok` capture, because `SIGNALS` was independently dropping it. Two
mechanisms, one effect, and the first was hiding the second.

> *"fixing one filter is not evidence there is only one."*

So each step's tests assert the **absence** of the class of defect, not just the
presence of the feature.

---

## Rejected — do not re-propose

From `_plans/418-prov-9-hook-entrypoints.md:169`, still in force:

- **A capture-only partial port.** Operator: *"a fucking top out shortcut."*
- **Lowering a floor instead of removing it.** Any floor re-introduces the same
  class of loss at a different number.
- **Filtering short turns by classification before storage.**
- **Removing the pasted-output rejector** along with the floor.

And from this measurement:

- **Copying `MAX_CAPTURE_CHARS`, `MAX_CONTENT_CHARS`, or any sibling.** They are
  the defect, not the design.

---

## See Also

- `docs/architecture.md` — the application map: who writes through what, with states
- `_plans/418-prov-9-hook-entrypoints.md` — scope and acceptance criteria
- `_plans/consolidation-2026-07-30.md` — the census, and the reuse rule
- `docs/decisions/capture-never-drops-a-turn.md` — what capture may never do
- `docs/CODING_STANDARDS.md:160` — never truncate on a read or write path
- `src/tools/ingest-raw-turn.ts:30` — the server already removed its ceiling
- `docs/standards/STANDARDS-python.md` — layout, config keystone, flat control flow
