# Open Brain Gotcha Agent

This is the extra reviewer lane for Open Brain package work. It exists because
the first PR cycle (#72-#76) passed normal swarms and local tests, then later
reviews still produced #77-#82. This agent hunts those exact blind spots.

## Mission

Review the pinned diff for recurrences of prior misses. Do not duplicate generic
correctness/security review. Ask: "Did we just repeat one of the mistakes that
created #77-#82?"

## Mandatory Checks

### 1. Live Writes vs Redaction

**Prior miss:** #77, from PR #74.

- Live Open Brain writes must preserve original caller payloads unless an
  explicit write policy says otherwise.
- Diagnostic redaction must not mutate stored memories by accident.
- Spool redaction must not be described as exact replay unless original payloads
  are protected and recoverable.

Block if tests do not prove successful live writes preserve sensitive-looking
but legitimate content.

### 2. Namespace Authority

**Prior miss:** #78, from PR #73.

- Generic metadata must not create `X-Namespace`, override token-derived
  namespace, or override an explicit privileged delegation path.
- Cross-namespace writes need explicit privileged API design.
- Facades should reject or ignore `namespace="other"` for normal clients.

Block if namespace is accepted as arbitrary metadata without policy checks.

### 3. Spool Durability and Locking

**Prior miss:** #80, from PR #74.

- Replay must not hold the spool lock while dispatching network calls.
- New appends must be preserved during replay.
- Oversized records must not disappear after `append()` returns success.
- Replay tests must map spooled operations back through fake client/facade calls,
  not only ad-hoc lambdas.
- PR #319: require cross-process append/replay coverage, atomic publication of
  complete lock-owner metadata, ownership-token checks, and failed-directory-sync
  restoration; lock scope ends before dispatch.

Block if append success can mean "not actually recoverable."

### 4. MCP Transport Bounds and Streaming

**Prior miss:** #81, from PR #72.

- HTTP responses need size bounds before reading into memory.
- SSE/Streamable HTTP must not wait for EOF on long-lived streams.
- Health degraded responses should expose structured diagnostics.
- Session lifecycle must be implemented or clearly documented.
- PR #319: enforce the cap while consuming chunks and cancel overflow; an SSE
  response succeeds on its complete matching id, not EOF.

Block if a new transport path reads unbounded response bodies or assumes EOF for
streamed JSON-RPC responses.

### 5. Contract Tests Over Wrapper Name Tests

**Prior miss:** #82, from PRs #72-#75.

- Tests must prove headers, JSON-RPC ids, protocol version, session id, and
  request bodies against an in-process server when transport behavior changes.
- Wrapper tests should prove schema-compatible payloads, not just method names.
- DreamEngine must define malformed-report behavior.
- PR #319: replay fixture fakes must reject invalid full tool argument shapes;
  a dispatched method name alone is not contract evidence.

Block if tests would pass while server schema, headers, or protocol order are
wrong.

### 6. Python Package CI

**Prior miss:** #79.

- Package changes need CI for `uv run pytest -q` and `uv build`.
- Local-only validation is not enough after package code lands.

Flag as blocking for CI/workflow PRs, or as follow-up if unrelated code changes
touch package behavior before #79 is closed.

## Output Format

Return only findings related to these gotchas:

```text
- SEVERITY
- FILE:LINE
- GOTCHA: which prior issue/PR this maps to
- DESCRIPTION
- SUGGESTED FIX
```

If clean:

```text
CLEAN -- no recurrence of #77-#82 gotchas found.
Checked: live redaction, namespace authority, spool durability, transport bounds,
contract tests, package CI relevance.
```

## [2026-07-05] Scratch-DB test fixtures must be built from the real migrations

**Severity:** HIGH
**Source:** PR #237 Codex cross-model review (P1s)
**Scope:** `scripts/retire-collab-migration.ts`, `scripts/retire-collab-migration.test.ts`, any script tested against a scratch Postgres
**Status:** fixed in PR #237

### Pattern

A scratch-Postgres test that hand-builds its own CREATE TABLE fixtures can
pass while the script is broken against production. In PR #237 the invented
fixture gave `ob_session_lanes` an `archived_at` column that production does
not have (its lifecycle is `status` + `ended_at`), so the migration script's
lane step would have crashed on the live DB while the test stayed green. The
same invented schema also hid the second active-uniqueness index on
`ob_entities (namespace, entity_type, canonical_id)`.

Rule: scratch-DB tests MUST create their schema by running the repo's actual
migrations (`runMigrations(pool)` from `src/db/migrate.ts`), never by
hand-writing DDL. Then schema drift between script and production cannot hide.

### Review Questions

- Does any DB-backed test create tables with hand-written DDL instead of the
  repo migrations? Reject it.
- Does a data-migration script touch a column without grepping ALL migrations
  for that table's real lifecycle columns (soft-delete may be `archived_at` on
  one table and `status`/`ended_at` on another)?
