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
   - From there, update the collab checkout and run the agent update path:

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
