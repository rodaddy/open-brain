# How Open Brain was built

This is the build history of Open Brain, taken from its git log (668
commits, 2026-03-13 to 2026-10-13), the design docs and contracts in
`docs/`, the eval harnesses in `eval/`, the test suite, and the project's
issue tracker and pull requests. This public repository is a one-commit
snapshot of that history.

## The problem

AI coding agents forget everything between sessions. Each new session
re-learns the same decisions, repeats the same mistakes and asks the same
questions. The author ran several agents (Claude Code, Codex and others)
across machines and wanted one memory they could all write to and read from:
decisions, facts, corrections and session events, searchable by meaning,
with clear rules on who may read or promote what.

## Timeline

| Date | Phase | What changed |
|---|---|---|
| 2026-03-13 | v1 in one day | Written as planned phases, each researched, planned, built test-first and verified: a PostgreSQL and pgvector schema with a migration runner, auth and permissions, an embedding service that degrades gracefully, an MCP server over HTTP, the `log_thought`, `log_decision` and `search_brain` tools, request logging, and registration as an MCP tool for agents. |
| 2026-03-17 | v1.2 | Automatic metadata extraction, federated search across the memory and a document index merged with reciprocal rank fusion, and a bulk importer. 227 tests. |
| April 2026 | Tiering and speed | Cognitive tiering of entries, an Obsidian vault sync, and an HNSW vector index. |
| 2026-05-19 | v2 | Eight new MCP tools (stats, access reports, duplicate finding, curation, bulk tiering and archiving, namespaces, tier recommendations), namespace filters and per-agent attribution. |
| June 2026 | Sessions and local-first | A session event journal and context tools, embedding retries with structured failures, a dry-run "dream" consolidation engine, an entity graph, promotion with review receipts, and provider-agnostic embeddings so a local model can serve them. |
| July 2026 | Transport and contracts | A NATS JetStream foundation and Python request-reply transport, privacy-safe MCP audit logging, automated replay of a client-side capture spool, a whole-pack budget for `agent_context_pack`, approved drop-folder collection, and a uv workspace for the Python provider. |
| August 2026 | Rewrite and hardening | Capture hooks ported to Python together with the DREAM stages (2026-08-01). Capture failures made loud in `/health`, model and token usage carried to Langfuse for cost tracking, an isolated-database test run made the default, eval harness fixes, and a lint and logging sweep across server tools. |
| 2026-10-13 | Public snapshot | A scrubbed snapshot synced to this repository. |

Work continued in the source repository after the snapshot: NATS worker
authentication with nkeys, Langfuse recall and capture scores, and split
unit and database CI lanes (October 2026).

## Key design decisions

- **Postgres for everything.** Entries, embeddings (pgvector), full-text
  search, the entity graph and the session journal live in one database, so
  backups, transactions and restore drills cover all of it.
- **Capture is broad, promotion is deliberate.** Agents write freely into
  their own lane; moving an entry into shared, durable memory goes through a
  promoter with review receipts.
- **Contracts before features.** Memory, context-pack, adapter and identity
  contracts are written down in `docs/` and checked by tests, so several
  different agent runtimes can use one server.
- **Fail loud, never drop silently.** After captures were lost without
  notice, a quarantined or failed capture became visible per lane in
  `/health`, and the client says so in the turn.
- **Local-first embeddings.** Making the embedding endpoint
  provider-agnostic let a local model serve it; the backfill was measured at
  95 rows per second with a worker pool against 4.3 sequentially.
- **Ideas from prior systems, recorded.** v1.2's extraction and federated
  search were inspired by Nate B. Jones's OB1 memory project; later designs
  borrow from Graphiti, Cognee, mem0 and others, each recorded in
  `docs/prior-art/ATTRIBUTION.md`.

## How AI was used to build and check it

Open Brain was built by AI coding agents directed by one operator; the
history carries about 900 co-author trailers across Claude Opus, Fable and
Sonnet versions, and later work was also done by Codex. Every phase of v1
was reviewed by an agent "review swarm" before it closed: phase 1's swarm
returned 16 findings (an unhandled async error that could crash the
process, missing session limits, no body size limit, CORS left open,
missing fail-fast checks), all fixed in one commit. Later work ran as
numbered lanes with done-means scripts: each acceptance claim is a script
with a fixed exit code that has to pass before the issue closes.

## Testing and evaluation

- 227 tests at v1.2. At this snapshot there are about 2,100 TypeScript test
  cases across roughly 230 test files, plus the Python client's tests.
- `npm run test:isolated` creates a uniquely named database, migrates it,
  runs the suite and drops it, including on interrupt. It became the default
  after three runs of unchanged code against the shared development
  database failed 37, 41 and 37 tests, while the isolated run passed 3,710
  of 3,710 twice.
- `eval/open-brain/` is an offline memory-quality harness with a synthetic
  corpus, sealed expected answers, a deterministic runner and a scorecard,
  modelled on the BrainBench and gbrain-evals shape. Fixtures cover agent
  workflows, the memory substrate, lifecycle, live recall and context packs.
- `eval/recall/` scores recall and curation, including rank fusion, against
  judged equivalents.

## What did not work

- **An untested claim.** On 2026-07-27 three merged changes were reverted
  together pending real verification. One had removed every reference to a
  retired database host on the claim that the host was gone. Checked, the
  host still answered and held a pre-cutover snapshot. The second attempt
  measured first, changed only this project's use of the host, and kept the
  accurate documentation.
- **Shared test databases.** Test counts against a shared database were not
  evidence; see the isolated run above.
- **The Python port dropped behaviour.** The August rewrite lost the bounds
  on session context events; a follow-up restored them. Ports now carry the
  old behaviour's tests forward.
- **Silent capture loss**, fixed as described above.

## Current state

Active and in daily use by one operator for a handful of agents. Some
documents under `docs/` describe designs that are not built yet; each says
so in its status line.