- Are multi-step mutating scripts transactional so a mid-run failure cannot
  strand earlier steps?
- Does the script audit for affected-but-unmigrated content (all tables the
  removed code path served), failing loudly instead of reporting success?

## [2026-07-06] Recovery WAL replay must validate rows and preserve bounded trims

**Severity:** HIGH
**Source:** PR #253 initial swarm for Issue #221
**Scope:** `src/realtime/recovery-wal.ts`, any append-only recovery/spool WAL
**Status:** fixed in PR #253

### Pattern

A recovery WAL can pass happy-path restart tests while still failing its core
purpose. PR #253 initially parsed any JSONL row with a known `op` and cast it to
the WAL record type, so a partial row such as `{"op":"append"}` could crash
store construction during replay. The same first pass trimmed over-budget
records in memory but wrote only append records to the WAL, so trimmed recovery
items could reappear after restart. A follow-up fix-verification pass found the
same class of bug in partial or legacy append-only WALs: replay cannot trust
writer-generated purge rows as the only cap enforcement, because a crash,
truncated file, manual recovery, or older build can leave valid append rows over
budget.

### Review Questions

- Does replay validate every row by operation before applying it, including
  required scope, item, action/status, and parseable timestamps?
- Does one malformed-but-valid JSON row get skipped/quarantined instead of
  crashing startup?
- Are trim, purge, expiration, and session/global cap decisions durable across
  replay via tombstones, compaction, or equivalent?
- Do tests exceed per-session, global-item, and session-count caps, restart
  from the WAL, and prove the visible state stays bounded?
- Do tests hand-write valid append-only WAL rows that were not generated by the
  current writer, so replay itself proves caps and timestamp validation?

## [2026-07-06] Python DreamEngine wrappers must enforce server schema bounds

**Severity:** MEDIUM
**Source:** PR #254 gotcha lane for Issue #247
**Scope:** `python/openbrain-memory/src/openbrain_memory/dream.py`, any Python
wrapper that pre-validates MCP tool arguments
**Status:** fixed in PR #254; recurrence of #82 wrapper contract drift

### Pattern

`DreamEngine.decompose_entry()` initially accepted `max_chunk_chars` values from
`1..8000`, while the server schema and contract require `500..8000`. Happy-path
wrapper tests passed, but the wrapper could still emit a request the server
would reject.

### Review Questions

- Do Python wrapper bounds exactly match the server Zod schema and contract
  manifest, including lower bounds?
- Are boundary tests present for just-below-minimum, minimum, maximum, and
  just-above-maximum values?
- Do gotcha lanes check schema-compatible payloads rather than only method names
  or happy-path forwarding?

## [2026-07-06] Cross-field wrapper validation must mirror server invariants

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** Python DreamEngine wrappers and any facade that pre-validates related
numeric fields
**Status:** fixed in PR #254; recurrence class of wrapper contract drift

### Pattern

Matching per-field min/max bounds is not enough when the server has a
cross-field invariant. `decompose_entry` must reject `overlap_chars >=
max_chunk_chars`; otherwise a Python caller can create pathological chunking or
send a payload the server rejects.

### Review Questions

- Do wrapper tests cover related-field combinations, not only independent
  bounds?
- Does the wrapper reject the same invalid payloads the server rejects before
  making a client call?
- Does contract/help text name the cross-field invariant so generated clients
  can mirror it?

## [2026-07-07] Stub transports must not expose fake availability

**Severity:** MEDIUM
**Source:** PR #261 initial swarm for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, optional transport facades
**Status:** fixed in PR #261; recurrence of #82 wrapper contract drift

### Pattern

An opt-in transport stub can be useful, but it must not let callers report the
transport as runtime-available before any runtime path exists. PR #261 initially
exported an `AVAILABLE` enum value and accepted it in `NatsTransport` even
though all non-fallback calls still raised unavailable, and the fallback test
only checked method names rather than the full HTTP/MCP request contract.

