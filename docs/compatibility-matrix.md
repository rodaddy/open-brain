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
| `mcp2cli` | Codex durable memory (hosted daemon ct216), cc boxes, generated skills | 0.3.6 | `>=0.3.6 <1.0.0` | `get_contract` manifest; `X-OB-Contract` header forwarding on MCP paths |
| `rtech-hermes-runtime` | Hermes live agents (Nagatha/Bilby/Skippy) | 0.1.0 | `>=0.1.0 <1.0.0` | `get_contract` manifest; fleet pins per `docs/downstream-rollout.md` |

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
| contract-declaration | implemented | pending (#312) |
| session-lifecycle | implemented | pending (#312) |
| exact-scope-proof | implemented | pending (#312) |
| spool-backpressure | implemented | pending (#312) |
| redact-before-persist | implemented | pending (#312) |
| auto-drain-allowlist | implemented | pending (#312) |
| receipt-shapes | implemented | runtime-specific (bounded TS `error_category` enum is Development-adapter-owned) |

The 12 fixtures in `contracts/memory/` are the runtime-neutral behavioral spec
for both columns; `python/openbrain-memory/tests/test_contract_fixtures.py` is
the Python fixture runner. The TS column flips to implemented via #312's
fixture runner under `clients/ts/`.

## Upgrade and deprecation policy

- Contract bumps ship contract-first: server declares the new version, clients
  validate on `get_contract` before lifecycle operations, and the rollout order
  in `docs/downstream-rollout.md` (steps 3-7) is the required fleet sequence.
- `min_client_versions` only rises in a PR that also updates the parity
  fixtures (`contract-declaration` fixture pins the live version), so CI fails
  on any one-sided bump.
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
