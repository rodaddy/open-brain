# Client Compatibility Matrix

Human-readable rendering of the machine-enforced compatibility data. The
authoritative sources are `src/contract.ts` (`min_client_versions`,
`compatible_client_ranges`) and `contracts/memory/parity-manifest.json`; if
this page and those files disagree, the machine data wins. Update this page in
the same PR whenever either source changes (the contract-parity pre-push hook
watches `contracts/**`; treat `docs/compatibility-matrix.md` as part of that
change set by convention).

Live contract: `2026-07-17.memory-tools.v22` (`src/contract.ts`
`CONTRACT_VERSION`), enforced end-to-end — clients validate the manifest before
lifecycle operations, CI's `contract-parity` job binds in-tree client
declarations to it, and the deploy job cannot run without that gate passing.

## Supported client versions

| Client surface | Runtime it serves | Minimum | Supported range | Enforced where |
|---|---|---|---|---|
| `openbrain-memory` (Python) | Claude direct provider (Development `_ob` adapter), Hermes Python runtime | 0.1.8 | `>=0.1.8 <1.0.0` | `get_contract` manifest + client `validate_required_memory_contract`; server `X-OB-Contract` tripwire |
| `mcp2cli` | Codex durable memory (hosted daemon), cc boxes, generated skills | 0.3.6 | `>=0.3.6 <1.0.0` | `get_contract` manifest; `X-OB-Contract` header forwarding is expected from mcp2cli ≥0.3.6 (owned by the mcp2cli repo; verified live against core01 2026-07-21) |
| `rtech-hermes-runtime` | Hermes live agents (inventory owned by the rtech-hermes repo) | 0.1.0 | `>=0.1.0 <1.0.0` | `get_contract` manifest; fleet pins per `docs/downstream-rollout.md` |

Codex note: Codex is not itself a versioned Open Brain client. It reaches Open
Brain through `mcp2cli`, which is the versioned, range-checked surface above.
There is no separately negotiated Codex contract; Codex compatibility is
exactly mcp2cli compatibility plus the session-lifecycle directives in
`docs/memory-contract.md`.

## Capability parity (Python client vs TypeScript peer)

From `contracts/memory/parity-manifest.json` (fixture-backed, CI-gated by
`contracts/check-parity.ts`):

| Capability | Python | TypeScript |
|---|---|---|
| contract-declaration | implemented | implemented (#312) |
| session-lifecycle | implemented | implemented (#312) |
| exact-scope-proof | implemented | implemented (#312) |
| spool-backpressure | implemented | implemented (#312) |
| redact-before-persist | implemented | implemented (#312) |
| auto-drain-allowlist | implemented | implemented (#312) |
| drain-receipts | implemented | implemented (#312) |
| receipt-shapes | implemented | runtime-specific (bounded TS `error_category` enum is owned by the TS client; the agent-receipt half stays Python-only) |

The 13 fixtures in `contracts/memory/` are the runtime-neutral behavioral spec
for both columns; `python/openbrain-memory/tests/test_contract_fixtures.py` is
the Python fixture runner and
`clients/ts/tests/contract-fixtures.test.ts` is the TypeScript fixture runner
(#312, `clients/ts/`). The TS client's intentional runtime differences (no
mcp2cli fallback, no cross-process spool lock, no client-version range
validation until the server manifest declares a TS entry) are listed in
`clients/ts/README.md`.

## Upgrade and deprecation policy

- Contract bumps ship contract-first: server declares the new version, clients
  validate on `get_contract` before lifecycle operations, and the rollout order
  in `docs/downstream-rollout.md` (steps 3-7) is the required fleet sequence.
- `min_client_versions` only rises in a PR that also updates the parity
  fixtures: the contract-declaration fixture pins `schema_hash`, and
  `min_client_versions` is inside the hashed payload (only
  `realtime_transport` is excluded from `schema_hash`), so any one-sided bump
  changes the hash and fails CI.
- Deprecating a client version = raising its minimum in `src/contract.ts`.
  There is no silent window: older clients fail contract validation loudly at
  session start, and the server logs drifted `X-OB-Contract` declarations.

## What this matrix does not claim

- No executable cross-runtime handoff tests exist yet (Claude→Codex,
  Codex→Claude continuity on the same lane). Parity fixtures prove
  same-contract behavior per runtime, not cross-runtime handoff. Tracked as
  future work under the P2 program (#299 closure notes).
- No mixed-version stateful upgrade/rollback fixtures; upgrade compatibility
  is covered operationally by `docs/downstream-rollout.md` plus the
  backup/restore program (#298).
