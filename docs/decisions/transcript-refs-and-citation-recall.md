# Transcript refs: host-neutral paths, and fail-closed citation

**What this is:** two rules behind
[`src/tools/citation-recall.ts`](../../src/tools/citation-recall.ts) and the
`transcript_ref` field on `append_session_event`. Both are one-line rules with
a tempting wrong answer, and both currently live only in a Zod validator and a
contract description.

**Source issue:** #288 — "Transcript-ref storage + citation recall contract
(cite source conversation, date, speaker — or say it isn't stored)"
**Decided / closed:** 2026-07-13 (PR #289, merge `98e5e3c`, migration
`023_session_event_transcript_citations.sql`)
**Status:** implemented and live. Hosted contract
`2026-07-13.memory-tools.v21`; `citation_recall` capability present;
`append_session_event` exposes `transcript_ref`, `transcript`, and
`occurred_at`.

Part of rodaddy/development#2 (Claude/Codex dev-session capture → OB).

---

## What the contract does

> - **Transcript(-ref) storage:** schema + ingest contract for storing session
>   transcripts (or durable refs to them) alongside memories/summaries. Refs
>   must be host-neutral (`collab/...` style, no `/Volumes/...` or `/mnt/...`
>   literals).
> - **Citation recall:** query/tool contract returning source conversation,
>   speaker/agent, date, and the surrounding exchange (context expansion into
>   the neighboring transcript) — or an explicit "source not stored" instead of
>   inventing one.

## Rule 1: refs must be host-neutral

A stored ref must be `collab/...` style. `/Volumes/...` and `/mnt/...` literals
are rejected.

The reason is that the *same share* mounts at *different paths* depending on
who is looking: the host sees `/Volumes/collab`, a runner sees `/mnt/collab`.
A ref that embeds either prefix is correct exactly once, on the machine that
wrote it, and silently unresolvable everywhere else. This is a known
repeat-offender class in this repo (see [`../LEARNINGS.md`](../LEARNINGS.md)) —
which is why it belongs in prose and not only in a validator.

Enforced in `src/contract-schemas.ts`:

> Host-neutral source conversation reference. Must use `collab/...` and must
> not contain `/Volumes/` or `/mnt/` host paths.

## Rule 2: fail closed on citation — say "not stored", never invent

> or an explicit "source not stored" instead of inventing one

A recall for a fact with no stored source must **say so**. The failure mode
being prevented is a plausible-looking fabricated citation, which is worse than
no citation: it is unfalsifiable at a glance and it poisons the audit trail the
whole capture pipeline exists to build.

Implemented as: legacy events explicitly report `source_not_stored`.

## Why the contract landed before the capture work

> OB currently returns the fact but can't answer "who decided this, when, in
> which conversation, and what was actually said." The dev-runtime capture work
> (development repo) will ship summaries + transcripts; this contract is what
> makes them citable. **The citation ladder falls out of capture — it is not a
> separate feature, so the contract lands first.**

That framing is the sequencing decision: citation is not a feature to be built
after capture, it is a property capture must be shaped to produce. Building
capture first and citation later would have produced transcripts that could not
be cited.

## Acceptance sketch (verbatim)

> - Ingest accepts summary + transcript-ref (and optionally inline transcript)
>   in one write.
> - A recall query for a stored decision returns: fact, source conversation
>   id/ref, date, speaker, expandable surrounding context.
> - A recall query for a fact with no stored source says so explicitly.

## Related

- [`../conversation-facts-contract.md`](../conversation-facts-contract.md) —
  distilled conversation facts (a different layer; that doc does not cover
  transcript refs).
- [`../memory-contract.md`](../memory-contract.md) — citation rules for Codex
  durable memory.
