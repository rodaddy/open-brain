# Capture never drops a turn

**Decided:** 2026-07-28, by Rico, during the capture-loss investigation.
**Status:** active. Supersedes the length floor and the pattern allowlist in
`turn-capture.ts`.
**Related:** [`let-everything-pass-grading.md`](./let-everything-pass-grading.md)
(the same principle one layer down), [`light-counts-but-does-not-gate.md`](./light-counts-but-does-not-gate.md),
issues #418, #431.

---

## The decision

**A filter on the capture path may TYPE a turn. It may never decide whether to
keep one.**

Two mechanisms were removed from `turn-capture.ts` to make that true:

1. **`MIN_SIGNAL_CHARS = 24`** — a length floor. Deleted entirely, not lowered.
2. **`SIGNALS` returning `null` on no match** — a regex allowlist of phrasings.
   Inverted: a match sets the `event_type`, no match falls back to `fact`.

The only remaining test is whether there is any text at all after stripping
system-injected wrappers. Empty is nothing to store; everything else is stored.

## Why — the measurement that forced it

Measured 2026-07-28 across all projects since 2026-07-25 21:00:

| | |
|---|---|
| Operator messages in the transcripts | **1,236** |
| Operator messages in `ob_raw_turns` | **329** |
| This session alone | 228 typed, **61** stored |

**73% of the operator's turns were being discarded**, silently, by machinery
nobody had chosen deliberately.

## Why each mechanism was wrong

### The length floor

Its comment read: *"Below this, a message is an acknowledgement ('yeah', 'go',
'do it') that carries no durable content on its own."*

The operator's standing rule says the opposite:

> **"sometimes me saying okay is the equivalent of doubt."**

A two-word turn carries the whole signal once you know what it answers. The raw
lane holds the neighbouring turns that supply exactly that context, so the
information needed to interpret a short turn is *already there* — the floor
threw away the turn before anything could use it.

There is no correct threshold. Any floor re-introduces the same class of loss at
a different number.

### The pattern allowlist

`SIGNALS` is a list of regexes: blocker, correction, decision, fact. A turn
matching none of them returned `null` and vanished. That made the set of
capturable phrasings equal to the set someone had thought to write a regex for —
so anything said a new way disappeared with no trace.

**This is the identical defect the 2026-07-28 overnight verifier found in
`src/distill-window.ts`,** and its finding is the clearest statement of why the
direction is load-bearing:

> Light implements this same decision as a DENYLIST with an explicit rationale
> for why the direction is load-bearing; Distill inverted it, so a role no one
> had heard of yielded **NO CANDIDATE AT ALL** — the silent, permanent drop the
> governing decision forbids.

Same bug, second location. `turn-capture.ts` was the last stage still inverted.

## Why `fact` is the fallback type

`fact` is in `EVENT_TYPES` (`openbrain_memory/agent.py:54`), so it cannot hit
the silent-no-op path that an unaccepted `event_type` takes (#431 — an
unaccepted type writes no row and returns no receipt, silently).

It is also the honest label: it asserts the turn happened and claims nothing
about what kind of turn it was. Classification is a judgement; storage is not.

## What was deliberately KEPT

**The pasted-output rejector** (`looksPasted`). Different mechanism, different
failure. It rejects on SHAPE — Claude Code's own UI glyphs (`❯ ⏺ ⎿ ✻`),
box-drawing runs — because of a measured 2026-07-25 failure where a 1,035-char
paste of a terminal session was stored as a `decision`.

No length test could ever have caught it, and the file says why: *"a pasted
transcript contains real decision words, because it contains a real
conversation."* Removing the floor does not weaken this, and this rejector is
not a drop-by-default filter — it targets one specific, identifiable artifact.

**System-injected wrappers** are still stripped: `<system-reminder>`, hook
output blocks, policy-refresh headers. Those are machinery the operator never
typed and never read as conversation. Capturing them as operator turns is how a
corpus fills with its own plumbing.

## When to revisit — and what would justify it

This is **not permanent by design.** Operator, 2026-07-28:

> "this is not a permanent known thing for now while we're going through the
> classifications and stuff and still trying to train it. I think we keep
> everything and eventually maybe due to the rules that we come up with that
> becomes no longer the case, but **we can't start cutting things out of the
> building blocks or we're going to screw ourselves by not having the building
> blocks again.**"

So the ordering is the point: **filtering is a decision made from graded
evidence, never a default inherited from a guess.**

Revisit when, and only when:

1. A meaningful volume of candidates carries operator `review_action` labels.
2. The rejected material shows a *measured* pattern — e.g. "turns of shape X
   were rejected 40 times out of 40."
3. The corroboration counters are populated, so "said once, never referenced"
   can be distinguished from "said once, load-bearing." As of 2026-07-28,
   `content_occurrences` has 1,098 rows and exactly **one** with
   `session_count > 1`, so this evidence does not yet exist.

Until then, a filter here is a guess, and a guess that drops data is
unrecoverable. Recall quality is a *ranking* problem — a low-value memory sits
at the bottom of results, quiet and not wrong. A dropped turn is gone.

## The third mechanism: the raw lane's 8-entry window

Same day, same principle, different lane. `raw-turns.ts:188` defaulted to
reading **8** transcript entries per `Stop` hook.

### CORRECTED MEASUREMENT — the first one measured the wrong interval

A first pass measured entries between consecutive **operator messages** and
reported that the `8` truncated 57.8% of turns. **That number is wrong and is
retracted.** It assumed one conversational turn equals one `Stop`.

