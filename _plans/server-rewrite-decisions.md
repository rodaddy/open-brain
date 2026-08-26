# Server Rewrite — Operator Decisions

Status: WRITTEN 2026-08-26. Operator decisions, verbatim. Do not paraphrase
these into softer versions.

Source: session transcript
`ffeea7c4-f75f-4a52-8c5c-fca0838159a5.jsonl`, operator turns of 2026-08-26
(03:45Z–05:37Z). Every blockquote below is Rico's own text, character for
character, including the typos. Where a decision could not be sourced to a
verbatim operator quote it is tagged `UNVERIFIED`.

---

## SCOPE

### Move Open Brain off the Mac: external inference, external database, then a container

> yep, if we're going to be moving our inference to the video card on the VM in K3S and we're going to be moving the database over to the database on K3S. We should just do as close to a raw run of everything we have over there and fucking verify it. If we're good with the output, then that's where we go.

2026-08-26 03:55Z — The k3s GPU VM serves inference and the k3s Postgres serves
storage; the migration is verified by running the real workload against them,
not by inspection.

### End state is a Docker image on k3s; nothing runs locally

> and Eventually, once we're done with the development work on this here locally, we are going to create a Docker image of Open Brain which will also live on the K3S cluster, and none of this will live locally here.

2026-08-26 03:56Z — Containerization is the terminal state of this program, and
"none of this will live locally" is the acceptance condition.

### Code quality is now the only blocker to shipping

> so now that we've got the fucking external inference and we've now got an external database, the only thing we really have to do is fix the code and then once that's fixed and fully verified and tested then we bottle this up into Docker mode and ship it off to the K3Ss.

2026-08-26 03:58Z — Sequence is fixed: fix code → verify and test → containerize
→ deploy; nothing else enters the queue ahead of it.

### `src/` is garbage and has contaminated `server/`

> yep, so all of the things in source are pretty much written as straight up garbage code and because of that half of the things in server are borderline garbage code and we need them all to fit into the exact proper coding patterns and right now they for sure do fucking not

2026-08-26 03:57Z — The rewrite target is both trees, not just the legacy one;
`server/` inherited the defects and does not currently meet the pattern.

### Kill `src/`, keep `server/` — but reconcile the shared pieces first, not a straight delete

> yeah, I understand we need to merge those things and it's not a straight kill source and switch to server. We have to reconfigure and rejigger a bunch of shit that's shared between the two and then we have to or we move it all over from source to server and then we rejigger it and get it into the proper format. I'm not sure the best most proper way to do it, but we got way too many files that are way too big and logging is shit and the fact is it doesn't follow what my standards are. I know my standards for TypeScript are not quite as tight as my Python standards, but use the ideas and basis of the Python standards to figure out what TypeScript should do too

2026-08-26 05:04Z — Shared modules are moved and reshaped into `server/` before
`src/` is retired; deleting `src/` without that reconciliation is not the plan.

### Removing `src/` and reshaping `server/` is the immediate work; dreaming is LATER

> alright, where are we at? I think that we need to get this squared away and start re removing the fucking slash source code and only having the slash server code and fixing all of the server code so that it fits proper structural patterns. And we need to start doing this ASAP. No more fucking anything else. We've got the fucking inference off. We got the SQL off. We got the only thing we need to do is this. Eventually we'll do the dreaming thing, but let's get this set up and packaged up so that it doesn't have to run on my machine anymore.

2026-08-26 04:43Z — Dream/REM work is explicitly deferred behind the rewrite and
packaging; "no more fucking anything else" bars other lanes from starting.

### Reformatting is part of the scope, not a follow-up

> it's also reformat everything into a proper format instead of the giant pile of junk shit that it currently is

2026-08-26 04:44Z — Structural reformatting ships inside this program rather
than being filed as a later cleanup ticket.

### Storage headroom (5GB vs 40GB) is not a concern

> also We're not even close. You're talking about five gigs versus forty gigs. I think we're fine

2026-08-26 04:46Z — The 40Gi per-instance k3s volume is adequate for the corpus;
do not raise capacity as a blocker or design around it.

### The k3s Postgres already exists and is the target

> didn't I just give you a fucking SQL server on the fucking K3S cluster to use

