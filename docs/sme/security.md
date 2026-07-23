# Security SME Findings

Security reviewers focus on boundaries: namespaces, bearer tokens, secret
handling, trusted headers, redirect behavior, and plaintext transport.

## [2026-06-11] Namespace metadata must not bypass token/header authority

**Severity:** HIGH
**Source:** Issue #78, PR #73 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** active

### Pattern

`AgentMemory.remember_fact()` and `remember_decision()` accepted free-form
`namespace` metadata and forwarded it into tool arguments. That can conflict
with or attempt to override the server's token-derived namespace authority or
an explicit privileged `X-Namespace` delegation path.

### Review Questions

- Is `namespace` removed from generic metadata pass-through, or verified against
  the authenticated server-side namespace/delegation policy?
- If namespace override is required, is it an explicit privileged API rather
  than arbitrary metadata?
- Are there tests for `namespace="other"` on normal clients?
- Do docs explain bearer token, server policy, headers, and facade behavior?

## [2026-06-11] Redaction must protect diagnostics without corrupting data

**Severity:** HIGH
**Source:** Issue #77
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`python/openbrain-memory/src/openbrain_memory/policy.py`,
`python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

Redacting the payload before calling Open Brain can silently persist legitimate
memory content as `[REDACTED]`. Redacting before durable spool persistence can
make replay unable to restore the original write.

**2026-07-20 update (Issue #304, PR #305):** the spool half of this stance is
superseded. The contract decision is that secrets never land on disk: the spool
now redacts before persistence and replay deliberately replays the redacted
form. The live-write half (successful live writes preserve caller content)
remains active.

**2026-07-22 update (PR #319):** runtime receipts must not re-expose remote
HTTP/tool response bodies after transport redaction. Remote errors need bounded
class/status/context evidence only; persisted spool replay is explicitly the
redacted representation, not exact original payload replay.

### Review Questions

- Are live writes preserving caller content?
- Are logs/errors redacted separately?
- Is spool data protected without pretending lossy redacted data is exact replay?
- Do remote-error receipt tests use a sentinel body and prove it cannot escape?
- Do tests prove successful live writes are not silently redacted?

## [2026-06-11] Redaction coverage must include common unlabeled credential shapes

**Severity:** MEDIUM
**Source:** Issue #82, PR #72/#74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/policy.py`
**Status:** active

### Pattern

Label-based redaction catches `token=` and `password:` but misses common
unlabelled shapes: AWS access key IDs, AWS secret-like values, Slack tokens,
Google API keys, and bare JWT-like strings.

### Review Questions

- Are there tests for AWS access key IDs and secret-like values?
- Are Slack token and Google API key shapes covered?
- Are bare JWT-like strings covered without over-redacting normal prose?
- Are test fixtures split to avoid secret scanner false positives?

## [2026-06-11] Bearer-token HTTP must be opt-in and non-redirecting

**Severity:** HIGH
**Source:** PR #72 review, PR #76 docs review
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, README
**Status:** active

### Pattern

Bearer-token MCP calls over non-local HTTP or through redirects leak credentials.
PR #72 fixed HTTPS enforcement and redirect disabling. PR #76 hardened docs to
default to HTTPS and require `OPENBRAIN_ALLOW_INSECURE_HTTP=1` for trusted lab
HTTP.

### Review Questions

- Are non-local `http://` URLs rejected unless explicitly allowed?
- Are redirects disabled for auth-bearing requests?
- Do docs avoid making plaintext HTTP the default copy-paste path?

## [2026-06-19] ReDoS: bounding inner segments does not fix an unanchored `*` prefix

**Severity:** HIGH
**Source:** PR #175 (post-merge swarm on #174), found after #174 merged
**Scope:** `src/sharing.ts` SECRET_PATTERNS, `python/openbrain-memory/.../policy.py`, any regex run on user/agent content
**Status:** active

### Pattern

`URL_USERINFO_CRED_RE` was `[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s@/]+@...`. A first
fix bounded the userinfo segments to `{1,256}` and was declared fixed — but the
O(n^2) blowup is the **unanchored `*`-quantified scheme prefix**, which the
regex engine restarts and rescans at every input position (it triggers even on
input with no `://` at all). Bounding the *inner* segments does nothing. This
runs on the promoter secret gate (`containsSecret`) over agent-influenceable
lane content → a DoS on the gate.

