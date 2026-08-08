---
lane: domain-backend
order: 20
---
## [2026-07-22] A server-owned maintenance identity must satisfy the shared-kb promoter convention to write shared-kb

**Severity:** P1
**Source:** PR #358 review swarm; issue #346 (MAINT-4)
**Scope:** `src/maintenance-bootstrap.ts` `MAINTENANCE_GRAPH_AUTH`, `src/namespace-policy.ts` `canWriteNamespace` / `isPromoterIdentity`
**Status:** fixed

### Pattern

`canWriteNamespace` gates writes to the shared namespace (`shared-kb`) behind
`isPromoterIdentity`, which grants ONLY: `role === "promoter"`, or an
`admin`/`ob-admin` token whose `tokenClientId ?? clientId` is in
`PROMOTER_CLIENT_IDS` (`openbrain-promoter`, `hermes-promoter`). A global
`ob-admin` alone does NOT clear this gate — being ob-admin makes an identity
globally writable *everywhere except* shared-kb.

`MAINTENANCE_GRAPH_AUTH` shipped as `{ role: "ob-admin", clientId:
"open-brain-maintenance" }`. It could write every per-tenant namespace, so every
handler unit test (which uses per-tenant namespaces) passed — but a claimed
`graph.derive` job whose payload namespace was `shared-kb` failed
`canWriteNamespace` inside the handler and threw `GraphDerivationTerminalError`,
so the queue *terminal-dead-lettered* it (not a retryable backoff). Shared-kb
graph derivation was silently, permanently broken with green tests.

The fix is the smallest existing-policy-compatible one: add
`tokenClientId: "openbrain-promoter"` to the identity so it satisfies the
EXISTING promoter convention. `clientId` stays the maintenance label used for
logging/provenance; only `isPromoterIdentity` reads `tokenClientId`. This grants
the shared-kb write capability narrowly — it does NOT weaken `canWriteNamespace`
globally and adds no bypass: the per-job namespace check, the source-snapshot
guard, and frozen-namespace rejection (`collab`) all still apply to this
identity.

### Review Questions

- Does any server-owned/maintenance identity that may derive/promote/write into
  `shared-kb` actually pass `isPromoterIdentity` (promoter role, or
  `tokenClientId ?? clientId` in `PROMOTER_CLIENT_IDS`)? Being `ob-admin` is not
  enough for shared-kb.
- Do the handler/authorization tests exercise a `shared-kb` (canonical AND
  physical) job through the PRODUCTION-composed identity, not just synthetic
  per-tenant namespaces that mask the shared-kb gate?
- Does the shared-kb grant stay scoped: is the same identity still rejected
  pre-read for frozen namespaces, and does it still fail closed on a missing job
  namespace and honor the source-snapshot guard?
- Would the regression fail on the pre-fix identity with the exact "shared-kb
  writes require the openbrain-promoter or hermes-promoter service identity"
  terminal reason?
