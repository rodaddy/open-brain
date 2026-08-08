"""Project resolution, the part that fails silently when it is wrong.

A receipt filed under the wrong project slug is a perfectly valid receipt that
unblocks nothing: the gate filters on ``project``, so it simply never matches.
Nothing logs, nothing raises, and the symptom is "the gate stopped working". That
makes this the part of the port most worth testing directly.

These tests run against the REAL Development checkout, because the resolver's
answers depend on real git repository identity -- which directory shares a
``--git-common-dir`` with which -- and a fabricated tree would prove the resolver
works on a tree nobody uses. They skip when that checkout is absent.

See Also:
    - ``openbrain.receipts.scope`` - the module under test
"""

from __future__ import annotations

from pathlib import Path

import pytest

from openbrain.receipts.scope import (
    DEVELOPMENT_ROOT,
    FALLBACK_PROJECT,
    git_environment,
    resolve_development_scope,
)

#: A repository inside the Development tree, used as the "ordinary" case.
REPO_INSIDE_DEVELOPMENT = DEVELOPMENT_ROOT / "open-brain"

pytestmark = pytest.mark.skipif(
    not REPO_INSIDE_DEVELOPMENT.is_dir(),
    reason=(
        "scope resolution answers questions about the real Development checkout; "
        "without it there is nothing meaningful to resolve"
    ),
)


def test_a_repo_inside_development_resolves_to_its_own_slug() -> None:
    """The ordinary case: a checkout under Development is named after itself."""
    scope = resolve_development_scope(REPO_INSIDE_DEVELOPMENT)

    assert scope is not None
    assert scope.project == "open-brain"


def test_a_subdirectory_resolves_to_its_repository_not_itself() -> None:
    """The slug comes from git's top level, so a subdirectory does not get its own.

    Receipts for a session working in ``open-brain/python`` must be filed under
    ``open-brain``, because that is the project the gate armed its block against.
    """
    scope = resolve_development_scope(REPO_INSIDE_DEVELOPMENT / "python")

    assert scope is not None
    assert scope.project == "open-brain"


def test_the_development_repo_itself_is_named_development() -> None:
    """Work in the Development repository is filed under Development, not a subfolder.

    The router and the shared ``_ob`` tooling live in the Development repository
    itself; naming a session there after whichever directory it opened in would
    scatter its receipts across several slugs.
    """
    scope = resolve_development_scope(DEVELOPMENT_ROOT / "_ob")

    assert scope is not None
    assert scope.project == DEVELOPMENT_ROOT.name


def test_a_directory_outside_development_does_not_resolve() -> None:
    """Out of scope answers ``None``, and a caller with ``None`` writes no receipt.

    The gate only tracks sessions whose ``cwd`` resolved, so a receipt for an
    unscoped directory would have no block to clear.
    """
    assert resolve_development_scope(Path.home()) is None


def test_a_missing_directory_does_not_resolve() -> None:
    """A path that does not exist is not scope, and is not an error either.

    A hook can fire with a ``cwd`` that has since been removed; that is a
    do-nothing outcome, not a failure to report.
    """
    assert resolve_development_scope("/no/such/directory/anywhere") is None


def test_an_absent_cwd_does_not_resolve() -> None:
    """A payload carrying no ``cwd`` at all resolves to nothing, without raising."""
    assert resolve_development_scope(None) is None


def test_a_file_path_does_not_resolve() -> None:
    """Only directories are scope. A file path is a caller error, not a project."""
    marker = DEVELOPMENT_ROOT / "AGENTS.md"
    if not marker.is_file():
        pytest.skip("the Development router file is not present in this checkout")

    assert resolve_development_scope(marker) is None


def test_the_resolved_cwd_is_canonical() -> None:
    """Symlinks are resolved, so containment comparisons are made on real paths.

    A containment test between a resolved path and an unresolved one silently
    answers "not in scope" for anything reached through a symlink, which on a
    machine with a symlinked volume means no receipts are ever written.
    """
    scope = resolve_development_scope(REPO_INSIDE_DEVELOPMENT)

    assert scope is not None
    assert scope.cwd == scope.cwd.resolve()


