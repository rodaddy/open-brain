# Operator-rejection outcomes — marking a stored turn as superseded

**Status:** PARKED. Designed 2026-07-30, not built. Resume from here.

## The problem

Every lane event is stored flat. There is no field recording **how it landed**.
So on recall an agent can pull up a confident description of an approach the
operator tore apart thirty seconds later, and nothing in the record says so —
the agent repeats it.

Measured 2026-07-30 on the live clone (`open_brain_local_20260724`):
`ob_session_events` has no outcome column. `importance` is a tier
(`hot`/`warm`/`cold`, 8214/1977/23) — storage temperature, not correctness.

## The shape

Store the outcome in the existing `metadata jsonb`. **No migration required.**

```json
{"outcome": "superseded",
 "superseded_by": "<event_id of the correction>",
 "reason": "reverted an operator-authored file on a redirect"}
```

Values: `superseded` (wrong, replaced), `confirmed` (operator approved),
`suspect` (nominated, not yet judged), absent (default).

**Do not delete the bad event.** A superseded event surfaces on recall *with its
correction attached*, which is more useful than never having stored it: the
agent sees "tried, rejected, here is why" instead of confidently repeating it.

## Which stage owns it

**NOT Light.** `docs/dream-design.md:143-190` rules it out three ways, and the
doc anticipates the temptation directly — *"If light needed a model to infer
what capture already told it, the capture would be broken and that is the bug to
fix instead."*

1. *"Model: None. Hard requirement."* Judging whether a message is a correction
   requires reading meaning.
2. It runs **inside the write transaction** of the raw-turn insert. When turn N
   is written, turn N+1 does not exist — Light structurally cannot see the
   message that would mark the previous one wrong.
3. *"Records only what is already known at write time."* An outcome is known
   later, from what came after.

**REM owns it.** `dream-design.md:268-278`: REM is idle-triggered, has a model,
and is a prep stage that "finds, groups, and packages work." It already owns
**contradiction pairing (#396)**.

An operator rejection *is* a contradiction pair — turn N contradicts turn N-1 —
sourced from the operator's correction rather than from two conflicting stored
claims. This is a new **source of pairs** for #396, not a new subsystem.

**UNVERIFIED:** whether #396 is implemented or still only an issue. Check before
building.

## The division of labour

| when | who | what |
|---|---|---|
| write time | Light | non-semantic flag: rejection markers present in this turn. Regex, no model, known at write time from the content itself. A nomination, not a verdict. |
| idle | REM (#396) | reads the window, decides whether N-1 was actually wrong, writes `outcome` + `superseded_by` + reason. The verdict. |
| immediate | `/wtf` | operator override. Skips to the verdict, writes the rule, redoes the work. |
| recall | any agent | superseded events surface with their correction attached |

Profanity **nominates**; it never decides. The operator swears when excited,
when quoting someone else's code, and when agreeing — and the coldest
corrections are often the most serious. A smoke alarm is not a verdict.

## `/wtf` — the operator override

Rationale, operator 2026-07-30: *"as much as I like to do the fucking rage
because it makes me feel a little better, if it's actively making the agents
work worse, then I need to figure out a way to fix that."*

Correcting forward in a new message leaves the wrong action in context as
precedent, and the correction dies at compaction. Editing the prior message and
re-running deletes the bad turn but persists nothing. `/wtf` is the third
option: vent, and have the vent become enforcement.

1. Take the operator's text verbatim — the anger marks which failures are
   expensive.
2. Extract the rule.
3. Persist it: OB capture + `docs/CODING_STANDARDS.md` or `AGENTS.md`.
4. Re-run the failed work with the rule in context.
5. Mark the prior event `superseded`.

**Escalation:** first offence writes a rule; a repeat offence on the same rule
generates a **hook**. Only hooks actually stopped the agent on 2026-07-30 —
`design-lookup-gate.ts` blocked it four times, including when it was confident
it was right. Prose rules are weaker than code.

**What it cannot do:** a skill runs inside an already-loaded context and cannot
unwrite the turns above it. Only the harness rewind (`Esc Esc`, edit, re-run)
removes a bad turn from context. `/wtf` should end by writing an explicit
SUPERSEDED marker, which turns the bad turn from silent precedent into a
labelled counter-example, and should say plainly when a context is poisoned
enough to need a real rewind.

## Candidate hooks from the 2026-07-30 failures

1. **Revert guard** — block `git checkout --` / `git restore` on a file the
   agent modified this session unless the operator explicitly said to revert. A
   redirect ("that wasn't necessary") is not an undo. This one destroyed
   operator-authored work.
2. **Scope guard** — when the operator names a target, block edits outside it
   until scope is widened.
3. **Measurement guard** — block asserting a number in user-facing text that did
   not come from a tool result this session.

## See Also

- `docs/dream-design.md` — Light (§143-190), REM (§268-300)
- `docs/code-brain-design.md` — R3 authority tiers
- `docs/CODING_STANDARDS.md` — the standards `/wtf` would write into