### Review Questions

- Does any secret/validation regex have an unanchored `*`/`+`-quantified prefix
  before the first required literal? That is the restart-rescan O(n^2) source.
- Was a ReDoS fix verified with a SCALING test (10k/20k/40k/80k) on input that
  hits the specific backtracking path — not a single small/"big" string?
- Is there a regression test asserting sub-second scan of large (≥80k) input?

### Prior Fix

PR #175 replaced the wildcard scheme prefix with a fixed alternation
`(?:https?|ftp|postgres|...)://`, removing the restartable prefix. Linear after:
80k chars ~2ms (TS) / ~17ms (Python). Regression test added both sides.

## [2026-06-27] Receipt evidence needs a reject-only secret gate

**Severity:** HIGH
**Source:** PR #218 full swarm
**Scope:** `src/agent-memory.ts`, `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** fixed in PR #218

### Pattern

Receipt wrappers rejected authority keys but still accepted obvious secret-like
evidence in `sources`, `outputs`, `validations`, residual risk, or extra
metadata. Redacting persisted receipts would corrupt evidence, so wrappers need
a reject-only gate before durable writes.

### Review Questions

- Does `recordReceipt` / `record_receipt` reject secret-looking strings and
  sensitive key names before `append_session_event`?
- Are diagnostics/redaction separate from the persisted receipt payload?
- Are TS and Python tests covering both sensitive keys and labeled bearer/API
  material?

## [2026-07-05] Wrapped-secret tests must mirror every credential family

**Severity:** HIGH
**Source:** PR #239 cross-model gauntlet for Issue #236
**Scope:** `src/sharing.ts`, `scripts/ob-backfill.ts`, any transcript/log import
path that redacts before durable writes or previews
**Status:** fixed in PR #239; keep as active checklist

### Pattern

Redaction review covered common standalone token families, but missed wrapped
credential tails for bearer headers, MCP session IDs, SSH credential URLs, and
punctuation-split tokens. Transcript/log importers can split secrets across
whitespace, line wrapping, or punctuation inside structured snippets, then
recombine cleartext tails in dry-run output or OB writes unless the
wrapped-secret gate mirrors every credential family and separator covered by
the base redactor.

### Review Questions

- Do wrapped-secret regression tests cover every credential family in
  `SECRET_PATTERNS`, not just API keys and JWT-like values?
- Are labeled headers such as `Authorization: Bearer` and `mcp-session-id`
  tested with the value split across whitespace?
- Are prefixless and prefixed tokens tested with the value split by
  non-whitespace punctuation such as comma, quote, angle bracket, bracket,
  markdown backtick/asterisk, or shell punctuation?
- Are credential URL schemes, including `ssh://`, tested with userinfo split
  across line wrapping?
- Do dry-run previews and durable-write paths both sanitize before slicing or
  logging text?
- After redaction, does a residual compacted-string check prove no wrapped tail
  remains in cleartext?

## [2026-07-05] Role rename/parity changes must enumerate EVERY gate, including reversal paths

**Severity:** MEDIUM (P2)
**Source:** PR #235 cross-model (Codex) review
**Scope:** `src/rest-promotion.ts` (`/api/v1/demote`), `src/tools/demote-entry.ts`, `src/tools/promote-shared.ts`
**Status:** fixed in PR #235

### Pattern

The #168 `n8n` -> `ob-admin` rename updated every gate that previously paired
`admin` with `n8n`, but missed gates that hard-coded `role === "admin"` alone:
both demote gates (REST + MCP) and the `promote_shared` entry gate. Result: an
admin-equivalent role could promote/archive but got 403 reversing a bad
promotion -- the forward path and its reversal path diverged in authority.

### Review Questions

- For any role add/rename/parity change, did someone grep for BOTH forms:
  paired predicates (`=== "admin" || === "<role>"`) AND lone
  `=== "admin"` / `!== "admin"` literals across `src/`?
- Is each remaining admin-only literal either extended or explicitly justified
  as intentionally admin-only?
- Do mutation gates and their REVERSAL gates (promote/demote, archive/restore)
  grant the same roles? Asymmetry is usually a bug.