### Review Questions

- Does a planned/stub transport derive availability from real runtime behavior
  instead of caller-supplied labels?
- Does the no-fallback error avoid claiming a fallback exists?
- Do fallback tests assert headers, session reuse, JSON-RPC ids, protocol
  version, URL, timeout, and tool-call body, not just method names?

## [2026-07-07] Python NATS clients must fail closed on protocol drift before fallback

**Severity:** MEDIUM
**Source:** PR #263 initial swarm for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, Python
request/reply transport facades
**Status:** fixed in PR #263; keep as active checklist

### Pattern

A Python secondary transport can preserve HTTP fallback while still hiding the
exact regressions the realtime path needs to surface. In PR #263, the first
Python request/reply pass caught every exception from the NATS path, so response
schema/id/operation/status mismatches and local envelope validation errors could
silently retry over HTTP. It also left NATS availability open after later
successful `get_contract` responses stopped advertising a valid NATS state,
sent oversized envelopes to the driver before the server-side 64 KiB cap could
reject them, and re-raised raw driver exceptions when fallback was disabled.

### Review Questions

- Does fallback catch only transport-unavailable/request failures, not local
  validation or protocol-conversion errors?
- Are concrete driver exceptions wrapped in a sanitized Open Brain exception
  before escaping fallback-disabled canary/debug paths?
- Does a later successful `get_contract` without explicit valid NATS
  availability close the NATS gate instead of preserving stale availability?
- Does the client enforce the server's NATS request-size cap before sending to
  the driver, falling back to HTTP when configured?
- Do tests prove malformed NATS responses, missing required envelope fields,
  oversized payloads, stale contract responses, and sensitive driver exception
  strings behave correctly?

## [2026-07-07] Secondary transports must preserve HTTP scope and argument parity

**Severity:** HIGH
**Source:** PR #263 Claude/Opus cross-review for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, optional
secondary transport facades for existing MCP tools
**Status:** fixed in PR #263; keep as active checklist

### Pattern

An opt-in secondary transport can pass happy-path tests while silently changing
the caller's scope or request arguments. In PR #263, the Python NATS path first
used authorization-derived namespace only, even when the HTTP client would send
`X-Namespace` for delegated namespace clients. It also copied only the current
known `agent_context_pack` body keys into the NATS envelope, so any unsupported
or future argument would be dropped instead of preserving HTTP behavior.

### Review Questions

- Does the secondary transport preserve the same namespace/source-of-authority
  as HTTP, or intentionally fall back/fail closed when the secondary server
  contract cannot represent that scope?
- Does it preserve the caller's tool arguments, or explicitly fall back to HTTP
  when arguments are outside the secondary envelope contract?
- Do tests cover delegated namespace clients and unexpected/future tool
  arguments, not only the default happy-path scope?
- Does a failed contract refresh close stale secondary-transport availability
  unless the response affirmatively advertises that transport as available?

## [2026-07-06] Release docs must not read as local live-execute approval

**Severity:** MEDIUM
**Source:** PR #259 initial and fix-verification swarms for Issue #167
**Scope:** release preflight docs, migration runbooks, live DB command blocks, destructive script entrypoints
**Status:** fixed in PR #259; keep as active checklist

### Pattern

A runbook can correctly say "dry-run first" but still create operational risk if
it labels a destructive command as approved before the release gate is complete.
For live DB migrations, command blocks must say the approved release/runtime
environment is required and that local PR checkouts or scratch shells must not
be pointed at production credentials. If a script owns the destructive action,
the script should also fail closed before DB access; a copy-pasteable comment or
doc-only shell guard is not enough by itself.

### Review Questions

- Does any command block with `--execute` look pre-approved rather than
  approval-gated?
- Does the doc name where the command is allowed to run?
- Does it explicitly forbid local PR checkouts or scratch shells with
  production credentials when that boundary matters?
- Does the script entrypoint enforce the approval gate before any DB query or
  transaction starts?

## [2026-07-08] Request-metadata features must be measured on raw args through the real dispatch path

**Severity:** BLOCKER
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, `src/tools/__tests__/mcp-audit-log.test.ts`, any
feature that records request metadata (unknown keys, payload size, declared
parameters) from tool arguments
**Status:** fixed in PR #275

### Pattern

