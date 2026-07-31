# The Python port, in order

**Status:** PLAN. Steps 0-2 are DONE and committed; 3 onward are not built.
**Measured:** 2026-07-30 against the deployed adapter
(`~/.local/share/openbrain-memory/adapters/versions/sha256-cd5fb4e4.../`),
`src/tools/ingest-raw-turn.ts`, and `python/openbrain/`.
**Owns:** #418 (PROV-9). Blocks #420 (settings.json cutover).

The governing plan is `_plans/418-prov-9-hook-entrypoints.md` — scope, acceptance
criteria, and a rejected-list that stays rejected. This file is the **sequence**:
what lands in what order, what proves each step, and what must not come back.

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

## Sequence

Each step is independently landable, independently testable, and reverts alone.
No step begins until the previous one's gates are green.

**Every step runs the same four gates**, and a step is not done until all four
pass:

```bash
uv run mypy src/openbrain          # types
uv run ruff check --no-cache src tests   # incl. PLR1702 nesting law
uv run pytest -q                   # behaviour
python scripts/pytools/generate_package_docs.py --check --path ...   # docs
```

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

### Step 3 — `utils/admission.py`: ONE definition, imported everywhere

**The keystone of the whole port.** Nothing that carries a bound is written
until this exists, because otherwise each ported module invents its own again
and the port recreates the census.

States what may be accepted, in one module:
- Structural bounds only, each named with what it is and **whose** it is
  (a pipe read size is the OS's; a Postgres column type is Postgres's).
- **No content bound.** Text is stored whole; `src/chunking.ts` already exists
  for embedding oversized content while the full text stays on the parent row.
- Every rejection returns a **reason**, never a silent `null` — the
  `ob-memory-provider.ts:146 -> :1912` failure was `return null`, exit 0.

**Tests:** a >64 KB payload is accepted and produces a receipt; a >200 KB one
too; every rejection path names its reason; no function in the module cuts a
string.

**Proves the defect is gone:** a test that greps the built package for
`[:MAX_` slicing patterns on content paths and fails if any exist.

### Step 4 — `models/turn.py`: the shapes, typed once

Pydantic models for `RawTurn` and `TurnSignal`, replacing the two hand-written TS
types. One definition each, validated at the boundary.

`_plans/consolidation-2026-07-30.md:49` — the Python side is already the model to
copy: 10 `Protocol` classes vs **0** named typed contracts in TS.

**Tests:** round-trip a real transcript record; a malformed one fails naming the
field.

### Step 5 — `apps/capture/`: port `turn-capture.ts` (423 lines)

Surface: `last_user_message`, `classify_turn`, `turn_signal`.

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
- **a 5,000-char turn is stored whole** — the new one, pinning defect #1

### Step 6 — `apps/capture/transcript.py`: port `raw-turns.ts` + the watermark

Surface: `repo_from_cwd`, `read_recent_turns`.

**Replaces the window with a per-session byte watermark.** Store the last
transcript offset ingested; each `Stop` reads from there to EOF. Retires both
`limit ?? 8` and `TAIL_BYTES`: reading forward from a known point does not need
to guess how far back to look. A missed hook self-heals on the next one.

**`MAX_CONTENT_CHARS` does not come across** (defect #2 — the server dropped it).

**Tests:**
- a turn producing 30+ transcript entries loses nothing (#418 acceptance)
- a 553-entry turn — the measured worst case — loses nothing
- a skipped hook is recovered by the next one
- **a 250 KB turn is stored whole**, pinning defect #2

### Step 7 — `apps/hooks/`: port the three remaining leaves

`takeover.ts` (381), `qmd-startup.ts` (137), and the `claude-hook.ts` event
dispatch (633; six events: SessionStart, UserPromptSubmit, PreCompact,
PostCompact, SessionEnd, Stop).

`claude-hook` lands **last** because it is the only module importing the others,
and by now all of them exist and are proven.

`_plans/418-prov-9-hook-entrypoints.md:111` — *"No business logic in an entrypoint
module."* The entrypoint parses stdin, calls into a capability, writes stdout.

**Tests:** each entrypoint exercised stdin → stdout/stderr/exit; output
byte-compatible with what Claude Code expects, proven against **captured real
input**, not a fixture someone wrote from the docs.

### Step 8 — `_githooks/` + `install.sh`

`core.hooksPath` points there. Closes #311, which is half-landed: `.githooks/`
is tracked but holds only `pre-push`, and `core.hooksPath` currently points at
untracked `.git/hooks` — so **the reviewable hook is not the hook git runs**.

The exemplar's `_githooks/` is **empty**, so there is nothing to copy; this is
written from the standard's description.

### Step 9 — console scripts, then hand off to #420

`[project.scripts]` declared only once targets exist. Currently absent
deliberately: a declared entry point whose module does not exist still installs
a shim and dies at runtime, and **no lint, type, or test gate inspects entry-point
targets** — so a broken script ships green.

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

- `_plans/418-prov-9-hook-entrypoints.md` — scope and acceptance criteria
- `_plans/consolidation-2026-07-30.md` — the census, and the reuse rule
- `docs/decisions/capture-never-drops-a-turn.md` — what capture may never do
- `docs/CODING_STANDARDS.md:160` — never truncate on a read or write path
- `src/tools/ingest-raw-turn.ts:30` — the server already removed its ceiling
- `docs/standards/STANDARDS-python.md` — layout, config keystone, flat control flow
