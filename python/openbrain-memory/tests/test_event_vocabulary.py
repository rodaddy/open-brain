"""The session-event vocabulary is defined once and never redeclared (#412).

The vocabulary necessarily appears in six places -- this package, the
TypeScript client, the TypeScript server set, the `MemoryEventType` union, the
MCP tool schema, `table-constants.ts`, and a SQL CHECK constraint -- because
those languages cannot share one literal. So "one definition" is enforced by
this test rather than by an import: `openbrain_memory.EVENT_TYPES` is the
definition, and every other surface is asserted equal to it.

The issue that prompted this named two copies. Writing the guard found four
more, which is the argument for the guard: nobody can hold six declarations in
their head, and the `test_vocabulary_is_declared_exactly_where_expected` check
below exists so a seventh cannot appear unnoticed.

Why this is worth a test instead of a comment: the two Python/TypeScript copies
had already drifted once. `question` was valid in Python and missing from the
TypeScript adapter, and nothing reported it -- sending an event the other side
did not know about produced exit 0, no output, and no row. A silent no-op is
the worst possible failure for a memory write, because the caller has every
reason to believe it succeeded.

The SQL constraint is included deliberately, and it is the one that actually
matters. Postgres is the final authority: a value in the code sets but missing
from the CHECK constraint is accepted by every layer of validation and then
refused at the insert, reproducing exactly the silent-write symptom above. A
code set that drifts *wider* than the database is therefore not a cosmetic
inconsistency; it is that bug.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path, PurePosixPath

import pytest

from openbrain_memory import EVENT_TYPES

REPO_ROOT = Path(__file__).resolve().parents[3]


def _extract_quoted_block(source: str, anchor: str) -> set[str]:
    """Return the quoted string literals in the block opened at `anchor`.

    Reads to the first closing bracket after the anchor, which is what every
    declaration here looks like (a set/array literal of bare strings). This is
    deliberately dumb: a real parser for two languages would be more code than
    the thing it guards, and a malformed anchor fails loudly as an empty set
    rather than silently matching too much.
    """
    if anchor not in source:
        # A rename upstream is the likely cause, and a bare
        # `ValueError: substring not found` from `str.index` does not say so.
        # It fails either way -- the point of naming it is that the next reader
        # knows the declaration moved rather than the vocabulary changed.
        pytest.fail(
            f"anchor {anchor!r} not found; the declaration was renamed or moved. "
            "Update this guard to the new spelling -- do not delete the check."
        )
    start = source.index(anchor)
    tail = source[start + len(anchor) :]
    end = min(
        (tail.index(c) for c in ("]", "}") if c in tail),
        default=-1,
    )
    if end == -1:  # pragma: no cover - only on a malformed source file
        pytest.fail(f"no closing bracket after anchor: {anchor!r}")
    return set(re.findall(r'"([a-z_]+)"', tail[:end]))


def _extract_union(source: str, anchor: str) -> set[str]:
    """Return the quoted members of a TypeScript union starting at `anchor`."""
    if anchor not in source:
        pytest.fail(
            f"anchor {anchor!r} not found; the union was renamed or moved. "
            "Update this guard to the new spelling -- do not delete the check."
        )
    start = source.index(anchor)
    return set(re.findall(r'"([a-z_]+)"', source[start : source.index(";", start)]))


def _drift(surface: str, found: set[str]) -> str:
    """A failure message naming which side has which value.

    A bare `assert found == EVENT_TYPES` reports two sorted sets and leaves the
    reader to diff nine strings by eye. Naming the difference is the whole
    value of the message when this fires months from now.
    """
    return (
        f"{surface} vocabulary drifted from openbrain_memory.EVENT_TYPES; "
        f"missing={sorted(EVENT_TYPES - found)} "
        f"unexpected={sorted(found - EVENT_TYPES)}"
    )


def test_python_vocabulary_is_the_public_surface() -> None:
    """`EVENT_TYPES` is importable from the package root, not just `agent`."""
    from openbrain_memory import agent

    assert EVENT_TYPES is agent.EVENT_TYPES
    assert "EVENT_TYPES" in __import__("openbrain_memory").__all__


def test_typescript_client_matches_python() -> None:
    """`clients/ts/src/runtime.ts` carries the same set."""
    source = (REPO_ROOT / "clients" / "ts" / "src" / "runtime.ts").read_text()
    found = _extract_quoted_block(source, "export const EVENT_TYPES")
    assert found == EVENT_TYPES, _drift("TypeScript client", found)


def test_typescript_server_matches_python() -> None:
    """`src/agent-memory.ts` carries the same set."""
    source = (REPO_ROOT / "src" / "agent-memory.ts").read_text()
    found = _extract_quoted_block(
        source, "const EVENT_TYPES = new Set<MemoryEventType>"
    )
    assert found == EVENT_TYPES, _drift("TypeScript server", found)


def test_mcp_tool_schema_matches_python() -> None:
    """The `append_session_event` tool schema advertises the same set.

    This one is wire-visible: the schema is what every MCP client is told it
    may send. A value here that the server rejects produces a request the
    client had every reason to believe was valid, and a value missing here is
    unreachable through the tool even though the server would accept it.
    """
    source = (REPO_ROOT / "src" / "contract-schemas.ts").read_text()
    # Anchor on this property's own `values: [`, found by seeking forward from
    # the `event_type` key. A bare `values: [` matches a different enum earlier
    # in the file, and anchoring on `event_type: {` alone picks up the
    # `type: "enum"` line before the list starts.
    prop = source.index("event_type: {")
    found = _extract_quoted_block(source[prop:], "values: [")
    assert found == EVENT_TYPES, _drift("MCP tool schema", found)


def test_tiering_union_matches_python() -> None:
    """`src/tiering.ts` `EventType` matches; it decides what gets promoted."""
    source = (REPO_ROOT / "src" / "tiering.ts").read_text()
    found = _extract_union(source, "export type EventType")
    assert found == EVENT_TYPES, _drift("tiering EventType", found)


def test_table_constants_match_python() -> None:
    """`server/db/table-constants.ts` matches; it gates the SQL write path.

    Moved out of `src/tools/` by issue 864. The old path is now a re-export
    shim that declares nothing, so the anchor has to follow the declaration.
    """
    source = (REPO_ROOT / "server" / "db" / "table-constants.ts").read_text()
    found = _extract_quoted_block(source, "export const EVENT_TYPES = [")
    assert found == EVENT_TYPES, _drift("table-constants", found)


def test_typescript_server_union_type_matches_python() -> None:
    """The `MemoryEventType` union matches the runtime set it types.

    The union and the `Set` are two separate declarations in the same file, so
    they can disagree with each other as easily as with Python -- and a union
    that is missing a value makes the corresponding `Set` entry a type error
    rather than a silent write, which is why it is checked separately.
    """
    source = (REPO_ROOT / "src" / "agent-memory.ts").read_text()
    found = _extract_union(source, "export type MemoryEventType")
    assert found == EVENT_TYPES, _drift("MemoryEventType union", found)


def _migration_check_constraint() -> set[str] | None:
    """The event_type CHECK constraint as declared in the migrations."""
    migrations = REPO_ROOT / "src" / "db" / "migrations"
    if not migrations.is_dir():
        return None
    # `CHECK (event_type IN ('fact', 'decision', ...))` as declared in
    # 013_session_events.sql. Matching the IN-list specifically rather than any
    # CHECK containing `event_type` keeps a neighbouring constraint on the same
    # column from being picked up instead.
    pattern = re.compile(
        r"CHECK\s*\(\s*event_type\s+IN\s*\((.*?)\)\s*\)", re.IGNORECASE | re.DOTALL
    )
    for path in sorted(migrations.iterdir()):
        if path.suffix != ".sql":
            continue
        match = pattern.search(path.read_text())
        if match:
            return set(re.findall(r"'([a-z_]+)'", match.group(1)))
    return None


def test_database_constraint_matches_python() -> None:
    """The SQL CHECK constraint carries the same set.

    Postgres is the authority. A value the code accepts but the constraint
    rejects is accepted by every validation layer and then refused at the
    insert -- the caller sees success and no row appears.
    """
    declared = _migration_check_constraint()
    if declared is None:
        pytest.skip("no event_type CHECK constraint found in migrations/")
    assert declared is not None  # narrows for the type checker after skip
    assert declared == EVENT_TYPES, (
        _drift("database CHECK constraint", declared)
        + ". A code value missing from the constraint is a silent no-row write."
    )


def _is_test_path(path: str) -> bool:
    """True for a test file, matched on path COMPONENTS, not substrings.

    `"test" in path` was the first version and it silently excluded
    `latest.ts`, `manifest.ts`, and `attestation.ts` from the sweep below --
    every one of which could hold a real declaration. A guard whose filter
    hides files is worse than no guard, because it reports success over the
    gap. Matched on segment boundaries instead.
    """
    parts = PurePosixPath(path).parts
    return any(
        part in {"tests", "__tests__"} or part.startswith(("test_", "test."))
        for part in parts
    ) or PurePosixPath(path).name.endswith((".test.ts", "_test.py"))


def test_vocabulary_is_declared_exactly_where_expected() -> None:
    """No seventh copy appears without this guard being updated to cover it.

    The point of the slice is one definition; a new redeclaration somewhere
    else would be invisible to the assertions above, which only compare the
    surfaces they already know about.

    Scope note: `git grep` searches TRACKED files, so a brand-new untracked
    file is not seen. That is the right boundary for CI (which runs on
    committed code) but means this cannot catch a declaration mid-edit before
    it is staged.
    """
    known = {
        "python/openbrain-memory/src/openbrain_memory/agent.py",
        "clients/ts/src/runtime.ts",
        "src/agent-memory.ts",
        "src/contract-schemas.ts",
        "src/tiering.ts",
        # Moved here from `src/tools/table-constants.ts` by issue 864. The old
        # path keeps a re-export shim, which declares no member names and so
        # never appears in this sweep -- listing it would weaken the census.
        "server/db/table-constants.ts",
        # The port target's `EventType` StrEnum -- a seventh language-boundary
        # surface, sanctioned by `_plans/python-port-sequence.md` (THE WRITE
        # PATH: "the only openbrain_memory reference in the package today is a
        # vocabulary import in models/turn.py"). pydantic needs a StrEnum for
        # boundary validation, which cannot BE the `set[str]` in agent.py, so it
        # is mirrored like the six above -- and its equality to the authority is
        # enforced by `python/openbrain/tests/test_turn_models.py`
        # (test_matches_the_authoritative_list_exactly), the same way each
        # surface above has its own per-surface drift test. Listed here so the
        # census still trips on an EIGHTH, undocumented declaration.
        "python/openbrain/src/openbrain/models/turn.py",
        # NOT a vocabulary declaration: the startup lane resume (#519) SELECTS
        # the intent subset -- decision/blocker/correction/checkpoint/handoff,
        # fact excluded for noise, the same selection resume.py --brief makes.
        # A subset filter names members without declaring the vocabulary; the
        # authority stays openbrain_memory.EVENT_TYPES, and an unknown name in
        # that set simply never matches an event. Listed so the census keeps
        # tripping on genuinely new declarations.
        "python/openbrain/src/openbrain/apps/hooks/session_start.py",
    }
    result = subprocess.run(
        ["git", "grep", "-l", "-E", r'"blocker"', "--", "*.py", "*.ts"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    found = {
        line
        for line in result.stdout.splitlines()
        if line and not _is_test_path(line) and not line.startswith("_tmp/")
    }
    unexpected = found - known
    assert not unexpected, (
        f"event vocabulary appears in unexpected files: {sorted(unexpected)}. "
        "Either import it from openbrain_memory.EVENT_TYPES, or add the file to "
        "this guard so drift there is caught too."
    )