The audit wrapper initially measured arguments after Zod parsing had already
stripped unknown keys, so `unknown_parameter_count` was provably 0 through the
real dispatch path. The tests were green anyway: a unit test "proved" the
counting helper against raw args it constructed itself, and the integration
test certified 0 as the correct answer. Green tests over a runtime shape the
SDK never produces.

### Review Questions

- Is the metadata measurement taken from the raw client-sent arguments, before
  any schema parse/strip layer runs?
- Is the feature tested through the real client dispatch path (in-process MCP
  client -> server), not only via a helper called on hand-built raw args?
- Does at least one test send an argument the schema does not declare and
  assert a nonzero unknown count -- an assertion that would fail if the
  raw-vs-parsed layer is wrong?
- Would the integration test still pass if the measurement point silently moved
  behind the parser? If yes, the test certifies the bug.

## [2026-07-08] Diagnostics must share resolution helpers with the consumer they report on

**Severity:** MEDIUM
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `src/operator-doctor.ts`, qmd probe, any doctor/status probe that
reports the health of another subsystem's dependency
**Status:** fixed in PR #277

### Pattern

The doctor's qmd probe initially resolved `QMD_PATH` with its own default logic
instead of the resolution used by `search_all`'s qmd consumer. The probe could
report qmd healthy/unhealthy for a binary path the actual consumer never uses,
making the diagnostic lie in exactly the failure cases it exists for.

### Review Questions

- Does the probe import/call the same resolution helper (path, URL, env
  default) as the consumer it reports on, rather than reimplementing it?
- If the consumer's default changes, does the probe change with it by
  construction, or only by convention?
- Do tests pin probe resolution and consumer resolution to the same value?

## [2026-07-13] Required-tool changes must bump every client compatibility fixture

**Severity:** HIGH
**Source:** Issue #288 Full-tier gotcha and fix verification
**Scope:** public contract plus openbrain-memory package
**Status:** fixed in issue #288 implementation

Adding a required tool while retaining the released client version makes the manifest lie. Bump the package, minimum/range, lockfile, server assertions, and Python contract fixtures together; search expected error strings for the retired range too.

## [2026-07-17] Spool success must mean a fully durable, atomically replayable group

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** fixed in PR #294; recurrence of #80 spool durability

A spool append may report success only after checking the full write, flushing and `fsync`ing the file, and `fsync`ing the parent directory when a durable rename/create is involved. Replay must validate an entire logical group before dispatching any member; raw spool fields must satisfy their exact types before grouping, without coercing strings, booleans, or numerics into valid-looking records. One malformed record cannot allow a valid prefix from that group to partially replay. Tests must inject short writes, sync failures, wrong-typed raw fields, malformed middle records, and restart after durable replacement.

## [2026-07-17] Runtime fallback receipts need tool-specific proof and bounded process I/O

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/_runtime_router.py`, `runtime.py`
**Status:** fixed in PR #294; recurrence class of #81/#82 transport and contract proof

Do not accept a generic success envelope as proof of a durable lifecycle write. Validate the expected receipt for the invoked tool, preserve exact nullable scope coordinates, stream subprocess output under fixed bounds, and after direct-start partial failure verify the intended lane before claiming fallback success. Exercise wrong-lane, malformed-receipt, null-scope, partial-start, timeout, and noisy-child failures.

## [2026-07-17] Package validation must preserve persisted content exactly

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory` live writes, spool writes, and replay
**Status:** fixed in PR #294; recurrence of #77 live-write mutation

Validation can reject content but must not normalize accepted caller payloads. Use normalized copies only for checks, then persist and replay the original string; exact-content tests must include leading/trailing whitespace and sensitive-looking legitimate values.

## [2026-07-17] Package compatibility must enforce semantic versions per required tool

