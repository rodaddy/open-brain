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
   - Merge alone does not deploy core01. After the candidate is on current
     `origin/main`, use the `CI` workflow's explicit `workflow_dispatch` on
     `main` with `deploy_core01=true`, or push a `v*` tag whose commit is
     reachable from `origin/main`. The deploy job waits for `check`,
     `db-integration`, and `python-package`, then runs
     `scripts/core01-deploy-local.sh` on the `[self-hosted, macOS, core01]`
     runner.
   - The script refuses unsupported refs, requires a manual-dispatch checkout to
     equal the current `origin/main` tip, stages the runtime, installs locked
     dependencies, bootstraps qmd when its script is present, runs migrations,
     swaps the runtime, restarts the `gui/<uid>/com.rico.open-brain` LaunchAgent (and, warn-only, `com.rico.open-brain-nats-worker`), and checks
     `http://127.0.0.1:3100/health`. After health passes it runs the Bun
     `search-all` test file. That test is regression coverage, not a live
     changed-tool smoke. On failed health the script restores the previous
     runtime and checks health again.
   - Therefore workflow success is necessary but not sufficient: after it
     succeeds, run a real hosted MCP call for every changed tool or behavior and
     record the returned contract/version evidence.

3. **rtech-mcps handoff**
   - Land any required registry, secret-map, or process documentation update in
     `rodaddy/rtech-mcps`.
   - Do this before treating mcp2cli refresh as complete. Direct hosted schema
     refresh is not a substitute for the rtech-mcps handoff.

4. **mcp2cli pull, cache verification, and generated skill refresh**
   - Have mcp2cli consume the registry-backed service definition.
   - Known limitation: `mcp2cli cache warm open-brain --force` is currently
     broken for a daemon-routed Open Brain service because `cache warm` asks the
     running daemon to discover through itself. The command times out with the
     deadlock tracked in `rodaddy/mcp2cli#60`. Do not make that known-broken
     daemon-routed command a rollout requirement.
   - A local, no-daemon refresh is supported only when the selected mcp2cli
     config can connect to Open Brain directly and supplies service-level auth
     (normally through supported secret refs). It does not consume the hosted
     daemon's per-identity `credentials.json`, and it refreshes only the cache
     under that local `HOME`/`MCP2CLI_CACHE_DIR`:

     ```bash
     MCP2CLI_NO_DAEMON=1 mcp2cli cache warm open-brain --force
     MCP2CLI_NO_DAEMON=1 mcp2cli schema open-brain.append_session_event --fresh
     MCP2CLI_NO_DAEMON=1 mcp2cli schema open-brain.agent_context_pack --fresh
     ```

   - Verify the hosted daemon separately with the rollout caller identity. The
     normal daemon path from mcp2cli PR #59 self-heals schema drift when it opens
     a new credentialed connection, clears the bare and credential-scoped cache
     keys, and repopulates from the live service. First clear only the caller's
     local cache, prove the daemon credential mapping exists without printing a
     value, then make the credentialed calls:

     ```bash
     ROLLOUT_IDENTITY=<authenticated-daemon-caller>
     mcp2cli daemon status
     mcp2cli credentials resolve "$ROLLOUT_IDENTITY" open-brain
     mcp2cli cache clear open-brain
     mcp2cli open-brain get_contract --params '{}'
     mcp2cli schema open-brain.append_session_event --fresh
     mcp2cli schema open-brain.agent_context_pack --fresh
     ```

   - If the daemon still serves a stale schema because an old pooled connection
     never reopened, the supported operator workaround while #60 remains open is
     to force a pool/cache reset, not to retry `cache warm`: an authenticated
     daemon admin may run `mcp2cli credentials reload` (which reloads the same
     credential file, clears affected bare/credential cache entries, and closes
     pooled connections), or the daemon owner may restart the daemon service.
     Coordinate either action because it interrupts pooled connections. Then
     rerun the credential-resolution, `get_contract`, and schema commands above.
   - Only after the daemon-routed schemas show the deployed v22/v2/v8 contract
     and a representative changed operation succeeds should generated skills be
     refreshed:

     ```bash
     mcp2cli generate-skills open-brain --conflict=merge
     ```

   - Open Brain's deterministic `schema_hash` excludes `generated_at`; record it
     with `contract_version` as the authoritative drift receipt alongside the
     refreshed tool schemas. Update the mcp2cli Open Brain generated skill/docs
     when changed behavior affects agent guidance.

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
     /opt/homebrew/bin/bash scripts/update.sh
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
- `interchange_profiles`
- `agent_memory_adapter`
- `receipt_contract`
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

## Optional Remote qmd Deep Lookup

Issue #137 does not add a remote qmd wrapper in this repo. The local disposition
is documented in `docs/roadmap/optional-qmd-deep-lookup.md`.

If a future PR implements a remote qmd wrapper, treat it as downstream-applicable
even if the Open Brain memory contract does not require qmd. That PR must
document:

- trusted host and caller identity;
- whether the wrapper lives in mcp2cli, qmd, or host automation;
- proof that Open Brain remains a consumer of curated qmd-derived facts, not the
  owner of raw remote qmd access, SSH/host routing, bridge credentials, or
  operator identity policy;
- non-fatal failure behavior for Hermes and other agents;
- proof that required repo facts remain available through Open Brain when qmd
  is unavailable;
- live canary evidence for both wrapper success and qmd-unavailable fallback.

## Memory Substrate Local Slice Classification

Issues #207 and #210 add draft-local `agent_memory_adapter` and
`receipt_contract` manifest fields plus documentation for
`openbrain.receipt.v1`. This is a public contract/documentation change and is
therefore downstream-applicable.

Local classification:

- Open Brain local verification applies.
- Python package contract-version pin applies.
- Hosted Open Brain deploy, mcp2cli cache refresh/generated skills, rtech-mcps
  handoff, rtech-hermes runtime changes, Hermes live rollout, and live agent
  canaries are deferred to #216 and must not run during the local-complete
  slice without explicit Rico approval.

Required #216 evidence later:

- Hosted `get_contract` returns the new `contract_version`,
  `agent_memory_adapter`, and `receipt_contract`.
- mcp2cli and generated skills consume the refreshed manifest.
- Hermes runtime/plugin compatibility is checked against the new adapter and
  receipt contract fields before live canaries.