2026-08-26 04:43Z — `10.71.20.167:5432` (cluster `general`, PG 18.4, pgvector
0.8.6, databases `qmd` and `open_brain`) is the database of record; do not go
looking for another.

---

## STANDARDS

### Turn off all local embeddings everywhere so failures surface fast

> what I'd like you to do is turn off all local embeddings everywhere and if shit fails then we'll be able to find it real fucking fast won't we

2026-08-26 04:29Z — Every localhost embedding fallback and default is removed so
misconfiguration fails loudly at the call site instead of silently degrading.

### No local inference anywhere in the project

> we should at this point no longer be using any local inference for anything in this project. It should all be running through the AI VM in K3S.

2026-08-26 03:59Z — All inference traffic routes to the k3s AI VM; a local
endpoint in config or code is a defect.

### That is state one on the road to the end state

> if it's not, it damn well should be, and that's the first state on the way to the end state

2026-08-26 03:59Z — Cutting local inference is the first sequenced state of the
migration, not an optional cleanup.

### Use the Python standards as the basis for the TypeScript standards

> I know my standards for TypeScript are not quite as tight as my Python standards, but use the ideas and basis of the Python standards to figure out what TypeScript should do too

2026-08-26 05:04Z (same turn as the reconciliation ruling) — The TypeScript
standard is derived from the Python one rather than invented; the looser TS
rules get tightened toward the Python shape.

### Read the current Development standards, not cached copies

> use the new standards from development docs, not from your docs, they've changed

2026-08-26 05:04Z — `/Volumes/ThunderBolt/Development/_DOCS/` is the source of
truth; the repo-local generated copies may be stale.

### Function length ceiling goes from 50 to 100 lines, with hard failure and stack traces

> so I think the 50 lines of code for a function, what do you think? Is that a bit harsh? I think a function should be allowed to be upwards of a hundred lines of code, and it should be wrapped properly around try something continue that doesn't allow it to pass through safely it should fail hard if it fails and the decorator for logging should give stack traces so we can figure it out complexity yep that's a fucking problem max parms? Yep, that's fuck a problem. Max depth? Yep, that's fuck a problem. That's a problem. Max lines, that's a problem. No explicit any or actually an explicit any is a problem unused vars and dead code fucking huge problem Yikes

2026-08-26 05:12Z — `max-lines-per-function` is 100; complexity, max-params,
max-depth, max-lines, no-explicit-any, unused vars and dead code all stay
enforced, and error handling must fail hard with a stack trace rather than pass
through.

### Documentation and docstrings do not count toward the length

> and don't include documentation or doc doc strings in the length

2026-08-26 05:12Z — The 100 is code lines; comments and doc blocks are stripped
before the rule is applied.

### Confirmed: update the rule to 100

> yeah, update the hundred rule, but oh my god, this is gonna be some fucking work my guy. also we need to work on the configuration. I know that there's no direct TypeScript equivalent to config.py in the Python applications, but we have to figure out something that for lack of a better word matches it

2026-08-26 05:13Z — The 100-line change is authorized, and configuration is
named as the next standards problem to solve.

### Config must construct and pass down logging and configuration, or it is the weaker idea

> does config.ts fire up all of the logging and full configurations and everything and then pass those down to the rest of the application? Because if not, then it's not the same, just the same idea and the weaker one at that

2026-08-26 05:14Z — A `config.ts` that only parses environment does not satisfy
the requirement; the keystone must build logging and config and hand them down
through the application.

### One logger, travelling the whole application via decorators

> that is my friend less than fucking ideal I Don't even think the logger is using what the standards say and it should just be a single logger and it should travel the entire application using decorators for all of the functions and classes. Jesus titty fuck.

2026-08-26 05:07Z — A single logger instance is threaded through the app and
applied to functions and classes by decorator, replacing per-module loggers.

### Duplicated code belongs in shared utils

> that seems like a lot of code. How much of that code is fucking reusable shit that should be in some sort of utils or something like that where we're reusing it and doing it correctly instead of fucking 17 versions of the same shit that definitely has the ability to get out of fucking shape from everything else.

2026-08-26 05:06Z — Repeated implementations are consolidated into shared
helpers so they cannot drift apart.

### Hand-rolled code should be packages