def test_a_worktree_of_a_nested_repo_does_not_resolve() -> None:
    """A temp worktree of a repo INSIDE Development is out of scope, in both languages.

    This is the surprising one, and it is the specification rather than a defect
    in this port. The temp-workspace branch requires the candidate to share a git
    repository with ``Development`` ITSELF -- ``--git-common-dir`` equal to
    Development's own. A worktree of ``open-brain`` reports
    ``Development/open-brain/.git``, which is a DIFFERENT repository from
    ``Development/.git``, so it fails that test even though its path shape is
    accepted.

    Verified against the real resolver on 2026-08-03: ``resolveDevelopmentScope``
    in ``_ob/scripts/ob-memory-provider.ts`` returns ``null`` for exactly this
    path, while ``approvedTempWorktreePath`` returns ``true`` for it -- the shape
    passes and the repository identity is what refuses. Python answering anything
    else here would write receipts the gate does not expect to exist.

    The consequence is worth stating plainly: a session working in a temp worktree
    of a nested repo writes NO receipts, because the gate tracks no block for it
    either. The two sides agree, which is what this test locks in.
    """
    worktree = Path(__file__).resolve().parents[3]
    if not (worktree / ".git").exists():
        pytest.skip("this test run is not inside a git worktree")
    if "_worktrees" not in worktree.parts:
        pytest.skip("this test run is not inside a temp-workspace worktree")

    assert resolve_development_scope(worktree) is None


def test_a_worktree_of_development_itself_resolves() -> None:
    """The temp-worktree branch is reachable, not dead code.

    The nested-repo case above proves the branch REFUSES; without this one, a
    resolver that always refused would pass every test here and no receipt would
    ever be written from a worktree. This creates a real worktree of the
    Development repository itself -- the one repo whose ``--git-common-dir``
    matches -- at the required ``<repo>/_worktrees/<name>`` path, and asserts it
    resolves.

    The worktree is removed with ``git worktree remove``, never a recursive
    delete: that is a git operation which unregisters and removes together, and is
    the one cleanup that must not be left behind.

    Both git calls run with the repository-overriding environment stripped, for
    the same reason the resolver strips it: under a pre-push hook, an inherited
    ``GIT_WORK_TREE`` makes ``worktree add`` operate on the invoking repository
    rather than the one named by ``-C``.
    """
    import subprocess

    if not (DEVELOPMENT_ROOT / ".git").exists():
        pytest.skip("the Development repository is not present in this checkout")

    root = Path("/workspace/_tmp/Development/_worktrees")
    if not root.parent.parent.is_dir():
        pytest.skip("the temp workspace volume is not mounted")
    root.mkdir(parents=True, exist_ok=True)
    worktree = root / "receipts-scope-probe"

    created = subprocess.run(  # noqa: S603
        [  # noqa: S607
            "git", "-C", str(DEVELOPMENT_ROOT), "worktree", "add",
            "--detach", str(worktree), "HEAD",
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
        env=git_environment(),
    )
    if created.returncode != 0:
        pytest.skip(f"could not create a probe worktree: {created.stderr.strip()}")

    try:
        scope = resolve_development_scope(worktree)
        assert scope is not None
        assert scope.project == DEVELOPMENT_ROOT.name
    finally:
        subprocess.run(  # noqa: S603
            [  # noqa: S607
                "git", "-C", str(DEVELOPMENT_ROOT), "worktree", "remove",
                "--force", str(worktree),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            env=git_environment(),
        )


def test_a_temp_directory_that_is_not_a_worktree_does_not_resolve(
    tmp_path: Path,
) -> None:
    """Sitting in the temp workspace is not enough; the git relationship is required.

    Otherwise any scratch directory someone left in the temp workspace could claim
    Development scope and file receipts under a project it has nothing to do with.
    """
    assert resolve_development_scope(tmp_path) is None


def test_git_env_overrides_do_not_hijack_the_slug(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A hook's inherited ``GIT_WORK_TREE`` must not rename every project.

    MEASURED, not theoretical. ``git push`` exports ``GIT_DIR`` and
    ``GIT_WORK_TREE`` to its hooks, and ``GIT_WORK_TREE`` BEATS ``git -C``: with
    it set, ``rev-parse --show-toplevel`` answers the invoking repository for
    every directory asked about. This test failed exactly that way inside the
    pre-push hook on 2026-08-03 while passing when run directly -- ``open-brain``
    resolved as ``Development``.

    The consequence is the quiet kind: every repo's receipts would be filed under
    one slug, and the gate -- which keys its blocks per project -- would match
    none of them. Nothing would raise; the gate would simply stop unblocking.

    Reproduces the hook's environment exactly, so it fails against the old
    behaviour and passes only because the subprocess environment is stripped.
    """
    monkeypatch.setenv("GIT_DIR", str(DEVELOPMENT_ROOT / ".git"))
    monkeypatch.setenv("GIT_WORK_TREE", str(DEVELOPMENT_ROOT))

    scope = resolve_development_scope(REPO_INSIDE_DEVELOPMENT)

    assert scope is not None
    assert scope.project == "open-brain"


def test_the_fallback_slug_is_never_empty() -> None:
    """Whatever happens, a resolved scope carries a usable slug.

    An empty project would be rejected as a coordinate downstream, so the resolver
    must not be able to produce one.
    """
    scope = resolve_development_scope(REPO_INSIDE_DEVELOPMENT)

    assert scope is not None
    assert scope.project
    assert FALLBACK_PROJECT