- Does the parity regression suite enumerate every gate (REST and MCP variants
  separately) rather than spot-checking one?

## [2026-07-08] New bearer-auth transports must reuse constant-time token matching

**Severity:** MEDIUM
**Source:** PR #283 initial swarm for Issue #282
**Scope:** NATS request/reply bridges, alternate transports, and any non-HTTP
bearer-token auth path
**Status:** fixed in PR #283

### Pattern

Adding a second bearer-auth surface can accidentally bypass HTTP middleware's
constant-time token matching if it verifies tokens with direct `Map.get()` or
another early-exit lookup. Even when the transport is local-first, the server
auth semantics should match the HTTP path so timing and role behavior do not
diverge.

### Review Questions

- Does the new transport call the same constant-time token matching helper as
  HTTP auth?
- Is there a regression test that would fail if the transport used direct token
  lookup?
- Do startup/shutdown logs avoid raw exception messages that may include
  credential-bearing broker URLs or wrapped token material?
- Does the health endpoint redact internal error detail while still exposing
  machine-readable availability?

## [2026-07-06] Privileged source-scope predicates must match one source reference

**Severity:** HIGH
**Source:** PR #255 pre-PR and initial swarm review for Issue #118
**Scope:** `src/source-refs.ts`, `src/tools/get-entry.ts`,
`src/tools/search-brain.ts`, `src/tools/search-all.ts`,
`src/tools/brain-answer.ts`, generic full-row REST reads
**Status:** fixed in PR #255; keep as active checklist

### Pattern

Structured source metadata is a privilege boundary for closed-brain deployments.
A JSONB predicate that checks `client_id`, `matter_id`, and `document_id` with
independent containment clauses can match those keys across separate
`source_refs` objects on the same row. That lets one row satisfy a scoped query
even though no single cited source belongs to the requested client/matter/doc.
Adding privileged `source_refs` to shared full-row projections can also leak
them through namespace-only reads unless every generic read surface redacts by
default. Scope filters must also account for every identifier accepted on
`source_refs`; accepting `path` or `dms_id` without allowing the same fields in
`source_scope` creates write-only provenance that cannot be safely returned.
The scope gate and the returned-source-ref filter must validate refs at the same
granularity: all-or-nothing array validation can silently drop a valid matching
ref when any sibling ref is malformed, and SQL gates that do not require a
document identifier can let row content pass a scope that no returned citation
can satisfy.

### Review Questions

- Do multi-key source-scope filters require all supplied keys to match the same
  `source_refs` array element, for example through `jsonb_array_elements` and
  one `EXISTS` predicate?
- Are all accepted source-ref identifiers represented in `source_scope`
  (`client_id`, `matter_id`, `document_id`, `path`, and `dms_id`)?
- Are scoped filters parameterized and applied consistently to search,
  answer/citation, compact fetch, and full fetch paths?

## [2026-07-07] Secondary transports must not weaken auth-bearing plaintext or parse-order gates

**Severity:** HIGH
**Source:** PR #262 initial swarm for Issue #223
**Scope:** `src/nats-runtime.ts`, `src/nats-bridge.ts`, NATS or other bearer-token transport bridges
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Auth-bearing secondary transports can accidentally create a weaker side door
than HTTP/MCP. In PR #262, the first NATS bridge pass accepted any non-empty
`nats://` URL for runtime availability, including remote plaintext brokers, and
parsed/schema-validated the request body before bearer-token auth or request
size checks. Parser/schema details were also returned to callers.

### Review Questions

- Does an auth-bearing plaintext transport allow only local/trusted endpoints by
  default, with any remote plaintext override explicitly named and documented?
- Does the bridge authenticate cheap headers before parsing untrusted bodies?
- Is request size bounded before decode/schema validation?
- Do bad request responses avoid leaking raw parser or schema diagnostics across
  the transport boundary?
- Do unscoped namespace-only reads redact privileged `source_refs` by default?
- Does any generic shared projection include privileged source metadata without
  a caller-specific redaction or scope gate?
- Do scoped searches exclude result families without `source_refs` rather than
  returning unscoped evidence?
- Do regression tests cover parameterization, same-ref matching, scoped output
  filtering, and unscoped read redaction?
