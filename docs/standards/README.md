# Development standards — local copies

**Copied 2026-07-31 from `/Volumes/ThunderBolt/Development/_DOCS/`.**

These are here so they are in **this repo's qmd index**. Searching for a rule
should not require knowing that the shared tree exists, or that it is outside
every index this repo can reach (#440).

```bash
aqmd search "flat control flow"      # ~0.1s, finds it here
aqmd "what does the standard say about nesting"
```

## Provenance — these are COPIES, not the source

| file | source | copied |
|---|---|---|
| `STANDARDS-python.md` | `_DOCS/STANDARDS-python.md` | 2026-07-31 |
| `STANDARDS-typescript.md` | `_DOCS/STANDARDS-typescript.md` | 2026-07-31 |
| `STANDARDS-repo-search.md` | `_DOCS/STANDARDS-repo-search.md` | 2026-07-31 |
| `CODING_STANDARDS.md` | `_DOCS/CODING_STANDARDS.md` | 2026-07-31 |
| `GIT_STANDARDS.md` | `_DOCS/GIT_STANDARDS.md` | 2026-07-31 |
| `REPO_BOOTSTRAP.md` | `_DOCS/REPO_BOOTSTRAP.md` | 2026-07-31 |
| `QMD_INDEXES.md` | `_DOCS/QMD_INDEXES.md` | 2026-07-31 |
| `python-exemplar/` | `_DOCS/python-exemplar/` | 2026-07-31 |

**Never hand-edit these.** A rule change goes in the source document under
`_DOCS/`, then gets re-copied. Editing a copy forks the standard, which is the
same defect the standards themselves are about.

The exemplar's `.gitignore` is stored as `gitignore.example` so it cannot apply
to this tree by accident.

## Which file wins

1. `docs/CODING_STANDARDS.md` — repo-local, authoritative for Open Brain
2. these copies — Development-wide policy
3. `AGENTS.md` / `CLAUDE.md` — the routers

Where a repo-local rule is stricter or more specific, it wins. Where these are
stricter, they win.

---

## The exemplar disagrees with the prose — verified in source

`STANDARDS-python.md:196-228` describes the layout as
`models/ services/ api/ utils/`.

**The exemplar actually is** `apps/ config.py db/ models/ utils/` — no
`services/`, no `api/` at the package root, and a `db/` the prose never
mentions. The API lives at `apps/monitor/api.py`, inside its app.

Read `python-exemplar/src/exemplar/` before following the prose layout. Where
they disagree, working code beats a description of it.

`config.py:466` calls `setup_logging(settings.logging, ...)`, and `config.py:91`
names `utils.logging_config` as *"the only consumer of LoggingSettings"* — so
the keystone rule (config sets up logging, nothing else does) is real in code,
not aspiration.

## What the standard describes but the exemplar does not have

Checked 2026-07-31 with `fd -H -t f`:

- **`_githooks/`** — the directory exists and is **empty**. No `pre-commit`,
  no `commit-msg`, no `install.sh`.
- **`.github/workflows/`** — absent entirely.
- **`scripts/dev/generate_folder_docs.py`** — the generator the standard calls
  the whole trick is **not in the exemplar**.
- **`docs/`** — absent.
- **`tests/`** — absent, despite the layout showing it.

This is the same pattern `STANDARDS-python.md` itself documents about
`b1x-message-coordinator`: *"the mechanism the documentation calls automatic
is, in the repo that invented it, entirely manual."* The exemplar is a good
reference for **layout, config, models, and utils**; it is not evidence that
the hooks exist anywhere.

**Open Brain's blocking generator is real and runs:**
`scripts/pytools/generate_package_docs.py`, proven to fail on a missing
docstring, a short docstring, a missing README, and a hand-edited README.

## Deltas against `docs/CODING_STANDARDS.md`, 2026-07-31

Read once, recorded so the next session does not re-derive them:

| # | the standard says | our file said |
|---|---|---|
| 1 | `utils/` is the shared floor | `core/` |
| 2 | `config.py` is a keystone that ALSO sets up logging | separate `config/` and `observability/` |
| 3 | `db/` exists | not mentioned |
| 4 | 500 lines max per file; `config.py` the sole documented exception | no size guidance |
| 5 | LAW: flat control flow — enum+table > guards > extract > dispatch | absent |
| 6 | ruff `preview = true`, `max-nested-blocks = 3`, rules selected individually | absent |
| 7 | three log sinks: console, rotating file, structured JSON | one sink |
| 8 | `secrets/` allowlist gitignore, `data/`, `logs/` | absent |
| 9 | `_githooks/` + `install.sh`, `core.hooksPath` points there | noted as half-landed (#311) |
| 10 | errors carry remediation: "ACTION REQUIRED: copy X to Y" | fail-fast, no remediation |

### The one that would have shipped broken

`preview = true` is **required** for `PLR1702`. Without it ruff prints
`warning: Selection PLR1702 has no effect because preview is not enabled` and
**exits 0** — the rule is in `select`, appears configured, and never fires.

Same defect class as the mypy-nonexistent-path trap in
`docs/CI_CD_REQUIREMENTS.md`: a check that reports success while examining
nothing.

Two more from the same section, both easy to get wrong:
- `max-nested-blocks = 3`, not 2. PLR1702 counts every block type, so a
  legitimate `try:` → `async for` → `with` is three deep with no branching.
- Select rules **individually**, not the whole `PL` family — `"PL"` drags in
  ~40 unrelated rules that produce noise, and noisy rule sets get blanket
  `noqa`'d, costing you the rules that mattered.

---

**See Also:**
- `docs/CODING_STANDARDS.md` — repo-local, authoritative here
- `docs/CI_CD_REQUIREMENTS.md` — where each rule is actually enforced
- `docs/CONFIG_REFERENCE.md` — every setting and its read site
- `scripts/pytools/generate_package_docs.py` — the blocking generator
