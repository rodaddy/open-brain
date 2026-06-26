# Open Brain Agent Memory Substrate Plan

## Objective

Make Open Brain the first-class memory substrate for local Codex, Hermes agents,
thin clients, and future Closed Brain workflows. Agents should not need to
manually step back into ad hoc MCP calls for normal lifecycle memory. The client
adapter should handle start, recall, compact, wrap, receipt capture, and shared
knowledge nomination as part of the agent runtime.

Target completion for the first usable slice: Sunday, 2026-06-28.

## Non-Goals

- Do not turn Open Brain into OKF. OKF is an export/import disclosure profile.
- Do not store raw transcripts, secrets, or unbounded command output.
- Do not auto-promote lane-local facts into `shared-kb`.
- Do not make Closed Brain depend on lightweight OB receipts for privileged
  audit requirements. Closed Brain can consume the pattern, but it needs a
  stricter receipt ledger.

## Architecture

Open Brain remains authoritative for storage, namespace isolation, graph links,
search, session lanes, session events, repo facts, promotion, and public
contract discovery.

Clients become lifecycle-aware memory managers:

- `session_start`: establish the lane and hydrate recent context.
- `recall`: search lane, shared knowledge, repo facts, and optional qmd.
- `append_event`: write distilled facts, decisions, actions, blockers, receipts,
  artifacts, and handoffs.
- `compact`: locally distill current work before context loss and write a wrap.
- `wrap`: checkpoint the lane with summary, decisions, next steps, and receipts.
- `record_receipt`: capture files read/touched, artifact hashes, commands,
  validation checks, channel/session identity, and source references.
- `nominate_shared`: mark only useful, non-private events for server-side
  promotion review.
- `export_disclosure_bundle`: generate OKF-like `index.md`, `log.md`, concept
  files, citations, and receipt appendices without changing OB storage.

## Memory Lanes

A lane is the active memory object. It must carry enough metadata for local
agents, Hermes, and future Closed Brain to explain what happened later:

- stable `session_key`
- project, agent, source, channel, thread, and color/visual metadata
- current context markdown
- scoped event journal
- linked graph entities
- repo facts used or produced
- artifacts and receipts
- share-candidate nominations
- optional `metadata.okf` export metadata

## Receipts

Open Brain should support lightweight receipts now and leave hooks for Closed
Brain's stricter model. Receipt records should represent:

- source files read, with path, URI, repo, commit, and hash where available
- files written or touched, with before/after hash where available
- generated artifacts, with path, hash, producer, and validation status
- base documents/templates, including known-good PDFs and structure sources
- commands/tool calls that materially produced output
- external channels such as Discord, Hermes, n8n, or user prompts
- timestamps, agent identity, session key, namespace, and source references

## Promotion

Clients may set `metadata.share_candidate = true`, but server-side policy owns
promotion into `shared-kb`. The server must continue to reject secrets/private
content synchronously and run async worthiness, deduplication, and provenance
checks before promotion.

## OKF Disclosure Profile

The public contract exposes `interchange_profiles.okf` and `metadata.okf` as
compatibility hooks. Exporters should map:

- lane/project/repo grouping to `index.md`
- scoped session events and wraps to `log.md`
- distilled concepts to regular Markdown files with YAML frontmatter
- `source_ref`, `artifact_path`, repo fact source URLs, and receipts to
  `# Citations`

Imports should stage candidate OB records. They must not bypass namespace,
receipt, promotion, or secret handling rules.

## Friday-Sunday Timeline

### Friday, 2026-06-26

- Land the architecture plan and issue set.
- Keep the contract hooks for OKF compatibility discoverable.
- Define the adapter and receipt schemas.
- Start Codex lifecycle integration design.

### Saturday, 2026-06-27

- Implement the TypeScript thin client/lifecycle adapter.
- Add receipt helper APIs and fake-transport tests.
- Add Codex local session start, compact, and wrap integration.
- Add Hermes adapter contract and call-shape fixtures.

### Sunday, 2026-06-28

- Add promotion/disclosure export paths.
- Add evals for compaction, privacy, receipts, and recall.
- Run local and hosted Open Brain validation.
- Complete mcp2cli/Hermes downstream rollout classification and canaries.

## Issue Plan

| Order | Issue | Target Date | Component | Surface | Phase |
| --- | --- | --- | --- | --- | --- |
| 1 | Define agent memory adapter contract | 2026-06-26 | Memory Protocol | All Surfaces | P0 Planning |
| 2 | Define receipt schema and provenance model | 2026-06-26 | Memory Protocol | Server/API | P1 Server Canonicalization |
| 3 | Add TypeScript thin client memory wrapper | 2026-06-27 | Client Runtime | MCP/mcp2cli | P2 Client Runtime |
| 4 | Wire Codex local lifecycle memory adapter | 2026-06-27 | Client Runtime | Codex Skill | P2 Client Runtime |
| 5 | Wire Hermes lifecycle memory adapter contract | 2026-06-27 | Client Runtime | Hermes/Runtime | P2 Client Runtime |
| 6 | Add receipt capture helpers and tests | 2026-06-27 | Server Canonicalization | Server/API | P1 Server Canonicalization |
| 7 | Harden share-candidate promotion provenance | 2026-06-28 | Legacy Promoter | Server/API | P4 Legacy Promoter |
| 8 | Add OKF disclosure export bundle | 2026-06-28 | Synthesis | Docs/Process | P5 Review/Validation |
| 9 | Add memory substrate eval harness | 2026-06-28 | Eval Harness | Eval Harness | P5 Review/Validation |
| 10 | Run downstream rollout and hosted canaries | 2026-06-28 | Deploy/Canary | Deploy/Canary | P6 Deploy/Canary Follow-On |

## Definition Of Done

- Agents can start, recall, compact, wrap, and receipt-log through a first-class
  adapter without manually composing raw MCP calls for normal lifecycle memory.
- Private lane data stays out of `shared-kb` unless deliberately nominated and
  server-approved.
- Receipts can explain which files, channels, artifacts, and validations shaped
  a material output.
- OKF export can disclose the bundle progressively without becoming the storage
  model.
- Local tests, Python adapter tests, contract tests, and targeted evals pass.
- Hosted Open Brain, mcp2cli, generated skill, and Hermes canary impacts are
  either completed or explicitly classified not applicable.