- Does returned-source-ref filtering keep valid matching refs even when a
  sibling ref is malformed, instead of dropping the whole array?
- Does the SQL scope gate require the matched array element to be a real
  citable ref (`document_id`, `path`, or `dms_id`) so row visibility and
  returned citations agree?

## [2026-07-07] Transport URLs must not be logged with userinfo or hosts

**Severity:** MEDIUM
**Source:** PR #260 initial swarm for Issue #223
**Scope:** `src/index.ts`, transport startup warnings, NATS/HTTP/stream config
**Status:** fixed in PR #260; keep as active checklist

### Pattern

Transport configuration often arrives as a URL. A NATS URL with userinfo carries
credentials in `username/password`, and even host/IP fields can be sensitive in
durable logs. Startup warnings and diagnostics should record only safe facts:
configured/not configured, protocol, and whether credentials were present.

### Review Questions

- Does any log include an env-sourced transport URL verbatim?
- If a URL may contain userinfo, tokens, hosts, or internal IPs, is the log
  reduced to safe booleans/enums rather than redacted text with residual shape?
- Do tests prove credential-bearing URLs do not appear in log helper output?

## [2026-07-07] Transport error logs must not copy raw dependency messages

**Severity:** MEDIUM
**Source:** PR #262 Claude/Opus cross-review for Issue #223
**Scope:** `src/nats-bridge.ts`, secondary transport request handlers, subscription loops
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Dependency error messages can embed user content, tokens, broker URLs, internal
hosts, or headers. Returning generic errors to callers is not enough if
server-side logs still write `err.message` verbatim. Transport diagnostics
should log stable classes/codes and safe context such as subject or operation,
not raw dependency messages.

### Review Questions

- Do request, handler, and subscription error logs avoid raw `err.message`?
- Are diagnostics limited to safe error type/code plus safe routing metadata?
- If an error type is logged, is it derived from allowlisted instance checks
  rather than mutable `Error.name`?
- Do tests throw sensitive-looking dependency errors and prove logs omit the
  sensitive fragments?

## [2026-07-08] Validation failures are the security-relevant audit events

**Severity:** HIGH
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, MCP validation hooks, audit-path error logging
**Status:** fixed in PR #275 via a scoped mechanic; unknown-tool limitation
documented; logger-redaction regression test still missing (see Pattern)

### Pattern

An audit trail that only records successful tool dispatches misses the calls a
security review actually wants: malformed and rejected requests. PR #275 fixed
this by auditing at the repo-owned validation hook so schema rejections are
recorded with a `validation_error` status. The residual, documented limitation:
calls to unknown tool names are rejected by SDK layers above any repo-owned
hook and remain unauditable there. Separately, audit-path failure logs must
record `err.code`/`err.name` only -- never raw pg `err.message`, which can embed
query fragments or user content.

Known gap: there is no dedicated logger-redaction regression test for this yet.
The `err.code`/`err.name` redaction was code-review-verified in PR #275, and a
revert to logging raw `err.message` would pass the current suites. Reviewers
must REQUIRE a focused logger test whenever audit-logging code is touched:
inject a pg-like error carrying a secret-looking message, capture
`logger.warn`, and assert only the code/name are logged.

### Review Questions

- Are validation failures audited with a distinct status at the repo-owned
  validation hook, not only successful dispatches?
- Is the unknown-tool blind spot (rejected above repo hooks) documented rather
  than silently assumed covered?
- Do audit-path error logs restrict themselves to `err.code`/`err.name`?
- Does the PR touch audit-logging code? If so, REQUIRE the focused
  logger-redaction test described above -- it does not exist yet, and
  code-review verification from PR #275 does not protect against reverts.

## [2026-07-13] Inline transcript storage is a credential boundary

**Severity:** MEDIUM
**Source:** Issue #288 Full-tier security review
**Scope:** append_session_event transcript citations
**Status:** fixed in issue #288 implementation

Transcript payloads require the same synchronous secret rejection as other durable evidence. References use canonical host-neutral segments, empty transcript still requires a ref, and DB-error logs expose only allowlisted labels.

