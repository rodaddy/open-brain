# Open Brain Memory Evals

This is the first Open Brain-native memory quality harness for the Codex durable
memory goal. It borrows the benchmark shape from BrainBench/gbrain-evals:
synthetic public corpus, sealed expected answers, deterministic runner,
scorecard output, and reproducible local commands.

The smoke suite is intentionally offline. It does not call PostgreSQL,
LiteLLM, or private memory. It validates the harness contract and gives later
issues a place to add live adapters and Codex workflow scenarios.

## Run

```bash
bun run eval:memory
bun run eval:memory -- --json
bun run eval:memory -- --report eval/open-brain/reports/latest.json
```

Reports are only written when `--report` is supplied. Use a visible repo path
when the report is intended to be durable; otherwise write scratch reports under
`/Volumes/ThunderBolt/_tmp`.

## Fixture Layout

- `fixtures/memory-smoke.json`: synthetic corpus plus sealed probe expectations.
- `runner.ts`: deterministic retrieval, scoring, uncertainty, and scorecard code.
- `__tests__/runner.test.ts`: tests for sealed answers, namespace isolation,
  stale/contradiction uncertainty, and aggregate scorecards.

## Current Categories

- Recall: relevant memory appears in top K.
- Precision: top K is not mostly junk.
- Temporal correctness: stale facts are surfaced.
- Identity resolution: similar people are distinguished.
- Citation grounding: expected source refs are cited.
- Contradiction handling: conflicting memories are surfaced as uncertainty.
- Namespace isolation: unreadable namespace entries are not returned.
- Scale/performance: smoke latency is tracked against an expanded-corpus target.

## Next Expansion Points

- Add a live Open Brain adapter that loads synthetic fixtures into an isolated
  namespace and calls `search_brain` / `brain_answer`.
- Add Codex workflow probes for session resume, user decision reuse, validation
  receipt lookup, stale-memory avoidance, and memory citation behavior.
- Publish durable scorecards only when the corpus and command are intentionally
  pinned for comparison.
