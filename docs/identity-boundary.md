# Open Brain Identity Boundary

`shared-kb` is a shared knowledge namespace, not an identity. Bearer tokens
identify the caller, and namespace policy decides where that caller may read or
write.

## Canonical identities

| Identity | Kind | Expected role | Purpose |
| --- | --- | --- | --- |
| `rico` | person | `admin` | Rico as a human operator across Codex, Claude, and local hosts. |
| `kevin` | person | `readonly` or scoped user role | Kevin as a human collaborator, not an agent lane. |
| `bilby` | agent | `agent` | Hermes agent lane identity. |
| `skippy` | agent | `agent` | Hermes agent lane identity. |
| `openbrain-promoter` | service | `n8n` or `admin` | Approved Open Brain promotion service for shared truth writes. |
| `hermes-promoter` | service | `n8n` or `admin` | Approved Hermes-side promotion service for shared truth writes. |

Environment-safe per-user token names use underscores and are normalized to
hyphenated identities. For example, `AUTH_TOKEN_USER_OPENBRAIN_PROMOTER` maps
to `openbrain-promoter`.

## Write boundary

Normal agent identities write their own lane namespace only. A `bilby` token can
write `bilby`; a `skippy` token can write `skippy`. They may not direct-write
`shared-kb`, another agent lane, or a person namespace.

`shared-kb` writes require an explicit promoter service identity:
`openbrain-promoter` or `hermes-promoter`. The promoter path must include
provenance describing the source namespace, source table/id, source identity
when known, promotion actor, reason, confidence when available, and timestamp.

`X-Namespace` is delegation context for trusted `admin` and `n8n` callers. It is
not shared-write authority by itself. A non-promoter `admin` token delegated with
`X-Namespace: shared-kb` still cannot write shared truth.

## Read boundary

Normal agents read their own lane plus the canonical shared namespace exposed by
server read policy. During the `collab` to `shared-kb` transition, legacy
fallback is server-owned. Clients should request `shared-kb`, not manually query
both namespaces.

## Host identity

Host, runtime, project, Discord channel, or thread identity belongs in metadata
and provenance. It must not replace the bearer-token person, agent, or promoter
identity that defines the namespace boundary.