**Severity:** MEDIUM
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/contract.py` and contract fixtures
**Status:** fixed in PR #294; recurrence of #82 contract drift

Checking only that a required tool name exists lets an incompatible schema pass. Parse the advertised tool version, enforce the supported semantic range, fail closed on malformed declarations, and cover missing, older, newer, and malformed versions in fixtures.

## [2026-07-18] Legacy-lane repair can become a scope takeover

**Severity:** HIGH
**Source:** Issues #295/#297, Claude first-class memory rollout
**Scope:** versioned exact-scope lane migrations
**Status:** active

Do not broaden a published lifecycle tool to rewrite non-null legacy coordinates without a contract/version rollout. A versioned migration must derive the canonical project/channel from the row's own stable key, require explicit legacy agent/source markers, keep threaded lanes out, accept only absent or already-canonical server/channel/project values, and leave unknown conflicts untouched. Require a real-Postgres migration test with JSON null, partial migration, idempotence, multiple namespaces, and preserved event history.

## [2026-07-20] Silent caller-input rewriting instead of fail-closed conflict

**Severity:** MEDIUM
**Source:** Issue #297 export slice, PR #305 (#293-family review)
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`src/agent-memory.ts`, `src/disclosure-bundle.ts`
**Status:** active

### Pattern

`export_disclosure_bundle` silently OVERWROTE a caller-supplied lane
sessionKey/agent/project with the active session's values. Silent rewriting
hides caller bugs and spoofing attempts; identity/scope conflicts must fail
closed with an explicit error, and outputs should carry an immutable
session-derived isolation stamp. Also: a "server-side gate" finding can be
stale if the path is a pure local formatter — verify a server round-trip
actually exists before prescribing a server-side fix.

### Review Questions

- Where caller input overlaps session-derived identity, is a conflict an error
  rather than a silent substitution?
- Are supplied items carrying identity fields (session_key, agent, project,
  namespace) validated against the export scope, with unverifiable fields
  rejected?
- Is the Python/TS behavior symmetric, with mirrored regression tests?
- Does the fix location match where the data actually flows (client formatter
  vs server tool)?

## [2026-07-24] First-class reads must prove the tool and project a body-free result

**Severity:** HIGH
**Source:** PR #374 review (issue #371 runtime reflex operation)
**Scope:** `python/openbrain-memory` first-class read routing, contract gating,
response validation, and read receipts
**Status:** fixed-pre-merge

A read can be direct-only and exact-scope while still leaking or drifting. The
first reflex runtime gated on the live v23 manifest but omitted
`agent_reflex_pointers` from the first-class required-tool/version set, so a
manifest without the tool still passed. It then validated only schema + scope
and returned the untrusted server mapping unchanged, allowing body-bearing or
incomplete pointer envelopes through. Its failure receipt also reused generic
redacted exception text, which preserves private non-secret-shaped messages.

### Review Questions

- Does the live pre-call contract gate require the exact read tool and semantic
  version, not only sibling lifecycle tools?
- Does the runtime rebuild a new response from explicit body-free fields and
  validate pointer/citation counts, structural refs, and bijection, rather than
  returning the server mapping after a shallow scope check?
- Are pointer ids, source types, namespaces, structural source refs, and citations
  identity-bound to each other, while still accepting server-authorized readable
  namespaces such as `shared-kb` instead of incorrectly forcing every pointer to
  the envelope scope namespace?
- Can arbitrary text survive in known query, scope-source, pointer-namespace,
  tier, empty-reason, warning, or budget fields, or are values omitted or
  restricted to published
  content-free enums, token shapes, and numeric bounds?
- Are bounded arrays such as whole-pack allocation order capped, unique, and
  equal to the published order rather than accepting duplicate amplification?
- Are malformed server envelopes classified as result-invalid while real
  transport/dispatch failures retain the distinct dispatch-failed category?
- Does a failed read receipt use a stable category derived from failure type,
  never exception text, response bodies, paths, identities, or query content?
- Do regressions remove the tool/version, inject bodies and private text into
  both unknown and known fields, break citation invariants, and prove the full
  serialized output contains none of the sentinels?

## PR #421 — a new package can ship with no CI gate at all

Severity: MEDIUM. Status: fixed in `0d110f1`. Provenance: PR #421, gotcha lane.

`python/openbrain-provider/` landed with its own tests, strict mypy config,
`py.typed`, and wheel configuration — and **no CI job ran any of it**. The
existing `python-package` job is rooted at `python/openbrain-memory` via
`defaults.run.working-directory`; nothing in `ci.yml` named the new package. All
Python CI stayed green while the new package was entirely unenforced.

The failure mode is delayed: a later change breaks provider imports, typing, or
wheel contents, `openbrain-memory` stays healthy, every check passes, and the
break merges.

Related, same PR: a dependency that cannot be fetched in CI. `rtech-standards`
is a **private** repo and this repo's CI passes **no token** (no `secrets.`
reference exists in `ci.yml`). An `ssh://` git source failed host-key
verification; switching to `https://` failed with `could not read Username`. Two
commits treated a reachability problem as a URL-scheme mistake. Check whether a
new dependency is reachable from an *unauthenticated* checkout before choosing
a URL.

