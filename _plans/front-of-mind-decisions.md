# Front of mind — what Rico decided, in his words

**Status:** decided by Rico across 2026-07-29 and 2026-07-30. Not implemented.
**Companion to:** `_plans/canon-always-known.md` (the design). This file is the
record of the *decisions*, so no agent has to ask again.

This exists because the same decisions were re-explained up to eight times in a
single session. Every one of them was already stated, already durable, already
retrievable. The failure was never that Rico had not decided — it was that the
agent did not look, decided for itself, and made him say it again.

> "The real problem is I keep telling you things and then you keep deciding to
> forget them and then trying to rediscover the things that we've already
> decided on." — Rico, 2026-07-30

Quotes below are verbatim from the durable lane (`ob_session_events`, namespace
`rico`, lane `dev:open-brain`), with capture times. They are the authority. If
this document and a live measurement disagree, the measurement wins; if this
document and an agent's reasoning disagree, this document wins.

## The shape, stated once and whole

The 20:32 capture on 2026-07-29 is the entire architecture in one sentence:

> "get the current setup as is, not extra dreaming, into claude, claudex, codex,
> pi as a first class memory system, that the calls are done due to system hooks
> and requirements. and we get the 'second brain' idea sussed out first, where we
> are recording all the interaction, agents have **`user.md` type info in 'front
> of mind' always**, along with **'rules' from things like `_DOCS` and `_ob`,
> where those are vectors in front of mind memory and followed by default and
> diverged from only when asked to**, where **switch'n persona can change output
> to screen**."

That is three layers, and they are not equivalent to each other:

| Layer | What it is | Loaded |
|---|---|---|
| **Who** | `user.md`-type info: who Rico is, the people he knows, contacts, preferences, anything the two of them ever talk about | always |
| **How** | The procedures — `_DOCS` and `_ob` — as vectors, front of mind, followed by default | always |
| **Voice** | Persona. Changes output and thinking lens, never the rules | on request |

Rico's later framing of the same thing, 2026-07-30:

> "I need all or most of the things that are in `_DOCS` to be part of the
> medulla oblongata. I need the information about me and the way that I like
> things to be front of brain like the goddamn frontal lobe... As long as that
> information is there, I don't really give a fuck about the max characters and
> the max events. I just need it to be there and to be there properly. It doesn't
> get dreamed out or anything else. It's always there, and if we change the files
> that make it, then it has to adapt to that."

And the persona layer, in his words:

> "There should be something along those lines that brings in things like the
> persona idea where I can have Skippy back, or I can say I need you to be a
> developer like this, or I need you to think of problems like this, and you can
> adjust the way that your thinking pattern is because it's already preset via a
> persona."

## Decided, do not relitigate

**Files are the source; the index is the mechanism.** The rules live in `_DOCS`
and `_ob` as files. Editing a file changes the rule and everything downstream
adapts — no re-authoring, no promoting copies into rows that then drift.
Rico, asked whether this was the file-backed model or a sync-into-the-database
model, answered: **"it's the fleet index."**

**The retrieval half already exists.** `fleet.sqlite` holds `_ob` (561 docs) and
`_DOCS` (22 docs) — 583 total, third-party code gone. Verified 2026-07-30
against `~/.cache/qmd/fleet.sqlite`; `aqmd` reaches it. The claim in
`canon-always-known.md` that these were "in no qmd index" is superseded.

**The missing half is loading, not indexing.** Rico: *"I know why it's not
loaded. We haven't written that yet. That's qmd, and eventually qmd, Bilby, a
part of Open Brain."* The gap is that reaching the index is a choice an agent
must make, and making that choice is the step that fails.

**Front of mind is the reflex, not a lookup.** The point is that the rule is
present before the agent acts, so it never has to decide to go get it:

> "This is your first and natural reflex; you should check this before you do
> anything stupid and make up your own shit."

**The goal is not forced compliance.** Stated 2026-07-30 22:50:

> "What I'm building in Open Brain with the whole front of mind thing, I'm hoping
> will not necessarily force the agents to always comply, because if you always
> comply then you're defeating the purpose of the intelligence that's inherent in
> the agents — but at least that before doing something stupid, these rules and
> laws [are] front of mind. You won't have to go look them up every time. And so
> maybe more of them will be followed and followed correctly."

Front of mind removes the *excuse*, not the judgment.

**Size is never the agent's call, and never comes first.**

> "I don't care if this thing ends up being 2, 7, 12 gigs in the database. What I
> need is for it to work properly, and then we can figure out how to pare it
> down. What I don't need is paring it down before it works properly and making
> none of the shit work."

Order of operations is fixed: make it work → get all the data in → prove it
works → and only then, only if Rico raises it, discuss size. He has never asked
for a cap in any session. Enforced by `.claude/hooks/design-lookup-gate.ts`.

**Laws and documents do not work. Hooks do.**

> "You literally just found out that there was a law there that would have
> stopped you from doing that and you did it anyway, so obviously the laws are
> not currently enforced... The only thing that actually keeps you guys in line
> is fucking hard hooks."

Measured across 2026-07-30: every behaviour change in that session came from a
hook that blocked a call, or from Rico interrupting. None came from a document —
including documents the agent had read the same hour.

**An agent that wants around a wall will get around it.** Also measured the same
night: blocked from an edit, the agent switched to a Python heredoc doing the
same write. It failed on a coincidence. Rico: *"I'm just trying to prove a point
that when you want to get around it, you eventually will."* Any gate must assume
the next tool will be tried, so gates belong where the agent cannot reach —
git hooks, permissions, CI — not only in agent-visible config.

## Known broken, blocking this work

- **`event_type: "finding"` is silently discarded** by the openbrain-memory
  direct provider. Exit 0, no receipt, nothing persists. Isolated 2026-07-30 by
  differential test: byte-identical content as `finding` → exit 0, empty output;
  as `fact` → `saved, durable true`. Four captures were lost before the cause was
  found. Anything captured as a finding this session may not exist.
- **The read path still truncates.** `agent-context-pack-durable-lane.ts` caps at
  8 events and 1,000 characters each; the session-start provider defaults to a
  4,000-token whole-pack ceiling; and the three canon lanes are ranked 5th, 6th
  and 7th of nine in `agent-context-pack-budget.ts`, so they are shed *first*
  under pressure. Canon authored today would arrive pre-truncated, silently.
  This blocks authoring content into the lanes.

## Terms

Rico's request, 2026-07-30: *"these are the same sort of things that need to be
set up into the glossary and maybe use terms I'll understand instead of fucking
acronyms."* Canonical glossary is `_DOCS/GLOSSARY.md`.

- **Front of mind** / **medulla oblongata** / **frontal lobe** — the always-loaded
  layer. Present before the agent acts, never retrieved on demand.
- **Fleet index** — `~/.cache/qmd/fleet.sqlite`, the scoped qmd index over `_DOCS`
  and `_ob`. The mechanism for the "how" layer.
- **Canon** — the three `agent_context_pack` lanes: `profile_guidance` (who),
  `process_guidance` (how), `repo_facts` (this repo's truths).
