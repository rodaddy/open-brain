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

## Cost accepted

The distilled lane gets noisier: every "ok" and "yeah" now lands as a `fact`.
That was weighed and accepted. It is the same trade as
`let-everything-pass-grading.md` — the tier system is the precision filter, and
it is applied later and reversibly, where a dropped turn is neither.

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
