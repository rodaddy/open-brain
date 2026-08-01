# `ob-admin` vs `promoter`: two identities, deliberately separated

**What this is:** why Open Brain has both a break-glass admin identity and a
least-privilege promotion identity, and specifically **which privileges
`promoter` is denied and why**. [`../GLOSSARY.md`](../GLOSSARY.md) names
`ob-admin` as "break-glass" in one clause; the capability boundary itself was
written nowhere.

**Source issue:** #168 — "Rename n8n role -> ob-admin (unused admin-equivalent;
honest server-admin identity)"
**Decided / closed:** 2026-07-05
**Related:** #159 / #147 (the `promoter` role)
**Provenance:** surfaced 2026-06-19 while building #159; Rico asked what the
n8n role was. Confirmed unused + admin-equivalent.

**Status:** implemented, and the deprecation completed. Both roles are live in
[`src/auth.ts`](../../src/auth.ts) and
[`src/permissions.ts`](../../src/permissions.ts). **The `n8n` alias no longer
exists** — it was removed, not merely deprecated (see "Superseded" below).

---

## Why this matters

The obvious future change is "just give the promoter admin, it's easier." The
denial list below is the reason not to, and it existed only in this issue.

## The separation

Verbatim from #168:

> - `promoter` (#159): least-privilege automation identity — scoped to
>   promotion (lane→shared-kb pipeline). RWD on curation tables, RO projects,
>   write/read across namespaces, but NOT curate-with-delete or `"all"`.
> - `ob-admin` (this issue): full admin break-glass for HUMAN server-side
>   surgery (deletions, manual user promotions). Effectively today's n8n
>   capability, honestly named.

### What `promoter` is denied

- **curate-with-delete** — promotion archives and demotes; it does not
  destroy curated content.
- **the `"all"` namespace keyword** — a promotion job operates on named
  namespaces. `"all"` is a blast radius no automation needs.
- **projects write** (RO only) — promotion never authors projects.

`promoter` *does* hold cross-namespace read and write, because the lane→shared-kb
pipeline is cross-namespace by definition. That is the one broad privilege it
needs, and the denials above are what keep it from being admin-equivalent
anyway.

### What `ob-admin` is for

Full RWD on every table, identical to `admin`. It is for a **human** doing
server-side surgery — deletions, manual user promotions. It is not an
automation identity and should not be wired into one.

## The evidence that motivated the rename

Verbatim, verified 2026-06-19:

> - **Capability:** `n8n` has `RWD` on every table in `PERMISSIONS` —
>   **identical to `admin`** — and is paired with `admin` in every privileged
>   gate (shared-kb write, promote, scan, curate-with-delete, cross-namespace
>   read, `"all"` keyword, X-Namespace delegation, rest-promotion).
> - **Usage:** ZERO. No rows ever `created_by = 'n8n'` (thoughts/decisions/
>   entities all 0). Not referenced in the n8n skill, no n8n workflow calls
>   Open Brain, `AUTH_TOKEN_N8N` is not used as a client anywhere, no n8n-role
>   auth in server logs.
> - So it's full-power dead weight with a name implying it's for n8n.io
>   automations — which it is not used for.

The lesson generalizes: a credential named for a system that does not use it is
worse than an unnamed one, because the name suppresses the question "should
this exist?"

## The migration choice, and how it ended

The conservative plan (Rico's call):

> Preferred end-state: **add `ob-admin` as the canonical role name, keep `n8n`
> as a deprecated alias** for safety, remove `n8n` in a later cleanup.
> (Conservative — avoids a hard breaking change to a security primitive.)

**Superseded:** the later cleanup happened. `n8n` is not in `VALID_ROLES` and
`AUTH_TOKEN_N8N` is not in `ROLE_ENV_KEYS` in `src/auth.ts`; `PERMISSIONS` has
no `n8n` entry. The only trace is the explanatory comment on `"ob-admin"` in
`src/permissions.ts`. The deprecated-alias step was a transition state, not the
end state.

## Sequencing note (historical)

> **After #159 (promoter role) is merged.** Do NOT fold into the #159 PR —
> separate security-role change with its own tests. Lower urgency since n8n is
> unused (no active exposure).

## Related

- [`../identity-boundary.md`](../identity-boundary.md) — namespace write
  authority; note that role and namespace authority are enforced separately
  (`namespace-policy.isPromoterIdentity`).
- [`shared-kb-canonical-namespace.md`](./shared-kb-canonical-namespace.md) —
  the pipeline `promoter` was scoped for.
