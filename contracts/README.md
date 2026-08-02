# Memory contract parity

`contracts/memory/*.fixture.json` is the runtime-neutral contract scenario set
for the matched Python and TypeScript clients. `parity-manifest.json` declares
the current implementation asymmetry; a runtime-specific entry must explain why
the behavior is intentionally not shared.

`contracts/server/*.fixture.json` records MCP responses observed from `current-src`
through the full in-memory protocol boundary and a real isolated Postgres database.
Each fixture also declares `server-rewrite-scaffold`; the scaffold does not execute
the calls until its handlers exist, but the declaration prevents rewrite work from
silently dropping a reviewed scenario.

Run the gate from the repository root:

```sh
bun contracts/check-parity.ts
OPENBRAIN_TEST_DATABASE_URL=postgres://... bun test contracts/server-tool-parity.test.ts
cd python/openbrain-memory && uv run pytest -q tests/test_contract_fixtures.py
```

The versioned pre-push hook integrates this subset with the existing repository
validation. Enable the repository-owned hooks once per clone/worktree:

```sh
git config core.hooksPath .githooks
```

The hook runs the parity checker and fixture-consuming pytest subset only when
the pushed commit range touches `python/openbrain-memory/`, `contracts/`,
`clients/ts/`, or the server contract declarations.