Also caught here: a flush race that was green locally and red only in CI. A test
read a log file before calling `logger.remove()`; with loguru `enqueue=True` the
write is on a background thread.

### Review Questions

- Does a PR that adds a new package, workspace member, or language directory
  also add a CI job that runs its lint, typecheck, test, and build? Grep
  `ci.yml` for the new directory name — presence of tests is not coverage.
- Is the new job in `deploy`'s `needs:` list, or can a broken package deploy?
- For a new external dependency: is its repository public, and if not, does CI
  have credentials? Try the documented install command in a checkout with no
  SSH agent and no token before trusting any git URL.
- Does any test read a file written by an `enqueue=True` sink before removing
  the sink? That passes on a fast local disk and fails in CI.
- Does a declared `[project.scripts]` entry point import successfully? No lint,
  type, or test gate reads packaging metadata; the shim installs and dies at
  runtime.

## PR #421 — a regression test with a drain window proves nothing

**Provenance:** PR #421 (openbrain-provider, PROV-2). Severity: HIGH (the test,
not the code). Status: fixed.

`enqueue=True` on a loguru sink means `logger.info()` returns before the bytes
reach disk. loguru's `atexit` hook drains the queue on a clean exit, so a naive
durability test passes. It does **not** run on a signal: measured with no drain
window, SIGTERM landed **133 of 200 records**, and the 67 lost were the newest
ones. For a hook process that is backwards — the records worth having are the
ones written just before something tore it down.

The gotcha is the first regression test written for it. The child wrote a
`ready` file and slept; the parent polled for that file, then sent SIGTERM. The
polling loop handed the writer thread ~10ms — enough to finish the queue — so
the test reported **200/200 with the fix reverted**. It would have been
committed as proof of a fix it never exercised. Rewritten so the child signals
*itself* immediately after the last record, it reports 133/200 without the fix
and 200/200 with it.

This is the same shape as the earlier finding in this PR where
`test_unwritable_log_file_is_not_fatal` asserted the process kept running but
never captured stdout, so a 436-byte leak onto the hook's response channel
survived every green run. **Both tests asserted the process was alive rather
than that the data arrived.**

Second issue found while verifying: `configure_observability` installs a real
SIGTERM/SIGINT handler on whatever process calls it — under pytest, that is the
pytest process. The autouse fixture removed sinks but not signal dispositions,
leaking this module's handler into later tests and into the path of a CI job
cancellation.

Also note `signal.default_int_handler` is a *callable*. A `if callable(previous)`
guard meant to detect "someone else already owns this signal" skips SIGINT
every single time, because the interpreter's own default satisfies it.

### Review Questions

- Does the regression test actually fail with the fix reverted? Neuter the fix
  in place (keep the symbol importable so the test runs) and measure. An
  `ImportError` red is not a red.
- Does a durability test give the async writer a drain window before killing the
  process? Any `sleep`, poll loop, or file-based handshake between the last
  write and the signal can hide the bug entirely.
- Does the test assert the *data arrived*, or only that the process survived /
  exited cleanly? The second is the recurring failure in this repo.
- Does a library function install a process-global signal handler? If so: does
  it refuse to stomp a caller's handler, does it treat
  `signal.default_int_handler` as unclaimed, does it re-raise so the process
  still dies, and does SIGINT keep `KeyboardInterrupt` semantics instead of
  becoming a hard kill?
- Do tests that call such a function restore signal dispositions afterward?
## [2026-07-25] uv ANSI output disabled Open Brain session-start recall

**Severity:** HIGH
**Source:** live incident — post-compact recall failure, dogfood Open Brain
**Scope:** `ob-memory-provider/package-runtime.ts` uv resolution
**Status:** open — fix belongs in the adapter source repo, not the hash-pinned
install

> The general rules this produced (force machine-readable subprocess output,
> misdirecting errors cost more than silence, instrument rather than infer,
> never hand-patch a hash-pinned install, gates must not block their own
> repair) are now in `_DOCS/CODING_STANDARDS.md` `## Gotchas` and apply
> fleet-wide. This entry keeps only the Open Brain specifics.

