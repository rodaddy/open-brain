# Privilege Isolation / closed-brain deployments

**What this is:** the product model behind the source-reference and isolation
metadata in [`src/source-refs.ts`](../../src/source-refs.ts). It explains what
`client_id`, `matter_id`, `access_group`, `role_policy`, `ethical_wall`, and
`legal_hold` are *for*, and why matter-scoped retrieval must fail closed.

**Source issue:** #118 — "roadmap: file references for Privilege Isolation /
closed-brain deployments"
**Decided / closed:** 2026-07-06 (closed by merged PR #255)
**Status:** schema slice implemented (`src/source-refs.ts`). The full vertical
(ingestion, DMS integration, answer-citation surface, audit log) is roadmap.

> Working name: **Privilege Isolation** for the closed-brain deployment model.

Before this file, "Privilege Isolation" existed nowhere in the working tree —
the only mention, in `docs/plan-3f-open-issues.md`, is corrupted to
`#118 n source refs` (the words "Privilege Isolatio" were eaten). A reader of
`src/source-refs.ts` saw legal-domain fields with no explanation.

---

## The decision

Add first-class file/document references to Open Brain for future **Privilege
Isolation** / **closed-brain** deployments, especially **law-client
deployments where every memory-derived answer needs matter-scoped source
grounding**.

This is explicitly *not* part of the Codex brain rollout. Quoting #118:

> This is not part of the current Codex brain rollout. It is a future vertical
> capability inspired by gbrain-style file refs, adapted for privileged/legal
> workflows.

## Why (the rationale that gets lost)

Open Brain can already store durable operational memory and cite memory
entries. Legal/client deployments need a stronger source model. From the issue,
verbatim:

> - answers should cite the underlying document/file, not only the distilled
>   memory row
> - retrieval must respect client, matter, team, and ethical-wall boundaries
> - audit trails must show which source files supported which answer
> - file/document provenance is a product differentiator for law clients

The last bullet is the commercial reason the isolation fields exist at all.
The ethical-wall marker is not a generic ACL nicety — it is a legal-practice
requirement.

## Source references

Structured source refs attach to memories and answer evidence. Verbatim list:

> - document/file id
> - original path or DMS id
> - client id
> - matter id
> - page, paragraph, section, or text-span locator where available
> - source hash and ingestion timestamp
> - source title/label safe for display
> - optional excerpt bounds for citation rendering

## Privilege / isolation scope

> Every source ref and derived memory must carry enforceable isolation
> metadata:
>
> - client
> - matter
> - workspace or tenant
> - attorney/team access group
> - role/access policy
> - ethical-wall marker when relevant
> - retention/legal-hold metadata if needed

## Retrieval and answering

> - `search_brain` / `search_all` / future answer tools should support
>   source-ref filters.
> - Matter-scoped retrieval must fail closed when scope is missing or
>   unauthorized.
> - Answer synthesis should cite source refs alongside memory refs.
> - Cross-client or cross-matter retrieval should be impossible unless
>   explicitly authorized by policy.

**Fail closed** is the load-bearing rule. A missing scope is not "search
everything"; it is a refusal. `src/source-refs.ts` enforces this at the schema
edge — `source_scope` rejects an empty scope object with
`"source_scope requires client_id, matter_id, document_id, path, or dms_id"`
rather than degrading to an unscoped query.

## Auditability

The model must record enough metadata to answer these four questions:

> - which source files were ingested
> - which memories came from which files/spans
> - which user/session accessed which source-backed evidence
> - which answer cited which source refs

## Acceptance criteria (as written)

> - A memory entry can store one or more structured source refs.
> - A source ref can identify a file/document plus page/section/span when
>   available.
> - Retrieval can filter by client/matter/source scope.
> - Namespace/client/matter isolation is enforced server-side, not only in
>   clients.
> - Answer output can include file refs in citations.
> - Tests prove cross-client and cross-matter leakage fails closed.
> - Docs explain the Privilege Isolation / closed-brain deployment model and
>   how it differs from ordinary Open Brain operational memory.

The last criterion is what this file discharges.

## Out of scope for the first slice

> - Full legal DMS integration.
> - OCR/pipeline implementation.
> - Automatic document classification.
> - Replacing the current Codex durable-memory rollout.

## Ambiguity, recorded rather than resolved

The issue notes its own future split and does not decide it:

> This should probably be split later into schema, ingestion, retrieval,
> answer-citation, and audit-log issues when it moves from roadmap to
> implementation.

The issue does not define how the ethical-wall marker interacts with the
existing namespace boundary (see [identity-boundary.md](../identity-boundary.md)),
nor whether `tenant` and Open Brain `namespace` are the same axis. Both are
open.

## Related

- [`../identity-boundary.md`](../identity-boundary.md) — the namespace/write
  boundary that server-side isolation builds on.
- [`../prior-art/`](../prior-art/) — gbrain file refs are the named inspiration;
  borrowed ideas require attribution.
