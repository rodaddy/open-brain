# Downstream Rollout Contract

Open Brain changes are not complete just because this repository passes tests
or the hosted server answers locally. Open Brain is a runtime dependency for
MCP clients, generated skills, and Hermes agents. Any PR that changes a public
contract must classify and, when applicable, complete the downstream rollout.

## When This Applies

Run this gate for any change that touches:

- MCP tool names, input schemas, output shapes, annotations, auth, namespace
  semantics, or error envelopes.
- Streamable HTTP behavior, session initialization, SSE framing, session TTL,
  or transport retry behavior.
- Database migrations that alter externally visible behavior.
- `python/openbrain-memory` client behavior or package exports.
- Generated skill content under `skill/` or agent-facing usage guidance.
- Anything that a Hermes agent, mcp2cli, or another MCP consumer may call
  directly.

If none of those apply, say so explicitly in the PR and release notes.

## Required Order

1. **Open Brain local verification**
   - Run the relevant server tests, typecheck, migrations, and Python package
     tests for the touched surface.
   - Use isolated temp homes/config/cache for mcp2cli tests. Do not mutate the
     operator's real local `~/.config/mcp2cli` as a test fixture.

2. **Open Brain hosted verification**
   - Deploy/pull Open Brain to the hosted service at `10.71.1.21` when the
     change is runtime-facing.
   - Run a focused live smoke against the changed tool or behavior.

3. **rtech-mcps handoff**
   - Land any required registry, secret-map, or process documentation update in
     `rodaddy/rtech-mcps`.
   - Do this before treating mcp2cli refresh as complete. Direct hosted schema
     refresh is not a substitute for the rtech-mcps handoff.

4. **mcp2cli pull and generated skill refresh**
   - Have mcp2cli consume the registry-backed service definition.
   - Run:

     ```bash
     mcp2cli cache diff open-brain
     mcp2cli cache warm open-brain
     mcp2cli generate-skills open-brain --conflict=merge
     ```

   - Verify the hosted daemon sees the updated tools/schemas and can call a
     representative changed operation.
   - Update the mcp2cli Open Brain skill generation docs/skill when the new
     behavior changes user-facing agent guidance.

5. **rtech-hermes Python runtime/plugin check**
   - Check whether the direct Hermes Open Brain path needs changes:
     - `packages/rtech-hermes-runtime/src/rtech_hermes_runtime/openbrain/`
     - `plugins/memory/openbrain/`
     - `tests/plugins/memory/`
     - `packages/rtech-hermes-runtime/tests/test_openbrain_*`
   - Add or update fake-transport tests for call shapes, namespace/identity
     behavior, error redaction, HTTP/mcp2cli transport behavior, and provider
     load when applicable.
   - Merge the `rtech-hermes` PR before claiming agent readiness.

6. **Hermes live rollout**
   - Do not use TN01 / `10.71.1.11` as the control point for this workflow.
   - SSH to `10.71.1.71` as Rico or `bilby`.
   - From there, update the fs collab checkout and run the agent update path:

     ```bash
     cd /mnt/collab/agent-backups/rtech-hermes
     git pull --ff-only origin main
     bash scripts/update.sh
     ```

   - Run this for each opted-in agent/profile that should receive the Open
     Brain behavior.

7. **Live agent canaries**
   - Verify the agent venv imports the updated `rtech-hermes-runtime`.
   - Verify `openbrain` loads through the Hermes memory registry.
   - Verify a representative Open Brain read/write through the agent's
     configured transport.
   - Start a fresh Hermes session or restart the gateway when plugin/tool
     schemas are snapshotted at session start.
   - Check that no `openbrain_spool.jsonl` failures remain for the canary.

## Definition Of Done

A contract-changing Open Brain PR is done only when all applicable downstream
steps above are either:

- completed with evidence in the PR, issue, or release note; or
- explicitly marked not applicable with a short reason.

Do not close the issue or report the rollout done after only local tests,
hosted Open Brain tests, or mcp2cli schema checks when Hermes agent behavior is
in scope.

## Contract Manifest

Downstream runtimes must not infer Open Brain compatibility from memory,
generated docs, or partial tool discovery. Open Brain exposes a canonical
contract manifest through `get_contract`.

The manifest includes:

- `contract_version`
- `contract_scope`
- `schema_version`
- `schema_hash`
- `generated_at`
- `min_client_versions`
- `compatible_client_ranges`
- `transport`
- `capabilities`
- `tool_contracts`

`contract_scope` is `required_openbrain_memory_contract`. The manifest is the
canonical compatibility contract for required memory/session/repo-fact behavior
that Hermes, mcp2cli, and generated Open Brain skills must depend on. It is not
yet a typed schema export for every optional Open Brain MCP tool.

`schema_hash` is deterministic and excludes `generated_at`. It includes the
required capability list, required tool contracts, repo-fact metadata contract,
and repo-fact validation semantics. Downstream clients such as `rtech-hermes`
should validate `contract_version`, `contract_scope`, `schema_hash`, minimum
client version, compatible range, and required capabilities at startup. In
required memory mode, incompatible or unreachable contracts must fail closed.

## qmd-Derived Repo Facts

qmd runs with Open Brain on core01 (`10.71.1.21`) and acts as the
repo-knowledge compiler. Open Brain is the shared runtime distribution layer
for agents that cannot run qmd.
Required repo knowledge is promoted into Open Brain with `upsert_repo_fact` and
read with `list_repo_facts`.

Repo facts are curated operating knowledge plus source pointers. They are not
raw qmd/code chunks. Each fact is stored as an `ob_entities` graph entity with
`entity_type = 'repo_fact'`, a deterministic `canonical_id`, and metadata that
includes:

- `source_system: "qmd"`
- `repo`
- `collection`
- `path`
- `symbol` or `subject`
- `fact_type`
- `fact`
- `source_commit`
- `source_url`
- `verified_at`
- `confidence`
- `staleness_policy`
- `refresh_hint`

`source_url` must be an HTTPS GitHub source URL with no embedded credentials.
For `github.com`, it must match
`/<owner>/<repo>/blob/<source_commit>/<repo_relative_path>`. For
`raw.githubusercontent.com`, it must match
`/<owner>/<repo>/<source_commit>/<repo_relative_path>`. The URL repo segment
must match the repo fact's `repo` slug, and the source commit must be a path
segment, not a query string or fragment.

Promotion rule: if distributed agents are expected to rely on a qmd-derived repo
fact during normal work, that fact must be present in Open Brain. Remote qmd can
exist as a best-effort deep lookup path, but it is not the memory contract.
