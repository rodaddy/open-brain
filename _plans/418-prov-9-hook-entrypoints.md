# PROV-9: port the hook entrypoints to Python, and stop the capture loss

Issue: **#418**, part of epic **#409**. Blocks **#420** (settings.json cutover).
Date: 2026-07-28

---

## Why this stopped being a routine port

PROV-9 was filed as a mechanical port. It is now the fix for a measured,
ongoing data loss.

**Measured 2026-07-28.** Across all projects since 2026-07-25 21:00 the
transcripts hold 1,236 operator messages. `ob_raw_turns` held 329 — **27%**.
This session alone: 228 typed, 61 stored.

A backfill (`scripts/backfill-transcripts.ts`, commit `9e7f242`) recovered the
history: 4,571 → 25,151 turns, 329 → 1,089 operator messages, 1 → 18 repos. That
is a stopgap. **The live hook keeps dropping turns until this issue lands.**

## The three defects, in the code that is running right now

The deployed adapter is `~/.local/share/openbrain-memory/adapters/versions/`
`sha256-cd5fb4e4...`, dated 2026-07-25 15:30, and `~/.claude/settings.json`
points at it. Seven older sha256 versions sit beside it, unused.

| Defect | File:line | Effect |
|---|---|---|
| `MIN_SIGNAL_CHARS = 24` | `turn-capture.ts:59`, enforced at `:361` | Any operator turn under 24 characters returns null before classification. |
| `limit ?? 8` | `raw-turns.ts:188` | Each `Stop` hook reads only the last EIGHT transcript entries. |
| `TAIL_BYTES = 1MB` | `raw-turns.ts:31` | A long transcript cannot be fully re-read even if the limit were raised. |
| no watermark | (absent) | No cursor, offset, queue, or drain anywhere in the adapter — verified by search. Read the tail, forget. A missed entry is missed permanently. |

### The 8-entry window is the big one

`raw-turns.ts:15-17` states the intent: `Stop` fires when a turn completes, so
"the finished exchange is readable from disk." True when a turn is one entry.
False the moment the agent makes tool calls — each call and each result is its
own transcript line, so a turn with six commands is 13+ entries and the
operator's message has already scrolled out of the window. Nothing ever comes
back for it.

Nobody chose to drop three quarters of the operator's turns. Someone chose
"8 is enough for one exchange," and tool-heavy turns broke it. The `8` carries
no comment justifying the number, unlike almost everything else in these files.

### The 24-char floor contradicts a standing rule

`turn-capture.ts:57-58` justifies it: *"Below this, a message is an
acknowledgement ('yeah', 'go', 'do it') that carries no durable content on its
own."*

Operator's standing rule says the opposite: **"sometimes me saying okay is the
equivalent of doubt."** A two-word turn carries the whole signal when you know
what it answers, and the raw lane has the neighbouring turns that supply that.

Operator decision, 2026-07-28: **the floor comes out entirely.** Not lowered,
not made configurable. *"we gotta get rid of the 24 character floor altogether
because, based on context around it, it could still be something that needs to
be looked at."*

## What replaces them

**Floor: deleted.** Every operator turn is captured. No length test anywhere.