> and how much of our code is extremely sadly fucking hand-rolled instead of using packages? I don't think it's as bad as it's in my head, but I think it's worse than I would think is ideal

2026-08-26 05:08Z — Bespoke implementations of solved problems get replaced with
maintained libraries.

### The tests are probably crap too

> also, don't forget the tests are probably also crap based on everything you just said

2026-08-26 05:10Z — Test code is in scope for the same quality bar as
production code; it is not assumed healthy.

---

## ENFORCEMENT

### oxlint and the git rules are a necessity — enforcement before cleanup

> oxlint is a fucking necessity as is our git rules for commits and pushes. If we get those in place, most of the shit has to be fixed or you can't commit or push.

2026-08-26 05:09Z — The lint config and the commit/push gates land first; the
gate is what forces the cleanup, so it is not sequenced after it.

### Remove every safeguard that lets the rules be skipped

> remove any of the fucking safeguard bullshit things that allow you to olay actually following the rules. Straight up make sure that they don't exist in the configs and all of the rules are followed and enforced so commits and pushes cannot happen unless all of the rules are followed.

2026-08-26 05:10Z — Exemptions, overrides, and bypass paths are deleted from the
configs, and a commit or push that violates a rule cannot complete.

### The cost of the first compliant commit is accepted

> it's gonna be a bitch to do the next commit and or push. It's gonna take a lot of work.

2026-08-26 05:10Z — The backlog the gate exposes is expected and is not grounds
for softening the gate.

### The lint debt is paid one file at a time, each file finished before the next

> Ruling (Rico, 2026-08-26): O1. Pay the debt one file at a time, each file brought fully to standard and passing before the next, lane after lane, until the whole app passes the standards. Order: the files blocking L2 first (server/main.ts, search-brain.ts, search-all.ts, search-engine.ts, langfuse-tracing.ts), then every remaining server/ file with findings. Each lane: one file, behavior-preserving, existing tests unmodified and green, done-means = oxlint --deny-warnings on that file exits 0 (RED on main).

2026-08-26 15:42Z — https://github.com/rodaddy/open-brain/issues/780

