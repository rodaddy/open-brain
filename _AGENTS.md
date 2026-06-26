# Open Brain Repo-Local Codex Flow

This file is the repo-local flow adapter for Codex. Read it after
`/Volumes/ThunderBolt/Development/AGENTS.md` and before doing repo work here.

## Checkout And Runtime Boundaries

- Do not assume one checkout represents every Open Brain state. Distinguish:
  - operator/workstation checkout: `/Volumes/ThunderBolt/Development/open-brain`
  - GitHub Actions runner checkout: runner-owned `_work/open-brain/open-brain`
  - live source checkout on the Open Brain host: `/Volumes/ThunderBolt/Development/open-brain`
  - live runtime: `/Volumes/ThunderBolt/open-brain/app`
- Before deploy, install, or hosted-proof advice, inspect the live host state.
  Do not infer live state only from local repo docs, local tests, or CI logs.
- Current repo docs name the hosted Open Brain target as core01
  (`10.71.1.21:3100`), launchd service `com.rico.open-brain`, runtime
  `/Volumes/ThunderBolt/open-brain/app`. If Rico says `base01` or another
  host name, resolve that exact name from hostmap or live SSH before acting.
- The live host may carry an operational branch or local deploy-script patch
  that is not yet in `origin/main`. Treat that as real state to reconcile, not
  as noise to overwrite.

## Required Startup

For non-trivial work:

1. Read `../AGENTS.md`, this file, and `AGENTS.md`.
2. Read the repo Open Brain lane before planning or acting:

   ```bash
   mcp2cli open-brain session_context --params '{"session_key":"repo:/Volumes/ThunderBolt/Development/open-brain","event_limit":20}'
   ```

   If `session_context` cannot find the lane, create/resume it with:

   ```bash
   mcp2cli open-brain session_start --params '{"session_key":"repo:/Volumes/ThunderBolt/Development/open-brain","project":"open-brain","agent":"codex","topic":"Open Brain repo-local workflow and deploy/runtime operating memory"}'
   ```

   Treat this lane as required repo operating memory. It contains corrections
   about checkout/runtime/runner boundaries and live proof requirements.
3. Read the relevant Development SOPs:
   - code changes: `_DOCS/CODING_STANDARDS.md`
   - git/PR/issues: `_DOCS/GIT_STANDARDS.md`
   - long-running/review/worker work: `_DOCS/AGENT_WORKFLOW.md`
   - deploy/host/runner work: `_DOCS/INFRASTRUCTURE_SOP.md`
4. Check `pwd`, `git status --short --branch`, and `git log --oneline -5`.
5. If the current checkout is dirty or on an unrelated branch, do implementation
   from a clean worktree under `/Volumes/ThunderBolt/_tmp`.

## Implementation Flow

- Do not code on `main`; create or use a focused branch.
- Keep fixes scoped to the issue. Do not fold deploy-script, workflow, or docs
  cleanup into a contract/API fix unless it is required to complete the issue.
- For MCP/public contract, transport, Python client, auth, namespace, or
  agent-facing changes, read `docs/downstream-rollout.md` before claiming done.
- For changes touching `docs/memory-contract.md`, `brain_answer`, lifecycle
  tools, eval fixtures, or Codex durable-memory instructions, read
  `docs/memory-contract.md`.
- Namespace isolation is a security boundary. Any ID-based read or mutation
  must rely on server-side auth-derived namespace predicates unless the role is
  intentionally global.

## Review And PR Flow

- Public contracts, auth/namespace behavior, deploy/runtime behavior, and
  Python package changes require review-swarm sizing before PR readiness.
- A PR that changes public contract behavior must include:
  - critical self-review receipt
  - validation commands and results
  - downstream rollout classification from `docs/downstream-rollout.md`
  - review-swarm or explicitly sized review evidence
- CI on PR is not deploy proof. PR deploy jobs skip by design unless the event is
  a push to `main`.

## Deploy Flow

- Standard repo command is `bun run deploy:core01`, which runs
  `scripts/core01-deploy-local.sh`.
- Standard runtime target from current repo docs:
  - runtime: `/Volumes/ThunderBolt/open-brain/app`
  - staging: `/Volumes/ThunderBolt/open-brain/app.next`
  - previous: `/Volumes/ThunderBolt/open-brain/app.previous`
  - env file: `/Users/rico/.config/open-brain/env`
  - qmd path: `/Volumes/ThunderBolt/qmd/open-brain-qmd.ts`
- Never hand-copy files into the runtime as the normal path. Use the repo-owned
  deploy script or explicitly document why the repo-owned path is unavailable.
- Before prescribing a deploy fix, inspect what is actually on the live host:
  source branch/status, deploy script content, env file existence, runtime
  files, launchd label, and `/health`.
- If GitHub Actions deploy fails, inspect whether the runner checkout has the
  same env/service assumptions as the live source checkout. Do not assume the
  runner has `/Users/rico/.config/open-brain/env` behavior unless verified.

## Hosted Proof Flow

Local tests are not enough for hosted Open Brain work.

For public contract/runtime changes, done requires live hosted proof such as:

```bash
mcp2cli open-brain get_contract --params '{}'
```

For issue #201-class work, specifically verify:

- `contract_version` is the expected version.
- `capabilities` includes the new tool when applicable.
- `tool_contracts.<tool_name>` exists with the expected input schema.
- `curl -fsS http://127.0.0.1:3100/health` passes on the host or the equivalent
  hosted health check passes from the controller machine.

After hosted proof, complete the applicable downstream rollout from
`docs/downstream-rollout.md` before closing the loop for Hermes/mcp2cli users.

## Dirty-State Flow

- This repo often has operational deploy branches. Do not overwrite or revert
  local dirty deploy-script changes unless Rico explicitly asks.
- If dirty state blocks work, classify each path as user-owned, agent-owned,
  generated, merged, obsolete, or next-branch work.
- For implementation unrelated to dirty state, create a clean temp worktree from
  current `origin/main` under `/Volumes/ThunderBolt/_tmp`.
- Clean only current-run temp artifacts that you created. Do not delete repo
  runtime/build artifacts or user-owned changes as cleanup.
