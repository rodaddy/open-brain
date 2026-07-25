# Open Brain Python workspace

A [uv workspace](https://docs.astral.sh/uv/concepts/projects/workspaces/) holding
the Open Brain Python packages. One resolution, one committed lock file, one
virtual environment at `python/.venv`.

| Member | What it is |
|---|---|
| `openbrain-memory/` | Python client for the remote Open Brain memory service. |

## Why a workspace

Siblings that resolve separately drift. That is not hypothetical here: the
Claude lifecycle adapter and `openbrain-memory` each declared the durable event
vocabulary, and the two copies diverged — 9 values on one side, 8 on the other,
with the missing value silently rejected at runtime (#412). Shared resolution
plus a single lock is the structural half of preventing that.

Members keep their own `pyproject.toml`, tool configuration, and build backend,
matching the `fleet-bus` layout.

## Working in it

```bash
cd python
uv sync                       # resolve the whole workspace

# gates, from the workspace root
uv run --package openbrain-memory ruff check openbrain-memory/src openbrain-memory/tests
uv run --package openbrain-memory mypy openbrain-memory/src/openbrain_memory
uv run --package openbrain-memory pytest openbrain-memory/tests -q
```

Running the same commands from inside a member directory also works and is what
CI does (`working-directory: python/openbrain-memory`, `uv run --python 3.13`).
Both paths use the shared `python/.venv`.

## Pinned interpreter

`.python-version` pins **3.13**, matching `PYTHON_VERSION` in
`.github/workflows/ci.yml`. Without it uv selects the newest interpreter on the
box (3.14 here), so local gates would run on a different Python than CI — a
divergence the standards forbid, since local and CI must run the same commands
over the same paths.

## Build output

`uv build` writes to `python/dist/`, not `python/<member>/dist/`. Anything that
excludes or collects build artifacts needs the workspace-level path;
`scripts/core01-deploy-local.sh` carries both.

## Adding a member

Create the package directory with its own `pyproject.toml` and run `uv sync`.
Membership is a glob (`members = ["*"]`) rather than a hand-maintained list,
because uv accepts a listed member that does not exist — it resolves clean,
writes no lock entry, and reports nothing. A list cannot tell you whether a
package actually joined the workspace; the filesystem can.