Once L1 armed the gate (#771, `c73a7f7`), the pre-existing violations blocked
L2's own commits — draft PR #779 could not land. This ruling settles how the
debt is paid: per FILE, sequentially, each one finished before the next starts,
rather than per rule or per rung. Consequence for the ladder: for
`server/tools/search-engine.ts` and `server/observability/langfuse-tracing.ts`,
`max-lines` is among their findings, so their L4 split is pulled FORWARD into
their lint lane. 142 findings across non-test `server/`, measured at `49ecfbe`;
the per-file checklist lives in the issue.

`UNVERIFIED` as a character-for-character operator quote. Unlike every other
blockquote in this file, the text above is the ruling AS RECORDED in the #780
comment posted under the operator's account, not a transcript line — the
underlying spoken wording is not preserved in an artifact this file can cite.
It is quoted exactly as #780 states it, and #780 is the authority.

### Better git hygiene: branches and PRs pushed, committed, merged

> well you need to do better git hygiene and make sure that all of your fucking PRs and branches are pushed committed and merged and then we won't have this problem will we

2026-08-26 04:01Z — Work is not left sitting on unpushed branches or unmerged
PRs; landing it is part of doing it.

---

## PROCESS

### The head is the manager, not the worker — delegate to subagents

> also, start using sub-agents to do that fucking stupid dirty work. Don't do it yourself. There's no reason for that. You're the manager, not the fucking worker. Fucking send workers out to do the worker. You're the manager. Instruct them on how to fucking do their jobs. That's the way it works

2026-08-26 05:20Z — The controlling session decomposes and instructs; the
mechanical work goes to subagents rather than being executed in the head's own
context.

### Write the decisions to MD files so they survive a compact

> alright, now that you're doing this, I need you to literally save all of this fucking information to MD files so we do not have to do this again, you son of a bitch. Motherfucker. Shit fuck cock sucker. God damn it.

2026-08-26 05:19Z — Every decision reached in conversation is persisted to disk
at the time it is made, not held in context.

### Produce tickets or a map before the next compact

> how much of the past conversation do I have to go pull back in for you so that you know what the fuck we already decided? Because if you fucking spend an entire session regurgitating and figuring it out to the point where you compact again without creating the goddamn issue tickets or map or whatever we decide to do, it's gonna drive me fucking bonkers.

2026-08-26 05:20Z — A session that ends without durable artifacts (issues, a map)
is a failed session regardless of what was discussed in it.

### Open Brain is the memory — use it

> so you're saying that there's nothing in Open Brain that tells you this? God damn it, that's the whole point of Open Brain We are literally working in Open Brain Ugger!

2026-08-26 05:21Z — Decisions belong in Open Brain and are expected to be
retrievable from it; not finding them there is a defect in how they were saved.

### Programmatic beats agentic

> yeah. Things that are programmatically done are almost always better than things that are agentically done. That should be a fucking law.

2026-08-26 05:37Z — Where a deterministic script can do the job, it is preferred
over dispatching an agent.

### Pony mode and KISS apply to this program

> also, pony and kiss it.

2026-08-26 04:45Z — Smallest correct change at the owning boundary; no
over-engineering the rewrite.

### Graph Mode is the protocol for this work

> graph, not fuck'n grass

2026-08-26 04:45Z — Correcting the transcription of "grass mode"; the requested
protocol is Graph Mode (declared tier, lanes, executable done-means).

### Slow down after a compact

> alright, we you just compacted so after a compact you have a tendency to do stupid shit so slow your roll

2026-08-26 05:17Z — Post-compact turns re-establish state before acting rather
than resuming at speed on reconstructed assumptions.

### Do not burn context diagnosing tooling problems — report them out

> tell me what's wrong so I can go have something else fix it. I can't have you wasting your contacts doing it

2026-08-26 05:25Z — Environment and harness defects are reported to Rico for a
separate session to fix, not debugged in the working session's context.

---

## Corrections issued to the agent

These are the expensive ones — each cost real session time.

### Claimed external-embedder support was stranded when `main` already had it

The agent asserted twice that external-embedder support was "stranded on the
deploy branch" and that `OPEN_BRAIN_EMBEDDING_HOST_ALLOW` "doesn't exist in
code". Both were wrong: the escape hatch is on `main` at
`src/local-clone-mode.ts:165-179`. Root cause: searching a clone while on the
wrong branch and treating a working tree as a branch. `UNVERIFIED` — no operator
quote for this correction survives in the transcript; the record of it is the
agent's own pre-compact error log and `_DOCS/HANDOFF-RULES.md` rule 19, which
was added in response (`use git show origin/main:<path>` and a content diff,
never `git cherry`).

### Claimed no k3s Postgres existed when one was running

> didn't I just give you a fucking SQL server on the fucking K3S cluster to use

2026-08-26 04:43Z — A cluster had been stood up and verified live twenty minutes
earlier. The agent's default kube context was the dead `docker-desktop` one and
it concluded from that absence. Became `_DOCS/HANDOFF-RULES.md` rule 21
(`10.71.20.167:5432`, `~/.kube/config-rtech-k3s`).

### Re-litigating already-settled decisions

> we already talked about this. There already should be issues and fucking known statements about all of that

2026-08-26 03:57Z — The rewrite was already plan of record (#463). Reopening a
settled decision instead of reading the existing artifact.

Reinforced after the compact:

> we already did all this, you're totally just wasting context because you didn't save the information, you son of a bitch

2026-08-26 05:19Z.

### Raised a storage concern that did not matter

> also We're not even close. You're talking about five gigs versus forty gigs. I think we're fine

2026-08-26 04:46Z — The agent surfaced a 4.8GB-vs-40GB headroom question as a
risk. It was never close to binding and should not have been raised.

### Went to `/Users/rico/.claudex/` while not being a Claudex agent

> why, why, why, why, why, why, why are you going anywhere near? /Users/rico/.claudex/....

> are you in Clodex? Are you a Clodex agent? You are not

> whatever told you to fucking do that we need to fix it immediately. God damn it. Another goddamn sidetrack. God damn it

2026-08-26 05:23Z–05:24Z — The mixed-model routing instructions were being
applied by a session that is not a Claudex head, producing a sidetrack into a
runtime path that does not belong to it.

### Misread "graph mode" as "grass mode" twice

> graph, not fuck'n grass

2026-08-26 04:45Z.
