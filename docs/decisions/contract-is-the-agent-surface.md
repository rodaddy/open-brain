# `get_contract` is the agent's entire knowledge — and how rejections must speak

**What this is:** the standing rule that decides *where documentation goes* for
every agent-facing Open Brain capability, plus the one case that most depends
on it — the non-leaking `share_candidate` rejection contract.

**Source issues:**
- #172 — "get_contract must carry full per-field/per-tool help (not just
  generic schemas)" — closed 2026-06-19 (PR #171, squash `06d1560`)
- #176 — "Structured share_candidate rejection reason + bounded resend
  (contract-driven, so agents auto-pick-up)" — closed 2026-07-06

**Provenance of the core rule:** Rico, 2026-06-19, while designing #161.

**Status:** #172 implemented — `get_contract` carries per-field and per-tool
help across all tools (67 fields, was ~16); `tool_contracts` extracted to
`src/contract-schemas.ts`; `CONTRACT_VERSION` v4→v5.
#176's `reject_detail` is implemented in
[`src/sharing.ts`](../../src/sharing.ts) and
[`src/tools/append-session-event.ts`](../../src/tools/append-session-event.ts).

---

## Rule 1: the contract is the agent's only source of capability knowledge

The load-bearing fact, verbatim from #172:

> Hermes agents are **direct HTTP clients of the OB server** and are **100%
> contract-driven**: whatever `get_contract` returns is the agent's *entire*
> knowledge of what it can do and how. (rtech-hermes#89 built the
> contract-driven read surface; the plugin reshapes
> `tool_contracts[*].input_schema` into the LLM tool definitions.) So if the
> "how/when/why" of a capability isn't in the contract, the agent cannot know
> it.

### The consequence that governs every future change

Help that lives in code comments, in `docs/`, or in a skill file is
**unreachable by a contract-driven agent**. If a capability has a non-obvious
"when to use this / what the server does / what gets refused", that text must
be in `get_contract` or it does not exist as far as the agent is concerned.

This is why a bare schema is insufficient. The gap #172 named:

> `tool_contracts[name].input_schema`: bare field schemas — `{type, required,
> minLength, max, values}`. **Almost no per-field descriptions.** [...] So a
> contract-driven agent knows the *shape* of each call but not *how to use it
> well*.

### Nested fields must survive the client-side reshape

> Ensure the rtech-hermes `contract_schema_to_parameters` reshaper **carries
> descriptions through** to the LLM tool definitions (coordinate — if the
> reshaper drops descriptions, the help never reaches the agent). NESTED object
> fields (e.g. metadata.fields.share_candidate) must also survive the reshape.

A description that the reshaper flattens away is the same as no description.
Nested `metadata.fields.*` is the case that actually breaks, because reshapers
tend to walk only the top level.

### Acceptance bar (verbatim)

> - Every agent-facing tool's params carry usage descriptions in `get_contract`.
> - A contract-driven agent, given only the contract, can correctly use each
>   call (descriptions are self-sufficient).
> - rtech-hermes reshaper passes descriptions (and nested fields) through to the
>   LLM surface — verified live.
> - Contract version bumped; TS + Python parity green.

"Descriptions are self-sufficient" is the test: read *only* the contract and
ask whether the call can be made correctly.

---

## Rule 2: rejection must be actionable without re-leaking

### The problem

When an agent nominates a memory for shared-kb via `append_session_event` with
`metadata.share_candidate=true`, the server adjudicates synchronously and may
reject. The bare category was not actionable:

> Result: the useful signal is lost. "Deployed the new role with key `AKIA...`"
> gets rejected for the secret, and the whole memory is dropped from shared
> truth — when a sanitized "deployed the new IAM role" would have been
> shareable and valuable.

### Why this is a server issue, not a client one

> The client cannot know *which span* tripped the server's classifier — only
> the server's classifier knows. So the structured reason must come **from the
> server**.

### The structured, non-leaking rejection

```jsonc
{
  "event_id": "...",
  "share_candidate_rejected": "reject-secret",   // existing category (keep)
  "reject_detail": {
    "category": "reject-secret",
    "matched_kind": "aws_secret_access_key",     // WHICH pattern/classifier fired (a label, NOT the value)
    "span_count": 1,                              // how many offending spans (no content)
    "redaction_hint": "Remove the credential and re-nominate; e.g. describe the action, not the secret.",
    "resubmittable": true                         // is a sanitized resend allowed?
  }
}
```

Rules, verbatim:

> - **Never echo the offending content** (no span text, no value) — only a
>   `matched_kind` label + count + a generic hint. Returning the secret in the
>   rejection would re-leak it.
> - `matched_kind` should map to the secret/private classifier categories (the
>   regex pattern name from `sharing.ts` SECRET_PATTERNS, or `private-tag` /
>   `private-flag` for reject-private).

**Label, never value.** The tempting wrong answer is to return the offending
span so the agent can fix it precisely. That turns the rejection response into
a secret-exfiltration channel: an agent could submit content specifically to
learn what the classifier extracted.

### Bounded resubmission — anti-grinding

> A resent `append_session_event` for the same `event_id`/content-hash that
> still trips the filter must NOT loop unbounded. Define a server-side resubmit
> policy (e.g. `resubmittable: false` after N rejections on the same
> content-hash, or a `resubmit_token` that expires) so the agent can't grind
> against the filter. Consider returning `resubmit_after` / attempt counters so
> the agent self-limits.

Without a bound, an agent can binary-search the classifier by repeated
submission — recovering the boundary the `matched_kind` label was designed to
hide.

**Ambiguity, recorded:** #176 offers the N-rejections-per-content-hash counter
and the expiring `resubmit_token` as alternatives (`e.g.`) and does not pick
one.

### Express it in the contract — the propagation argument

This is Rule 1 applied:

> Add the `reject_detail` shape and the resubmit policy to the **`get_contract`
> manifest** [...] Reason: rtech-hermes#88 made the agent tool surface
> **contract-driven** [...] If the resend fields and reject semantics are in
> the contract, the agent gets them automatically. If they're only in
> code/docs, the client needs a manual change each time.

### Known open item

The final DoD bullet in #176 is marked optional and larger, and is recorded
here as not-done:

> reject-private gains enough specificity to be actionable (today it's
> tag-only; a content-aware private classifier would make `matched_kind`
> meaningful for private data too — optional, larger).

### Client-side redaction is a separate loss path

#176 flags, without resolving, that the bigger silent loss is upstream:

> the bigger silent-loss is **client redaction turning content into
> `[redacted]`** — that path never reaches the server at all. If you want the
> agent to be able to recover from client-side redaction too, that's a
> rtech-hermes-side companion [...] note it but it's separate from this server
> issue.

## Related

- [`../sme/adversarial.md`](../sme/adversarial.md) — reviewer lane that checks
  the never-echo rule.
- [`../downstream-rollout.md`](../downstream-rollout.md) — contract changes are
  contract-changing by definition and carry the rollout gate.
- [`../compatibility-matrix.md`](../compatibility-matrix.md) — TS/Python
  contract-version parity.