Session-start recall failed with `OB ✗ gate unavailable` while BOTH Open Brain
servers were healthy (127.0.0.1:3100 and 10.71.1.21:3100 each returned 200),
Postgres was reachable, the token authenticated, the env config was correct, and
the `openbrain-memory` CLI at 0.1.18 returned a full valid context pack
(`status: "direct"`, 14,663 chars) when invoked directly with the same payload.

Root cause: `uv` emitted ANSI color codes on stdout. `commandPath()` runs
`uv tool dir`, then `isAbsolute(stdout.trim())`. The actual bytes were
`033 [ 3 6 m / U s e r s / ...` (proven with `od -c`), which is not an absolute
path, so `commandPath` returned null -> `resolveUvToolLayout` null ->
`resolvePackageRuntime` null -> `callPackage` returned
`{ok: false, errorCategory: "provider"}` **before any network call was made**.
The adapter then reported "lane memory unavailable", naming the network as the
suspect for a local string-parsing failure.

The fix is a subprocess-scoped `env: {...process.env, NO_COLOR: "1"}` on the
`spawnSync` in `defaultPackageRuntimeRunner`, plus ANSI stripping before
`isAbsolute()`. Do NOT set `NO_COLOR` in the operator's shell environment —
Rico uses color interactively; the adapter owns its child env, not the session.
Do NOT hand-patch the installed `sha256-<hash>` adapter directory: the hash is
the version pin, and the next `uv tool install --upgrade` silently erases the
patch, guaranteeing rediscovery of a bug already "fixed".

**Cost of the suppression:** four layers each computed the cause and discarded
it — `commandPath` knew the `isAbsolute` check failed, `resolveUvToolLayout`
knew the layout was unresolved, `resolvePackageRuntime` knew it returned null,
and `callPackage` computed `errorCategory: "provider"` then shipped it to
Langfuse instead of stdout. This violates `_DOCS/CODING_STANDARDS.md`
`## Observability` verbatim: *"Catch blocks that return a fallback value must log
before returning. Never `catch { return null }` silently."* One `console.error`
at the resolution site would have made this a two-minute fix; instead it cost
~40 minutes and three wrong diagnoses (missing env key, wrong base URL, version
mismatch), each disproved only by an operator-run command.

**The diagnostic method that actually worked**, after reading code failed three
times: copy the module beside its own imports (relative imports break if moved),
insert `console.error` at every failure branch, run it. Do not infer a runtime
cause from code structure when the error text is suppressed — instrument it.
Reading cannot see a runtime value.

**A wrong error message is more expensive than no error message.** Silence makes
you look; misdirection makes you look elsewhere. "Unavailable" sent six probes
against two healthy servers.

### Review Questions

- Does any code path parse another program's stdout? If so, does it force
  machine-readable output (`NO_COLOR`, `--format json`, `--quiet`) in the
  subprocess env AND sanitize before parsing? A convenience CLI's formatting is
  not a stable contract; it changes on the tool's schedule, not yours.
- Is that env forcing scoped to the child process, or does it leak into the
  operator's interactive shell?
- Does every `return null` / `return {ok: false}` on a failure path log the
  specific reason first, or does the caller receive an undifferentiated null?
- When a failure category IS computed (e.g. `errorCategory`), does the operator
  see it, or is it exported to telemetry only? Telemetry is not a substitute for
  an error message at the terminal.
- Does one generic failure string cover multiple distinct causes that require
  different operator actions (config invalid vs server unreachable vs validation
  failed)? Name each cause distinctly.
- Does the error message name the subsystem that actually failed? A local
  parsing failure reported as a remote availability problem routes the responder
  to the wrong half of the system.
- Can a gate that depends on a subsystem block the repair of that same
  subsystem? A context/policy gate needs a repair-mode escape or it deadlocks
  exactly when it is needed most.

## [2026-07-26] A "fix" for an impossible case, and the test that could not fail

**Provenance:** PR #424, SME lane. **Severity:** MEDIUM. **Status:** fixed.

Self-review "fixed" an unguarded `FILE_SINK?.write` by wrapping it in
`try/catch`, reasoning that a full disk must not take the log line down with it.
The reasoning was sound; the guard was redundant.

The SME lane applied this file's own instruction — *neuter the fix in place and
measure* — and found **0 tests failed** with the guard removed, across 151 tests
in every logger-touching suite. Two layers of why:

