# Prior art

Reviews of other memory and agent-context systems, recorded properly so they
survive the session that produced them.

## Why this directory exists

Open Brain has repeatedly borrowed a good idea, implemented it in a different
shape, and lost the property that made the idea work. The failure is not
"we picked the wrong idea" — it is **"we kept the idea and dropped the
mechanism."**

One measured example, 2026-07-27. Cognee's `PreCompact` hook **reads**: it emits
a summary that the compactor preserves, so context survives the reset. Open
Brain's `PreCompact` **writes**: it stores a durable checkpoint, so the session
survives. Both are legitimate; they are opposite directions. We adopted the
surface and got half the benefit, and nothing recorded the divergence, so
nothing flagged it.

A second: cognee's idle detection is a **detached daemon** launched at session
start — it cannot fail to run because no agent has to remember it. Our REM idle
trigger (#391) is specified as *policy*: thresholds and ceilings an agent
applies. Same idea, different shape, and the shape is the part that made it
reliable.

This directory exists so the next borrow records the mechanism, not just the
conclusion.

## What a review must contain

A review is not a summary of what the project does. It answers one question:

> **We borrowed X. Does our shape preserve the property that made X work?**

Required sections:

1. **Provenance** — upstream URL, license (read from their `LICENSE`, not
   assumed), clone commit, review date. State whether code reuse is permitted.
2. **Read from source** — file paths and line ranges for every claim. A claim
   sourced from a README or a blog post is marked as such and treated as weaker
   evidence. Marketing is not evidence.
3. **What they do** — the mechanism, concretely.
4. **What is good** — with the reason it works, not just that it exists.
5. **What is bad or does not fit** — including things that are right for them
   and wrong for us, and *why* the context differs.
6. **Ideas we are borrowing** — named explicitly.
7. **Shape comparison** — for each borrowed idea, a side-by-side of their
   implementation and ours, and an explicit verdict: does our shape preserve
   the load-bearing property, or not? **This is the section the directory is
   for.** A review without it has not done the job.
8. **Attribution** — what goes in `ATTRIBUTION.md`. Three kinds count: an idea
   we adopted, a decision not to adopt, and **a project that showed us what not
   to do**. The third is real credit — a system that was actually run and found
   wanting teaches more than one that was only read, and it is often what
   defined the requirement in the first place. Say so when a finding came from
   *using* something rather than reading it; that evidence is stronger and
   rarer.

## Rules

- **Source, not marketing.** Every substantive claim cites a file and line.
- **Verify before recording.** The failure this directory addresses is
  conclusions recorded without being checked. A claim that was not tested is
  labelled UNVERIFIED rather than stated flatly.
- **Record the divergence, not just the borrow.** "We did it differently" is
  the finding. Say how, and say whether it still works.
- **Cautionary findings count.** Deciding not to borrow is a result worth
  keeping so nobody re-evaluates it from scratch.
- **Credit everything.** Idea or code, it goes in `ATTRIBUTION.md`. Be good
  FOSS citizens. We take ideas, not code — an idea still gets credited.

## Clones

`/Volumes/ThunderBolt/open-brain-local/research/` — outside this repo, so 400MB
of vendor source never enters our git history. Read-only reference material.

## Status

| Project | Review | State |
|---|---|---|
| graphiti | `graphiti.md` | **done** — borrow verified correct, half-dormant |
| cognee | `cognee.md` | **done** — one confirmed shape mismatch (PreCompact direction) |
| gbrain | `gbrain.md` | not started — never examined; 0 references in the corpus |
| honcho | `honcho.md` | not started — 174 corpus references, AGPL, read-only |
| mem0 | `mem0.md` | not started — prior finding was cautionary, needs re-verification |
