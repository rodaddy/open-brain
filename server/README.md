# Server rewrite scaffold

**LAW-0 state: WRITTEN — scaffold only.**

This tree serves no traffic, opens no socket, creates no database pool, registers
no MCP tool, and is not referenced by `package.json` startup scripts. The running
application remains `src/`.

The root is named `server/`, not `src2/`, because it names the owned application
boundary rather than encoding a temporary version number. The final cutover can
replace the package entrypoint without renaming the new application's internals.

## Boundaries

- `application/` — composition and lifecycle ordering only.
- `config/` — environment parsing and typed startup configuration only.
- `contracts/` — frozen public contract declarations only.
- `db/` — pool, transaction, repository, and append-only migration ownership.
- `domain/` — behavior rules independent of transport and persistence.
- `observability/` — logging, correlation, and safe error reporting.
- `security/` — authentication, role permissions, and namespace policy.
- `tools/` — MCP schemas, registration, and handlers composed from domain ports.
- `transport/` — HTTP/MCP sessions, health, and worker-proxy behavior.

Each module currently exports only an ownership declaration. Runtime code arrives
through the charter's strangler phases after its contract tests exist.

## Contract parity wiring

`contracts/server-contract-providers.ts` exposes the running `src/` declaration
and this scaffold's frozen declaration to `contracts/check-parity.ts`. The parity
gate checks both provider identities against the same reviewed contract fixture.
This proves wiring and declaration parity only; it does not claim tool behavior
exists in `server/`.
