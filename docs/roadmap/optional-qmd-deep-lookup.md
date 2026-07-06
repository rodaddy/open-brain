# Optional qmd Deep Lookup

Issue: #137
Decision date: 2026-07-06
Disposition: defer implementation; keep qmd optional and non-fatal.

## Decision

Do not build a remote qmd deep-lookup wrapper in the local Open Brain issue
burn-down. The required memory path is Open Brain plus curated qmd-derived repo
facts. A remote qmd wrapper may be added later as an operator-approved,
best-effort escape hatch, but it is not part of the Open Brain or Hermes memory
contract.

## Boundary

Open Brain owns:

- durable memory rows, lanes, entities, links, and session checkpoints;
- `upsert_repo_fact` and `list_repo_facts` for curated qmd-derived facts;
- `search_all` federation when qmd is locally available to the Open Brain
  runtime;
- citation-safe result metadata.

Open Brain does not own:

- exposing raw remote qmd access to arbitrary agents;
- SSH or host routing to the qmd machine;
- mcp2cli qmd bridge credentials or operator identity policy;
- Hermes startup, recall, writes, current memory, or repo-fact correctness
  depending on qmd availability.

## Required Behavior

Normal agent memory must work when qmd is unavailable:

- Hermes startup must not fail because qmd is down or unreachable.
- Recall and writes must continue through Open Brain.
- Current memory and session lanes must not depend on qmd.
- Required repo facts must be promoted into Open Brain before agents rely on
  them.
- qmd failures may reduce only optional deep lookup quality.

## Future Wrapper Preconditions

If the remote qmd wrapper is approved later, create a separate implementation
issue in the owning repo or host workflow and prove:

- trusted host identity and allowed caller identity are documented;
- qmd access is read-only unless explicitly approved otherwise;
- failures are bounded, observable, and non-fatal;
- no raw qmd chunks or private source bodies are stored in Open Brain by
  default;
- Open Brain remains the required distributed memory/fact layer;
- Hermes and mcp2cli canaries prove normal memory behavior without qmd.

## Local Validation

This disposition is docs/contract only. Validate with:

```bash
git diff --check
bunx tsc --noEmit
```

This validation does not prove a remote qmd-unavailable runtime fallback. That
runtime canary belongs with a future approved wrapper implementation.

No core01 deploy is required for this decision.
