# Memory contract parity

`contracts/memory/*.fixture.json` is the runtime-neutral contract scenario set
for the matched Python and TypeScript clients. `parity-manifest.json` declares
the current implementation asymmetry; a runtime-specific entry must explain why
the behavior is intentionally not shared.

Run the gate from the repository root:

```sh
bun contracts/check-parity.ts
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
