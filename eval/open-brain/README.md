# Open Brain Memory Evals

This is the first Open Brain-native memory quality harness for the Codex durable
memory goal. It borrows the benchmark shape from BrainBench/gbrain-evals:
synthetic public corpus, sealed expected answers, deterministic runner,
scorecard output, and reproducible local commands.

The smoke suite is intentionally offline. It does not call PostgreSQL,
external model providers, or private memory. It validates the harness contract and gives later
issues a place to add live adapters and Codex workflow scenarios.

## Run

```bash
bun run eval:memory
bun run eval:memory -- --fixture eval/open-brain/fixtures/codex-workflows.json
bun run eval:memory -- --fixture eval/open-brain/fixtures/memory-substrate.json
bun run eval:memory -- --json
bun run eval:memory -- --report eval/open-brain/reports/latest.json
```

Reports are only written when `--report` is supplied. Use a visible repo path
when the report is intended to be durable; otherwise write scratch reports under
`/Volumes/ThunderBolt/_tmp`.

## Fixture Layout

- `fixtures/memory-smoke.json`: synthetic corpus plus sealed probe expectations.
- `fixtures/codex-workflows.json`: Codex session-resume, decision reuse,
  validation-evidence, preference, stale-memory, citation, synthesis-tool
  selection, simulated-current-evidence, and unreadable-namespace scenarios.
- `fixtures/memory-substrate.json`: local memory substrate coverage for
  compaction recovery, private lane isolation, complete receipts, and linked
  recall across names, repos, dates/times, channels, files, and graph entities.
- `runner.ts`: deterministic retrieval, scoring, uncertainty, and scorecard code.
- `__tests__/runner.test.ts`: tests for sealed answers, namespace isolation,
  stale/contradiction uncertainty, Codex workflow scenarios, and aggregate
  scorecards.

## Current Categories

- Recall: relevant memory appears in top K.
- Precision: top K is not mostly junk.
- Temporal correctness: stale facts are surfaced.
- Identity resolution: similar people are distinguished.
- Citation grounding: expected source refs are cited.
- Contradiction handling: conflicting memories are surfaced as uncertainty.
- Namespace isolation: unreadable namespace entries are not returned.
- Codex workflows: coding-agent memory tasks resolve the right durable evidence.
- Memory substrate: local fixtures prove compaction, privacy, receipts, and
  linked recall without calling hosted Open Brain.
- Scale/performance: smoke latency is tracked against an expanded-corpus target.

## Live Recall Gate (EVAL-1/2/3, issues #322-#324)

The live gate is a single end-to-end command that seeds a unique throwaway
namespace with a sealed synthetic corpus, runs recall queries through the real
Open Brain MCP client, scores deterministic ranking metrics, applies versioned
thresholds, proves namespace isolation with an explicit negative control, and
tears down exactly this run's records. It is the live counterpart to the offline
smoke suite and exercises the real contract, auth, and namespace boundary.

```bash
bun run eval:live
bun run eval:live -- --json
bun run eval:live -- --report /Volumes/ThunderBolt/_tmp/open-brain/live-recall.json
```

### Opt-in and required environment

The gate is OFF by default so `bun test` and the offline eval never touch a
hosted service. It runs only when explicitly opted in. Set these variable
**names** in the environment (never paste token or URL values into the repo,
logs, issues, or a report):

Required:

- `OPEN_BRAIN_LIVE_EVAL` — must equal `1` to enable the gate.
- `OPEN_BRAIN_LIVE_EVAL_BASE_URL` — base URL of the target Open Brain server.
- `OPEN_BRAIN_LIVE_EVAL_TOKEN` — bearer token with archive permission and
  `X-Namespace` delegation authority (admin / ob-admin).

Optional:

- `OPEN_BRAIN_LIVE_EVAL_NEGATIVE_TOKEN` — a distinct token to also exercise
  cross-token denial. Leave unset to use the same token; when set it must differ
  from `OPEN_BRAIN_LIVE_EVAL_TOKEN`.
- `OPEN_BRAIN_LIVE_EVAL_SEARCH_MODE` — one of `hybrid` (default), `vector`,
  `keyword`.