`Stop` fires whenever the assistant stops emitting — including between every
tool batch, not only when it finishes replying. In this session it fired 1,040
times against 198 operator messages, roughly 5× more often than the first
measurement assumed.

Measured correctly, across **9,399 `Stop` events** in all sessions since
2026-07-25 21:00 — entries accumulated between consecutive Stops:

| | |
|---|---|
| median | **3** |
| p90 | 5 |
| p99 | 9 |
| max | **17** |

| Threshold | Stops with more unread entries | Share |
|---|---|---|
| 8 (the old default) | **126** | **1.34%** |
| 30 | 0 | 0% |
| 100 (`MAX_BATCH`) | 0 | 0% |

**So the `8` was very nearly adequate: it failed 1.34% of the time, not 58%.**
The window never had to span a whole turn, only the gap since the last Stop, and
that gap is three entries.

The raise to 100 is still correct — it takes a real 1.34% to zero and costs
nothing — but it was **not** the cause of the capture loss. The `8` was also the
only constant in that file with no comment justifying it, which is what drew
attention to it; being unexplained is not the same as being the culprit.

### What this means for where the loss actually was

The distilled lane is where the damage was: the length floor and the `SIGNALS`
allowlist, both fixed above. The raw lane had neither, and at 3 entries per Stop
it was inside its window essentially always.

Verified after the backfill: this session shows **243 operator rows in
`ob_raw_turns` against 198 typed in the transcript** — complete, with the
difference explained by multi-block entries the two counters treat differently.
The raw lane is now whole and self-maintaining.

**Keep watching it.** The correct health check is the simple one, not hook
mechanics: compare typed-in-transcript against `is_human_prompt` rows in
`ob_raw_turns` for a live session. If those diverge again, the cause is
something not yet identified, and the instinct to measure window sizes should be
resisted — that is what produced the retracted 58%.

It assumed one turn is a handful of entries. True for plain conversation, false
with tool calls: every call and every result is its own transcript line. Worse,
the collection loop walks **backward**, so the 8 kept are the *newest* — the
tail of the agent's tool output — while the operator's message that opened the
exchange is the oldest part, and the first thing cut.

**Raised to `MAX_BATCH` (100)**, the server's Zod-validated cap
(`src/tools/ingest-raw-turn.ts:150-152`), which exists so a batch "keeps the
interactive turn unblocked." Defaulting to it costs nothing and stays inside the
contract.

**This is a stopgap, and the residual is not random.** 6.6% of turns still
exceed 100 entries, and those are the heavy ones — a 553-entry turn is a long
debugging session, exactly the material most worth keeping. The cap is also per
hook invocation, not per session, so a hook that never fires still loses its
window permanently. A window can only guess how far back to look; the
per-session watermark in #418 knows. That is the real fix.

## Cost accepted

The distilled lane gets noisier: every "ok" and "yeah" now lands as a `fact`.
That was weighed and accepted. It is the same trade as
`let-everything-pass-grading.md` — the tier system is the precision filter, and
it is applied later and reversibly, where a dropped turn is neither.

## OPEN — what counts as "the conversation"? Not decided.

Settled: **everything on screen goes in.** The operator's words and the
assistant's replies, in full, no length test, no phrasing allowlist.

Not settled: **the machinery underneath.** Reasoning blocks, tool invocations,
tool output, hook injections, subagent sidechains. `ob_raw_turns` currently
holds all of it — 25,151 rows of which only 1,089 are operator turns, so tool
and assistant volume is ~96% of the table.

Operator, 2026-07-28, and the uncertainty is the point:

> "we need to decide if any of this ... any of the back-end signals of you doing
> thinking and talking and stuff actually needs to be brought in as well. I
> think that's less likely and something that should be pushed out to somewhere
> else, but I honestly at this point I don't know anymore."

Earlier the same day he sketched the likely split — memory versus observability,
with Langfuse/LangGraph named as the plausible home for execution traces. That
is a direction, not a decision.

**Do not resolve this by inference, and do not let it be resolved by accident.**
The failure mode is a stage quietly starting to filter on `role` or on
`metadata.kind` and calling it cleanup. Two things to hold until it is decided
deliberately:

1. Storage and use are different questions. Tool output can stay in
   `ob_raw_turns` and be excluded from grading without being deleted — the
   backfill already tags `metadata.kind` so a consumer can exclude without
   re-deriving what a row was.
2. Tool output is not inert context. `distill-window.ts` keeps `tool` turns as
   context-only precisely so tool results can ground a claim, and the overnight
   verifier confirmed that behavior. Removing it from the corpus would change
   what the extractor can see, not just how much.

Deciding this needs evidence that does not exist yet: grade a real batch, then
look at whether the useful exchanges depended on surrounding tool output.

## Where this lives now, and where it must land

The change was applied to the **deployed** adapter at
`~/.local/share/openbrain-memory/adapters/versions/sha256-cd5fb4e4.../`
`ob-memory-provider/turn-capture.ts`, because that is what runs on every turn
and the loss was ongoing.

That code is scheduled for deletion by **#420**. The Python port (**#418**,
PROV-9) must carry this decision forward — it is written into #418's acceptance
criteria — and the next wheel install will overwrite the deployed file. If
capture starts silently shrinking again, check whether this decision survived
the port.

Verified at the time of the change, 9/9 functional cases: `yes`, `ok`, `no do
it`, and `okay` all capture as `fact`; `use postgres not sqlite` still
classifies as `decision`; empty, whitespace-only, system-reminder-only, and a
pasted terminal block all correctly return null.