**Kept: the pasted-output rejector** (`turn-capture.ts:62-71`). This is a
different mechanism catching a different failure — measured 2026-07-25, a
1,035-char paste of a terminal session was stored as a `decision`. It rejects on
SHAPE (Claude Code's own UI glyphs `❯ ⏺ ⎿ ✻`, box-drawing runs), not on length,
and length could never have caught it: *"a pasted transcript contains real
decision words, because it contains a real conversation."*

**Window: a per-session watermark.** Store the last transcript byte-offset
ingested per session; each `Stop` reads from there to EOF. Nothing is skipped
regardless of how many entries a turn produces, and a missed hook self-heals on
the next one. This also retires `TAIL_BYTES`: reading forward from a known point
does not need to guess how far back to look.

**Short turns: keep everything, classify nothing away.** Operator, 2026-07-28:
*"this is not a permanent known thing for now while we're going through the
classifications and stuff and still trying to train it. I think we keep
everything and eventually maybe due to the rules that we come up with that
becomes no longer the case, but we can't start cutting things out of the
building blocks or we're going to screw ourselves by not having the building
blocks again."*

So: no filtering on the capture path while the grading rules are still being
learned. Tightening is a later decision made from evidence, not a default
inherited from a guess.

## Scope — the full port, not a shortcut

Operator rejected a capture-only pass as *"a fucking top out shortcut."*
All of PROV-9's named modules get ported.

| Module | Lines | Notes |
|---|---|---|
| `claude-hook.ts` | 633 | the entrypoint; event dispatch |
| `turn-capture.ts` | 383 | **floor deleted**, rejector kept |
| `raw-turns.ts` | 278 | **watermark replaces the 8-entry window** |
| `takeover.ts` | 381 | named in #418 scope |
| `qmd-startup.ts` | 137 | named in #418 scope |

Out of scope, per #418's own non-goals: **editing `settings.json`** — that is
#420. Also untouched here: `guard.ts`, `receipt-state.ts`,
`content-free-observation.ts`, `activate-claude.ts`, `package-runtime.ts`, which
belong to #413–#417 and #419.

## Acceptance (from #418, plus this issue's additions)

- [ ] Each entrypoint exercised by a functional test over stdin → stdout/stderr/exit
- [ ] No business logic in an entrypoint module
- [ ] Hook output byte-compatible with what Claude Code expects, proven against
      captured real input
- [ ] Console scripts declared in `pyproject.toml`
- [ ] **No length floor exists anywhere in the capture path** — a one-character
      operator turn is captured, proven by a test
- [ ] **The pasted-terminal rejector still rejects**, proven by a test using the
      measured 1,035-char failure case
- [ ] **A turn producing 30+ transcript entries loses nothing**, proven by a test
- [ ] `uv run mypy` and `uv run ruff check` clean, matching the repo bar
- [ ] **A real turn reaches `ob_raw_turns` end to end** — transcript file →
      watermark → `openbrain_memory.AgentMemory.ingest_raw_turns` → row in the
      playground clone, proven by a `-m live` test. Added 2026-07-31 after a
      session produced 184 tests and zero database writes. No write path may
      exist inside `python/openbrain/` itself; the sibling package owns all
      writes (`_plans/python-port-sequence.md`, "The write path already
      exists").

## Why the port is still the real fix, even though the TypeScript was patched

#420 exists to delete that code; a patch there is thrown away, and the next
wheel install overwrites the hash directory. The enum has already drifted
between the two copies (`#409`: *"openbrain_memory/agent.py declares 9 event
types; the TS adapter declares 8 — missing `question`"*), which is what two
hand-maintained copies of one vocabulary does.

The patch below was applied anyway, because the loss was ongoing and the port is
hours of work. That is a stopgap with a known expiry, not a change of plan.

---

## APPLIED 2026-07-28 to the deployed adapter (interim, ahead of the port)

Full reasoning: `docs/decisions/capture-never-drops-a-turn.md`.

| Change | File | Was | Now |
|---|---|---|---|
| Length floor | `turn-capture.ts:59,361` | `MIN_SIGNAL_CHARS = 24` | **deleted**; only an empty-string test remains |
| Pattern gate | `turn-capture.ts:384-392` | allowlist, `return null` on no match | **inverted**; no match falls back to `event_type: "fact"` |

The second defect was found ONLY because the first was fixed and then tested:
removing the floor did not make "ok" capture, because `SIGNALS` was
independently dropping anything its regexes did not match. Two mechanisms, one
effect, and the length floor was hiding the allowlist behind it. Worth
remembering during the port — fixing one filter is not evidence there is only
one.

Verified 9/9 (`scripts/__tests__/capture-floor-removal.check.ts`): `yes`, `ok`,
`no do it`, `okay` capture as `fact`; `use postgres not sqlite` still classifies
as `decision`; empty, whitespace-only, system-reminder-only, and a pasted
terminal block still return null.

**NOT fixed, still live:** `raw-turns.ts:188` `limit ?? 8` and
`raw-turns.ts:31` `TAIL_BYTES`. Those are the raw lane and want the watermark,
which is this issue's work.

### Consequences for the port

- The port MUST carry `capture-never-drops-a-turn.md` forward. If capture starts
  silently shrinking after #418 lands, that decision did not survive.
- The next wheel install overwrites the deployed file, reverting both fixes.
- `scripts/__tests__/capture-floor-removal.check.ts` holds the nine cases. Port
  them into the Python suite and delete the file.

## Rejected — do not re-propose

- **Capture-only partial port.** Operator: a shortcut.
- **Lowering the floor instead of removing it.** Any floor re-introduces the
  same class of loss at a different threshold.
- **Filtering short turns by classification before storage.** Cutting the
  building blocks is the failure being fixed.
- **Removing the pasted-output rejector along with the floor.** Different
  mechanism, different failure, still needed.

## Related

- `_plans/435-436-dream-hosted-rem.md` — everything downstream reads what this
  captures. The 310 graded exchanges came from a corpus missing 73% of its input.
- `scripts/backfill-transcripts.ts` — the stopgap; re-runnable any time to catch
  up until this lands.
