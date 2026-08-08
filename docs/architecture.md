# The applications — what runs, what is being built, and who owns what

**Status:** WRITTEN 2026-07-31. Each claim below carries its own state
(RUNNING / MERGED / WRITTEN / PROPOSED); a claim inherits the weakest state in
its chain.

**Why this file exists:** on 2026-07-31 a session spent 7 commits building
capture components before discovering that the write path it needed had been
sitting, finished and tested, in the sibling package the whole time. No
document named the applications and their boundaries, so every session
re-derived them — and one derived them wrong. This is that document.

---

## The map

```
   Claude Code · Codex · Pi                      operator, rarely
        │ hook events                                  │
        ▼                                              ▼
 [A] live adapter            [B] lifecycle       [E] bulk ingester
 python/openbrain            provider            (not built; decided)
 apps/capture, apps/hooks    python/             whole giant session
 watermark → EOF, 5s hard    openbrain-provider  files, SQLite staging,
 deadline, ONE format        session start /     many formats, no
        │                    capture/checkpoint  deadline
        │                    /reflex │                 │
        └──────────────┬─────────────┴─────────────────┘
                       ▼
 [C] python/openbrain-memory — the ONLY Python write path
     AgentMemory · spool durability · typed contract
                       │  HTTP, bearer token
                       ▼
 [D] TypeScript server, src/ — ALL judgment lives here
     redaction · scaffolding drop · dedupe · embedding · lanes · contract
                       │
                       ▼
              PostgreSQL + pgvector
```

Two boundaries carry the whole design:

1. **[C] is the only door.** No Python application talks to Postgres or the
   HTTP API directly. A write path outside [C] is a defect on sight
   (`_plans/consolidation-2026-07-30.md:99`).
2. **[D] owns judgment.** Redaction of secret values
   (`src/tools/ingest-raw-turn.ts:137`), scaffolding drop (`:205`), dedupe
   (`UNIQUE(namespace, turn_uuid)`), embedding and lane resolution
   (`src/tools/append-session-event.ts`). Clients send content whole and
   untouched — client-side salience was measured to fail
   (`openbrain_memory/agent.py:619-625`: 21 user turns, zero assistant turns).

---

## [D] TypeScript server — `src/`

**State: RUNNING.** Checked 2026-07-31 against the local dogfood service:
`/health` healthy, database connected, embedding connected. Hosted copy runs
on deployment_host via launchd (`AGENTS.md`, "Stack") — the only two hosts this project
has.

The MCP server over PostgreSQL + pgvector: contract-first tools, hybrid
search, cognitive tiering, per-consumer auth. 142 non-test files, 50,452
lines (census 2026-07-30).

**It is not being replaced.** The v2 rewrite replaces the *adapters around
it*, not the server. The server's own debt is handled **in place** by
`_plans/consolidation-2026-07-30.md` (state: PROPOSED, nothing built): one
admission definition, one entry-write path, typed contracts mirroring the
Python `Protocol`s, logger established once.

**Never:** a content ceiling on a read or write path. The server already
removed its own (`src/tools/ingest-raw-turn.ts:30`);
`docs/CODING_STANDARDS.md:160` is the standing rule.

## [C] Python client — `python/openbrain-memory/`

**State: MERGED in-repo; consumed downstream** by mcp2cli, Hermes, and the
deployed adapter per `docs/memory-contract.md` and `docs/downstream-rollout.md`.

The typed client: `AgentMemory` (`agent.py:222`) owns session lifecycle,
idempotency keys, and the two write lanes —

| lane | call | what it is |
|---|---|---|
| raw | `ingest_raw_turns` (`agent.py:611`) | whole turns, untouched, content-bearing by design |
| distilled | `append_event` (`agent.py:542`) | classified events (`decision`, `fact`, …) |

Both carry **spool durability** (`spool.py`): a send that cannot reach the
server is spooled and replayed, so a returned call is a kept turn even with
the service down.

**Never:** judgment. It validates shape and delivers; it does not classify,
score, or decide worth. And it never mirrors a server rule — the 200 KB
mirror of a deleted server bound is defect #2 of the port
(`_plans/python-port-sequence.md`, "The three defects").