## [2026-07-17] Persisted-write validation must not normalize caller content

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `openbrain-memory` live writes, spool validation, and replay validation
**Status:** fixed in PR #294

Validation may inspect a normalized copy for emptiness, bounds, or safety, but the accepted durable payload must remain byte-for-byte caller content. Trimming or rewriting during validation silently changes memory evidence and can make live and replayed writes disagree. Regression tests must use leading/trailing whitespace and sensitive-looking legitimate text and assert exact persisted and replayed content.

## [2026-07-18] Legacy exact-scope migration must be an atomic allowlisted CAS

**Severity:** HIGH
**Source:** Issues #295/#297, Claude first-class memory rollout
**Scope:** versioned lane migrations, replay, and restore paths
**Status:** active

A caller must not be able to relabel an arbitrary existing lane by presenting a new exact scope. Prefer a reviewed versioned database migration over silently broadening a published runtime tool contract. Automatic migration is permitted only for explicitly recognized legacy markers and canonical target coordinates derived from the same row's stable session key. The database predicate must constrain agent/source/server/channel/thread/project independently; unknown non-null conflicts remain untouched for operator review. Require live-Postgres tests for recognized and partial migration, idempotence, every coordinate conflict, namespace-independent row identity, and event-history preservation.

## [2026-07-20] Client-side persistence paths must redact before disk

**Severity:** HIGH
**Source:** Issue #304, PR #305 (#293-family review)
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

The JSONL spool persisted `"payload": dict(payload)` raw to disk, with
`redact_value` applied only to a diagnostic view — and a test explicitly
asserted the secret WAS on disk. Any client-side persistence surface (spool,
cache, export file) must apply redaction before the bytes hit disk, and replay
must deliberately replay the redacted form rather than pretend raw fidelity.

### Review Questions

- Does every disk write of caller payloads pass through `redact_value` (or
  equivalent) before serialization, not just before display?
- Do tests assert the secret is absent from the RAW file content
  (`path.read_text()`), not merely from a redacted accessor?
- Is there a test locking the OPPOSITE (bad) behavior that should be flipped?
- Do pre-fix artifacts on disk (written before the redaction change) get
  retro-scrubbed or aged out, and is replay of old artifacts considered?

## [2026-07-21] Gate prerequisites must fail closed on receipts and inputs

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** CI warm-up/cache steps and environment-derived gate inputs
**Status:** fixed-pre-merge

- A warm-up gate that accepted failed receipts let downstream jobs proceed as if the prerequisite succeeded; a failed warm-up receipt must be a hard failure, never advisory.
- Cache/env override class: caches and environment variables feeding a gate (e.g. the uv cache) are influencable inputs; gates must validate what actually executes at gate time, not what a cached or declared artifact claimed earlier.

## [2026-07-21] Rejected by design: pinning fast-moving external binary hashes

**Severity:** N/A (standing design rejection)
**Source:** PR development#44 review swarm 2026-07-21, operator decision (Rico)
**Scope:** Any provider/adapter that spawns an external tool (uv, bun, git, gh)
**Status:** rejected-by-design — do NOT re-recommend

### Pattern

Reviewers repeatedly propose "also hash-pin the interpreter/tool binary"
(e.g. verify a sha256 of the `uv` executable before every spawn). This is the
upgrade-kill-shot pattern that caused the 2026-07-18/20 venv-pin disaster:
pinning a mutable, routinely-upgraded artifact means every legitimate upgrade
of that tool silently bricks all fail-closed consumers (stranded live sessions,
emergency re-pin ceremonies). Pin only the reviewed artifact we ship (the
wheel); treat the host toolchain as platform, verified by behavior (probe
receipts), not by byte identity.

### Review Questions

- Does this recommendation pin something the operator upgrades routinely and
  independently of this repo? If yes, it recreates the stranding class — reject.
- Is the integrity goal already met by behavioral proof (deterministic probe
  receipt, per-sha cache isolation)? Prefer that.

## [2026-07-21] Rejected by design: fd-pinning / TOCTOU theater inside the local trust boundary

**Severity:** N/A (standing design rejection)
**Source:** PR development#44 review swarm 2026-07-21, operator decision (Rico)
**Scope:** Local single-user adapter/hook code (Claude provider sandwich and peers)
**Status:** rejected-by-design — do NOT re-recommend

