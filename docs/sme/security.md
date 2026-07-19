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

### Review Questions

- Are live writes preserving caller content?
- Are logs/errors redacted separately?
- Is spool data protected without pretending lossy redacted data is exact replay?
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