## [B] Lifecycle provider — `python/openbrain-provider/`

**State: WRITTEN, partial by design** (epic #409, issues #413–#417, #419 per
`_plans/418-prov-9-hook-entrypoints.md:104-107`). Landed: `config`,
`observability`, `vocabulary`. Not yet: request parsing, receipts, dispatch,
reflex, observation. What is exported works; what is absent is absent, not
stubbed (package README).

The Python replacement for the TypeScript `ob-memory-provider.ts`: the
adapter a runtime invokes at session start, capture, checkpoint, and reflex.
It decides what a runtime may send and what it gets back.

**Never:** success without persistence. The TS adapter it replaces silently
discarded a 101 KB capture with exit 0 and no receipt (proven live
2026-07-30, `_plans/consolidation-2026-07-30.md`). A receipt always states
durability.

## [A] Live adapter — `python/openbrain/`, `apps/`

**State: WRITTEN; the spine is live-proven.** Steps 0–7 of
`_plans/python-port-sequence.md` are committed. The spine
(`apps/capture/deliver.py`) round-tripped a real turn into the playground's
`ob_raw_turns` on 2026-07-31 — whole, ordered, replay-safe — through [C],
via the `-m live` gate. The hook entrypoints (step 8) are not built, so
nothing invokes it in production yet.

The application that sits inside Claude Code / Codex / Pi as a `Stop`-hook
(and later the other events, one module per event): read the transcript from
the per-session watermark to EOF, build `RawTurn`s, hand them to
[C] `ingest_raw_turns`, advance the watermark only after the client returns.
Hard 5-second deadline; ONE transcript format — whichever harness it is
attached to.

The package is also the shared Python foundation (`config`, `models`,
`utils`) its own apps build on. The wider capability list in its `__init__`
(storage, dream, recall, api, …) is **PROPOSED** — direction, not commitment.

**Never:** a second write path, a format factory, a whole-file read, a bulk
mode, any content bound. Governing docs: `_plans/python-port-sequence.md`
(execution contract, two-applications split),
`_plans/418-prov-9-hook-entrypoints.md` (acceptance),
`docs/decisions/capture-never-drops-a-turn.md`.

## [E] Bulk ingester — decided, not built

**State: PROPOSED with decisions on file.** A separate operator-run
application that ingests giant session files from anywhere (27 MB measured).
Decided (`_plans/python-port-sequence.md`, "TWO APPLICATIONS, NOT ONE"):

- reuses [A]'s pure functions (`records.py`, the `signal` modules) directly;
  the format factory keyed on input type belongs HERE, never in [A]
- may stage the whole file in SQLite and yield turns to its caller
  (operator, 2026-07-31 02:15)
- no deadline; may retry, quarantine, resume
- writes through [C], like everything else

Its location and name are decided when it is built, not before.

## Legacy: the deployed TypeScript adapter — outside this repo

**State: RUNNING, scheduled for deletion.**
`~/.local/share/openbrain-memory/adapters/versions/sha256-cd5fb4e4…/`,
pointed at by `~/.claude/settings.json`. Five hook modules plus
`ob-memory-provider.ts`. [A] and [B] replace it; **#420** cuts
`settings.json` over and deletes it. It is a reference for nothing — the
port builds from decisions, and a fact only this code holds becomes a stub
question in `_plans/rewrite-gotchas.md`.

---

## Cross-cutting rules, so no app relearns them

- **One vocabulary per concern, declared once.** The event-type enum diverged
  once between two hand-maintained copies (9 vs 8 values, #412); the uv
  workspace (`python/pyproject.toml`, `members = ["*"]`) plus
  `openbrain_provider.vocabulary` / `openbrain_memory` are the fix.
- **No content bounds anywhere**, client or server
  (`docs/CODING_STANDARDS.md:160`). Numbers in tests are input sizes.
- **Playground for proof.** Live-marked tests run against the
  `open_brain_local_play` clone (`docs/local-playground.md`); never merge
  playground data back.
- **The states in this file rot.** When a step lands, update the state word
  here in the same commit — a design doc that says WRITTEN about a thing now
  RUNNING is how "locked" ended up seven lines above SUPERSEDED.