### Pattern

Reviewers propose closing the hash-then-spawn window with fd/inode pinning,
O_NOFOLLOW, or private immutable copies. In this deployment the artifact, the
cache, AND the adapter source itself are all writable by the same local user:
an attacker who can swap the wheel mid-window can more easily edit the adapter
script that performs the check. Hardening one millisecond window while the
whole verifier is user-writable is complexity without a threat model. The
correct mitigations here are the ones that catch ACCIDENTS: single sha over the
shipped artifact, per-sha cache dirs, deterministic probe receipts.

### Review Questions

- Is the proposed mitigation defending against an actor who already has write
  access to the code doing the defending? If yes — wrong trust boundary, reject.
- Does the accident-class equivalent (stale cache, wrong file, partial write)
  already fail closed via hash + probe? Then the TOCTOU add-on is theater.

## [2026-07-21] Spooled records replayed under config authority need origin provenance

**Severity:** MEDIUM
**Source:** PR #314 (open-brain#310 scope-aware drain) review swarm 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/_runtime_spool.py`, `runtime.py` `_drain_spool`
**Status:** fixed-pre-merge

### Pattern

Scope-aware drain rebuilds lane coordinates from the spooled record but binds
the namespace to the *draining* runtime's auth config. When two runtimes with
different namespaces share one spool file, a unit parked under namespace A
would drain into namespace B — a silent cross-namespace transplant. Any record
persisted under one authority and replayed under another must carry provenance
of the authority it was parked under (here: client-internal
`_parked_namespace`, stamped at append, stripped before dispatch, mismatch →
retain with zero live dispatches). Namespace isolation is a security boundary;
"the config decides at replay time" is not enough when the config can differ
from the one that accepted the write.

### Review Questions

- Can a persisted-then-replayed record cross an auth/namespace boundary because
  replay-time config differs from park-time config?
- Is the provenance marker client-internal (stripped before any server
  dispatch) so it never widens the wire contract?
- On mismatch, is the unit retained with *zero* dispatches (no wasted live
  call, no partial replay)?

## [2026-07-21] Disposition/certification docs must cover error paths, not just denial paths

**Severity:** MEDIUM
**Source:** PR #316 review swarm, 2026-07-21
**Scope:** `src/tools/bulk-archive.ts`, `docs/memory-contract.md` disposition
table, any surface a doc certifies as "content-free"
**Status:** fixed-pre-merge

### Pattern

The #297 disposition table certified the deletion/archive surface as
content-free while `bulk_archive`'s catch block still returned raw pg
`err.message` (`Transaction failed: ${message}`) across the MCP transport
boundary and logged it verbatim. A denial/no-op path being content-free says
nothing about the ERROR path of the same surface; certifying a surface in a
disposition doc without walking its catch blocks lets a leak ship under a
"verified content-free" label. Fixed by a stable `"Transaction failed"`
response, `err.code`/`err.name`-only logging, and a leak regression test that
throws a sensitive-looking pg error and asserts the response contains none of
it.

### Review Questions

- When a doc/table certifies a surface as content-free or isolated, was every
  `catch` block on that surface checked for interpolated `err.message` in the
  response or logs?
- Does the certification claim scope itself (denial path vs error path), and
  does each claimed path have its own test?
- Is there a leak test that injects a dependency error carrying
  table/constraint/namespace-shaped fragments and asserts the transport
  response is the stable string only?

## [2026-07-21] Namespace provenance must be stamped on EVERY spooled record shape

**Severity:** MEDIUM
**Source:** PR #317 review swarm, 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/_runtime_spool.py` (`TrackingSpool.append`/`_parked`), `runtime.py` `_drain_spool` dispatch
**Status:** fixed-pre-merge

### Pattern