- `OPEN_BRAIN_LIVE_EVAL_TIMEOUT_MS` — positive integer per-request timeout.
- `OPEN_BRAIN_LIVE_EVAL_RUN_ID` — an optional operator **label** for the run
  (a human-readable prefix that shows up in the run's namespace for triage). It
  is **not** a reusable namespace id: a per-invocation crypto nonce is always
  appended, so setting the same label twice still produces two distinct
  namespaces. Reusing a namespace would let a later run's seed upsert onto a
  prior run's stranded row, so an explicit id can never yield a reproducible
  namespace. When unset, the short commit is used as the label (still with the
  appended nonce); when the label is long, the namespace is bounded with a
  deterministic hash suffix that preserves uniqueness.

### Same-token isolation semantics

Isolation is a **real negative control**, not token inequality. Each caller
binds its own `X-Namespace` header on every request (including the session
`initialize`), so the token-sourced global role becomes header-bound to this
run's exact namespace. The negative caller binds a distinct sibling namespace,
so the **same** bearer token is a valid negative control — the header binding is
what isolates, not a different credential. The gate proves isolation by having
the primary caller attempt to read the negative namespace and requiring the
server to **deny** it: an empty-but-successful read is not proof of denial and
fails the gate. Supplying a distinct negative token additionally exercises
cross-token denial but is never required.

### Synthetic writes and cleanup

Every seeded record comes from `fixtures/live-recall-v1.json`, which is sealed
synthetic content invented for evaluation only — no real memory, secret, or
token is ever written. The gate seeds under a per-run unique namespace pair and
always tears down exactly the records it created, per record, through the
namespace-scoped `archive_entry` tool (never a bulk or query-shaped delete), so
it can only touch records it wrote. Teardown runs even when seeding or a query
fails partway. A teardown that strands a record fails the gate — a cleanup
failure can never silently become a PASS.

Every server response the gate depends on is bound to this run's exact identity
and fails closed content-free (a redacted `tool:reason` label, never a body) on
anything else:

- **Seed (create) proof.** `log_thought` / `log_decision` must return
  `merged: false` (a fresh row, not an upsert onto a pre-existing one) and a
  namespace **exactly** equal to the one this run bound. A `merged: true`
  upsert, a missing/non-boolean `merged`, a mismatched/absent namespace, or a
  missing id fail the run. This stops a stranded prior seed in a reused
  namespace from being adopted as a current-run creation and later archived as
  though this run owned it.
- **Retrieval-hit proof.** Validation is two-layered and neither layer ever
  silently discards a raw result — dropping one would compress ranks and hide a
  real leak while still reporting PASS. At the **transport boundary**
  (`parseHits`), a successful search body must be a JSON array and every entry
  must be an object with a non-empty string id; a non-array/invalid body
  (`malformed-results`) or a non-object/idless entry (`malformed-hit`) fails the
  run before scoring. Namespace stays optional here so the **gate** can then
  enforce that every surviving hit carries the exact primary namespace **and** an
  id this run created; a hit with a foreign/missing namespace
  (`foreign-namespace`) or an unaccountable id (`unknown-hit`) fails the run. The
  isolation probe (`attemptRead`) shares the same `parseHits` boundary, so a
  malformed negative-namespace body cannot be misread as an empty allowed read.
- **Archive proof.** A destructive archive success counts only when the server
  returns `archived: true` **and** the returned `id`/`table` exactly match the
  requested record. `archived: true` for a different or absent id/table fails
  closed, so teardown cannot credit a row it did not actually tombstone.

### Thresholds, baseline receipt, and reports (#323)

Pass thresholds are versioned in `thresholds.json` (recall@k, precision@k, MRR,
max namespace leaks), never in test assertions; edit them there. The run emits a
content-free structured baseline receipt (`schema: openbrain.live_recall_gate.v1`)
carrying only fixture/thresholds ids, namespaces, seeded counts, metrics,
per-probe scores, the negative-control proof, teardown tally, and the pass/fail
verdict. No memory bodies or source content appear.

Rather than committing a baseline artifact (which would pin a host- and
provider-specific score into the repo and go stale), the baseline receipt is
captured on demand via `--report <path>` (or `--json` to stdout). The controller
owns the live run; the precise command to record a fresh baseline is:

```bash
OPEN_BRAIN_LIVE_EVAL=1 \
OPEN_BRAIN_LIVE_EVAL_BASE_URL=<server-url> \
OPEN_BRAIN_LIVE_EVAL_TOKEN=<admin-or-ob-admin-token> \
bun run eval:live -- --report /Volumes/ThunderBolt/_tmp/open-brain/live-recall-baseline.json
```

Write reports to a scratch path under `/Volumes/ThunderBolt/_tmp` unless a
durable, intentionally-pinned baseline path is chosen.

### Exit statuses

- `0` — all thresholds met, negative control denied, teardown clean (PASS).
- `1` — the gate ran but failed a threshold, the isolation proof, or teardown.
- `2` — a setup/transport error (missing env, unreachable server, seeding or
  query failure). Error output is content-free: an error class + redacted label
  only, never a raw remote message or response body. When a deferred seed/query
  failure also stranded records during teardown, the redacted error label
  carries a `;teardown-failed=<n>` suffix (the integer count only — never a
  record id or body) so the cleanup failure is not lost behind the setup error.

### Residual risk: a commit that succeeds but times out on the response

The gate treats a seed/archive whose *response* is not received (a request
timeout, a dropped connection after the server committed, or an ambiguous
success body) as a failure — this is the correct default, because a destructive
teardown must fail closed rather than assume a row is gone. `archive_entry`
recognizes only two positive shapes: an explicit archived success **bound to the
requested `id`/`table`**, or the exact already-absent / not-found marker. Every
other success response — an unrecognized body, or an `archived: true` for a
different/absent id or table — throws a content-free `LiveTransportError`, so
teardown can never false-pass on a row it did not actually tombstone.

The residual is the write direction: if a `log_*` seed **commits server-side but
the response is lost**, the gate never learns the server id, so teardown cannot
archive that specific record. It is not silently counted as clean — the run
fails (exit `2`, or a `teardown-failed` count if the loss happens during
teardown) — but the committed row is left live under this run's unique
throwaway namespace. The gate deliberately does **not** add a bulk or
query-shaped delete to sweep it up: a query-shaped delete would be able to touch
records the run did not create, which is exactly the mutation-safety property
the per-record `archive_entry` teardown exists to guarantee. Broad cleanup is
rejected by design.

Because every run seeds under a **unique per-run namespace pair**
(`eval-live-recall-<run-id>` and its `-negative` sibling), a stranded record is
isolated to that one dead namespace and can never contaminate another run's
scoring or a real memory namespace. Recovering a stranded record is therefore a
bounded, operator-driven cleanup, not a gate responsibility:

1. Identify the affected run id from the failed run's redacted receipt/output
   (`namespace=eval-live-recall-<run-id>`). No id or body is needed.
2. As an operator (not the gate), archive or delete exactly the records under
   that unique namespace pair through the normal namespace-scoped admin tools.
   Because the namespace is unique to the dead run, scoping cleanup to it cannot
   touch any other run's or any real namespace's data.
3. Never widen this into an automatic sweep inside the gate — the per-record,
   namespace-scoped teardown is the only mutation the gate is allowed to make.

## Complete Context Pack Gate (EVAL-3, issue #330)

A companion live gate under `eval/open-brain/live/complete-pack-*.ts` seeds a
per-run throwaway namespace, calls the real `agent_context_pack` tool requesting
all nine sections under one whole-pack budget, and verifies six functional
properties (presence-or-defined-empty, exact-scope isolation, citation
bijection, serialized whole-pack budget, per-section contribution, and an
explicit cross-namespace denial control), then tears down exactly this run's
records. It reuses the recall gate's config/transport/setup discipline and is
run directly:

```bash
bun run eval/open-brain/live/complete-pack-cli.ts
bun run eval/open-brain/live/complete-pack-cli.ts --json
bun run eval/open-brain/live/complete-pack-cli.ts --report /Volumes/ThunderBolt/_tmp/open-brain/complete-pack.json
```

## Reflex A/B Suppression Gate (REFLEX-4, issue #335)

This gate exercises the already-landed complete reflex (`agent_reflex_pointers`,
#334 — detect/query, durable recall, prior-context suppression, cited body-free
pointers) end to end and proves the A/B suppression contrast: suppression ON
returns **demonstrably fewer already-known items** than suppression OFF over the
**same seeded evidence**, with zero redundant resurfacing and the net-new
evidence preserved.

```bash
bun run eval:reflex-ab
bun run eval:reflex-ab -- --json
bun run eval:reflex-ab -- --report /Volumes/ThunderBolt/_tmp/open-brain/reflex-ab.json
bun run eval:reflex-ab -- --budget-tokens 8000
```

One run:

1. Seeds a per-run throwaway namespace (plus a mandatory sibling negative
   namespace) with the sealed synthetic corpus in
   `fixtures/reflex-ab-v1.json`. Primary seeds are either `prior_known`
   (already-supplied-this-turn) or net-new; negative seeds must never surface.
2. Calls `agent_reflex_pointers` **three times** over the same evidence and
   exact scope:
   - **OFF arm** — no `prior_context`. Every net-new authorized durable record
     surfaces as a body-free cited pointer, including the already-known seeds
     (the redundant-resurfacing baseline).
   - **CONTROL arm** — a second unsuppressed call (still no `prior_context`)
     over the same seed/query. It proves the known items resurface **stably**
     across two unsuppressed calls; without it, a variable ranked recall that
     dropped the known items on its own could be misattributed to suppression on
     the ON arm. The OFF and CONTROL arms must resurface the **exact same
     non-vacuous** already-known set.
   - **ON arm** — the already-known seeds' **own emitted pointer references**
     (the exact `citation_id` + structural `source_ref` the OFF arm returned for
     them, i.e. the identities a real agent would echo back) are sent as
     `prior_context`, so the shared recall suppresses them before any pointer is
     emitted. The receipt records a content-free `references_sent` count, and the
     references must be **non-empty** and **exactly cover** the OFF arm's emitted
     already-known set — so suppression is proven to act on precisely the items
     that were resurfaced.
3. Compares the arms and records content-free relevance and
   redundant-resurfacing metrics. PASS requires the two unsuppressed arms
   (OFF/CONTROL) to resurface the same non-vacuous known set, a non-empty
   prior_context that exactly covers it, and suppression ON to then return zero
   redundant resurfacing while preserving the net-new evidence on **all** arms.
4. Requires each arm to independently clear the established EVAL-3 functional
   bar: every pointer cited (citation bijection with **strict per-identity
   multiplicity** — the emitted count must equal the cited count for every
   identity, so a duplicated or missing citation fails), body-free
   (identity/`source_ref` only — any body-bearing field fails), whole-pack
   budget respected with a complete nine-section allocation order, exact-scope
   authorized under the throwaway namespace, placement `client_owned` (no MCP
   `_meta` injection), and no negative-namespace leak.
5. Proves cross-namespace isolation with an explicit negative control (the
   primary caller's read of the negative namespace must be **denied**; an
   allowed-but-empty read is not proof), then tears down exactly this run's
   records via per-record namespace-scoped `archive_entry`.

Prompt placement is client-owned by contract: the gate only asserts the reflex
returns resolvable pointers and `placement: "client_owned"`; it never injects
anything into an MCP `_meta` channel. Opt-in and required environment are
identical to the live recall gate above (`OPEN_BRAIN_LIVE_EVAL=1` plus base
URL + token). The receipt (`schema: openbrain.reflex_ab_gate.v1`) is
content-free: only ids, namespaces, labels, counts, and booleans — no memory
bodies, tokens, or secrets.

## Next Expansion Points

- Add a live Open Brain adapter that loads fixtures into an isolated namespace
  and calls `search_brain` / `brain_answer` through the current contract/direct
  HTTP client. The current offline fixture checks that Codex retrieves the right
  synthesis-tool policy and can render cited answer evidence; it does not
  execute `brain_answer` or read the live repo.
- Publish durable scorecards only when the corpus and command are intentionally
  pinned for comparison.