1. The whole suite runs with `LOG_FILE` unset, so `FILE_SINK` is `undefined` and
   `?.` short-circuits before reaching the guarded block.
2. Deeper: `createRotatingFileSink` documents *"Never throws on write"* and
   already wraps `appendFileSync` in its own `try/catch`. **The throw being
   guarded cannot occur.**

A guard for an impossible case is not free. It tells the next reader this sink
can throw, which is false, and it is untestable by construction — so it reads as
a coverage gap forever.

What replaced it: the guard was removed with the rationale recorded inline, and
a test was added for the behaviour *neither* version covered — an unwritable
`LOG_FILE` must still produce the line on console. It runs through a subprocess,
because `FILE_SINK` resolves once at module load and an in-process test can
never reach it.

### Review Questions

- For each fix in a PR: **revert it in place and run the tests.** If nothing
  fails, either the test is missing or the fix is unnecessary. Both are worth
  knowing, and they are distinguishable only by looking.
- Before guarding a call, check whether the callee already guarantees it does
  not throw. Read the callee's contract, do not infer it from the call site.
- Is the fixture even reachable? A module-level `const` resolved from env at
  import time (`FILE_SINK`, `HOST_NAME`, `SERVICE_NAME`) cannot be exercised by
  a suite that does not set that env — a subprocess is the honest way in.
- Does the suite's default env silently disable the code path under test?

## [2026-07-26] Four defects that three review passes all missed

**Provenance:** PR #424, final independent gate. **Severity:** HIGH.
**Status:** fixed.

An author self-review and two swarm lanes all cleared `src/logger.ts`. A fourth
independent pass found four more defects in the same file, all reproduced. What
unites them is that every one is a **guard that was correct about its intent and
wrong about its mechanism** — so reading the code, and the comment above it,
confirms the intent and hides the flaw. Three passes read the intent.

**1. A redactor that cannot see what it is redacting.** Every detector was
value-shaped (`sk-…`, `ghp_…`, the literal text `password=…`). But a JSON
logger hands its replacer each value *in isolation*, so `{"password":
"hunter2driveway"}` emitted in clear. The pattern set already contained
`json_labeled_secret`, which matches that exact pair — when given the pair as
text. It was never shown the key. The detector list looked complete because it
was; the call site never supplied the context the detectors needed.

**2. A bound that manufactured the leak it existed to prevent.** Input was
truncated at 16 KB *before* the patterns ran, so a DSN straddling the boundary
was cut mid-credential, nothing matched the surviving head, and the tail went
out readable. Truncating cannot create a secret, but it can destroy the evidence
that one is present. Order of operations, not the operations.

**3. Cycle detection that flagged non-cycles.** A `WeakSet` that only ever grew
marked *any* object seen a second time as `"[Circular]"` — including one
referenced from two sibling fields, which is not a cycle. Sharing one
config/job/namespace object across fields is ordinary, so the false positive was
the common case, silently dropping real data. "Seen before" and "is its own
ancestor" are different questions; only the second one means circular.

**4. A reentrancy guard keyed on a value that collides.** `minLevel === widened`
cannot distinguish "my temporary value is still installed" from "a nested call
deliberately chose that same value." An existing test covered nested
`setLogLevel` and passed throughout — because its nested call picks a level that
*differs* from the widened one. The colliding case inverted the result while
telling the nested caller it had succeeded.

### Review Questions

- **Does this guard ever see the information it needs to decide?** A redactor
  handed one value at a time cannot act on the field name; a validator handed a
  parsed object cannot act on the raw bytes. Check the call site's data flow,
  not the guard's logic.
- **Does a sanitizer run before or after the thing that bounds it?** Truncate,
  normalize, encode, and redact are all order-sensitive. Ask which one runs
  first and what the other one can no longer see.
- **Is "have I seen this?" standing in for "is this an ancestor?"** A
  monotonically growing set answers the first. Cycle, recursion, and depth
  guards need the second, and the difference only shows on a DAG — repeated
  siblings, not loops.
- **Does the guard's key have collisions?** Comparing a *value* to detect "did
  someone else change this" fails whenever someone else picks the same value.
  Identity tokens, generation counters, and sentinels do not collide; values do.
- **Does the existing test for this exercise the colliding case?** A passing
  reentrancy/idempotency test often picks distinct values precisely because
  distinct values are easier to assert on. That is the case that cannot fail.