#314 stamped `_parked_namespace` only on spooled `session_start` payloads.
Lone non-start units — records spooled after the lane was already established
live, so no `session_start` prerequisite was queued with them — carried no
provenance, so a runtime configured for another namespace would dispatch them
under its own namespace AND (once #296 added retry accounting) count their
failures and quarantine them into the wrong runtime's sidecar. Client-side
origin provenance must be stamped on EVERY spooled record shape that can
replay, not just the shape the original bug was reproduced with, and the
replay-side mismatch check must pop the marker from every record and retain
(never fail-count) on mismatch. Records already on disk without the marker
keep legacy behavior — an honest, documented carve-out
(`docs/memory-contract.md` spool-replay row).

### Review Questions

- Is origin provenance stamped on every persisted record shape that can
  replay, or only on the first-record/prerequisite marker from the original
  fix?
- Can a record with no provenance-bearing lead record (lone unit, partial
  batch, direct append) replay under a different authority than the one that
  accepted it?
- On mismatch, is the unit retained with zero dispatches AND zero
  retry/quarantine accounting in the foreign runtime's sidecars?
- Is the marker stripped before dispatch on the matching-namespace path, so
  it never reaches the router or the wire?

## [2026-07-22] Child-process stderr and validation catch paths are part of every content-free surface (RECURRING)

**Severity:** MEDIUM
**Source:** PR #318 review swarm, 2026-07-22
**Scope:** `scripts/restore.ts` (`runPgRestore`, `validatePostRestore` catch
paths), `scripts/backup.ts` (`runPgDump`), `scripts/backup-lib.ts`
(`summarizeChildStderr`, `fileEntrySchema`)
**Status:** fixed-pre-merge

### Pattern

RECURRING — third occurrence after #275 and #316: every NEW operator/tool
surface that certifies content-freedom ships with an unsanitized error path.
This round it was CHILD-PROCESS stderr: the backup/restore CLIs passed raw
`pg_dump`/`pg_restore` stderr into thrown errors and receipts, and pg stderr
carries literal row data on mid-COPY failures (`CONTEXT: COPY <table>, line
N: "<row content>"`, `DETAIL:`/`HINT:` lines, quoted values). Validation
catch blocks likewise embedded raw `err.message`. Fixed by sanitizing child
stderr to exit code + error class only (first stderr line, tool/severity
prefixes stripped, cut before the first ':' or quote —
`summarizeChildStderr`), by making every validation catch detail
pg-code/name-only (post-#316 `bulk_archive` shape), and by leak tests that
inject sentinel row content through a fake `pg_restore`/throwing driver.
Related: manifest-style FILE LISTS need bare-filename constraints — a
tampered manifest `files[].name` like `../x` turns verify's stat/sha256 pass
into a path-traversal read oracle; schema-reject anything that is not a bare
filename.

### Review Questions

- Does the new surface spawn child processes, and is their stderr summarized
  to an error class instead of passed through to errors/receipts/logs?
- Are ALL catch paths on the surface code/name-only (never `err.message`),
  including validation loops, not just the happy-path receipt?
- Is there a leak test that injects sentinel row content via child stderr
  (CONTEXT/COPY/DETAIL lines) AND via a throwing driver, asserting the
  receipt carries neither the sentinel nor any quoted fragment?
- Do operator-supplied file lists (manifests, indexes) constrain names to
  bare filenames before any stat/read/hash uses them?

### [2026-07-22] Fourth occurrence — new MCP tool surface (source registry)

**Source:** PR #351 / issue #337 review swarm
**Scope:** `src/tools/source-registry.ts` (all five registry handlers)

RECURRING again: the new `register/list/update/remove/eligibility` MCP handlers
called the registry layer with no throw guard. `registerSource` re-throws any
non-23505 error and the other paths call `pool.query` bare, so a raw driver
error (message can carry `tags[]` row values on a failed write) would escape the
handler and be serialized by the MCP SDK. Fixed with a single `guarded(op, fn)`
wrapper per handler that returns ONE stable content-free `internal_error`
envelope (`ok:false, code:"internal_error", error:"source registry operation
failed"`) and logs only the operation name plus an allowlisted error code/name
(regex-bounded), never `err.message`. Typed expected results
(`namespace_denied`/`not_found`/`stale_revision`/`retired`/`conflict`/
`approval_state`) still flow through `errorResult` unchanged — the catch only
intercepts the throw path. Regression injects a non-23505 sentinel-bearing error
and asserts the response and all `console.*` log lines omit the sentinel and raw
message, and a paired test proves a typed denial is not collapsed to
`internal_error`.

Extra review question for this class:

- Does a content-free catch envelope PRESERVE typed expected result codes, or
  does it flatten every failure (including authorization denials the caller
  needs to see) into one opaque error?

## [2026-07-22] Digest shape is not proof of observed bytes

**Severity:** P2
**Source:** PR #351 terminal audit (issue #337)
**Status:** fixed-pre-merge

A public tool must not accept a caller-asserted digest as observed-content truth merely because it has SHA-256 shape. Keep source hashes behind a trusted collector path that hashes received bytes server-side; test that the public schema omits the field.

## [2026-07-22] Replay failure logs must exclude traceback, path, and identity fields

**Severity:** HIGH (P1)
**Source:** PR #355 / issue #344 Terra terminal audit
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`, `runtime.py`, scheduled replay/drain paths
**Status:** fixed-pre-merge

### Pattern

A scheduler's own telemetry can be content-free while the reused replay path
below it still leaks. PR #355 routed scheduled replay through the existing spool
drain, whose dispatch-failure warning used `exc_info=True` and structured fields
for the spool path, operation, and idempotency key; the outer drain catch also
logged a traceback. `OpenBrainError` can carry a redacted-but-private server body,
so background logs could expose replayed content even though the scheduler log
itself emitted only status/counts. The fix uses stable category/status fields
only and preserves retry, quarantine, disposition, and receipt behavior.

### Review Questions

- For every reused layer beneath a new content-free scheduler surface, do dispatch
  and outer catch blocks avoid `exc_info`, raw exception messages, response
  bodies, paths, keys, namespaces, and payload identifiers?
- Does the leak test inject distinct private sentinels into the exception body,
  spool path, and idempotency key, then inspect message, args, structured extras,
  traceback state, and stderr?
- Are retry counts, quarantine thresholds, `error_category`, dispositions, and
  receipts unchanged after logging is reduced?
- Are malformed-file corruption diagnostics adjudicated separately from provider
  dispatch failures rather than silently treated as the same surface?

## [2026-07-23] Read/approved eligibility is not write authority, and collectors must derive content/root server-side

**Severity:** HIGH
**Source:** PR #362 review swarm, 2026-07-23
**Scope:** approved-folder / approved-source collectors and any ingestion path
that accepts caller-attributed bodies for an approved root
**Status:** fixed-pre-merge

### Pattern

An approved (readable/eligible) source conferred write authority in the
collector: because a folder/root was on the approved list, the handler accepted
the caller's attributed CONTENT and the caller's asserted ROOT and persisted them
as the approved source's observation. That conflates two distinct grants — being
allowed to READ an approved source is not being allowed to WRITE arbitrary bodies
attributed to it. A caller could attribute forged content to an approved root, or
name a root they can read but should not be able to author into, and the server
would store it as trusted approved-source evidence.

The rule (a specialization of the digest/collector stance in the [2026-07-22]
digest-shape-is-not-proof entry): approved-folder collectors must DERIVE the
content and the root SERVER-SIDE from the trusted source — read the actual bytes
from the approved path server-side and compute identity/hash there — and must
NOT accept a caller-attributed body or a caller-asserted root as truth.
Eligibility gates WHICH sources may be collected; it never authorizes the caller
to supply the collected content. Keep the write authority derived from the
server's own read of the approved source, with the auth-derived namespace
predicate still applied.

See also the [2026-07-06] privileged-source-scope entry (source metadata is a
privilege boundary) and the [2026-07-22] digest-shape entry (a caller-asserted
digest is not observed-content truth — hash received bytes server-side).

### Review Questions

- Does an "approved" / "eligible" / "readable" status anywhere get treated as
  permission to WRITE caller-supplied content attributed to that source? Read
  eligibility and write authority are separate grants.
- Does an approved-folder/approved-source collector accept a caller-attributed
  body or a caller-asserted root/content-root, or does it derive both server-side
  from the trusted source before persisting?
- Is the stored content hashed/identified from bytes the SERVER read, not from a
  caller-provided body or digest?
- Is the auth-derived namespace predicate still applied on the write, so
  eligibility does not widen the namespace boundary?
- Is there a regression proving forged caller-attributed content for an approved
  root is rejected/ignored in favor of the server-derived content, failing on the
  pre-fix accept-caller-body path?
