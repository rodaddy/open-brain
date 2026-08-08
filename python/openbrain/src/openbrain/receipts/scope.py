"""Which Development project a hook's ``cwd`` belongs to, resolved as the gate does.

Purpose:
    Every receipt the gate reads is filed under a ``project`` slug, and the gate
    filters on it. It derives that slug from the hook payload's ``cwd`` through
    ``resolveDevelopmentScope`` in ``_ob/scripts/ob-memory-provider.ts``, so a
    Python writer that derives it any other way files receipts under a key the
    gate never looks up. The failure is silent -- a perfectly valid receipt that
    unblocks nothing -- which makes this the least obvious and most load-bearing
    part of the port.

Architecture:
    Two questions, in the order TypeScript asks them.

        1. Is this ``cwd`` in scope at all?  ``scopedCwd``
        2. If so, what is it called?          ``projectSlug``

    Out of scope answers ``None``, and a caller with ``None`` writes no receipt:
    the gate itself only tracks sessions whose ``cwd`` resolved, so a receipt for
    an unscoped directory would have no block to clear.

Pattern/Convention:
    A WORKTREE IN THE TEMP WORKSPACE IS IN SCOPE, and that is not an edge case --
    it is where the work happens. A directory outside ``Development`` still
    resolves when it is a git worktree OF a Development repo and sits under an
    approved temp root in the ``<repo>/_worktrees/<name>`` shape. Dropping that
    branch would mean no receipt is ever written from a worktree, which is most
    sessions.

    THE SLUG COMES FROM GIT, NOT FROM THE PATH. ``git rev-parse --show-toplevel``
    is what makes a worktree at ``_tmp/open-brain/_worktrees/x`` resolve to the
    repo it belongs to rather than to the directory it sits in.

See Also:
    - ``_ob/scripts/ob-memory-provider.ts`` - ``resolveDevelopmentScope`` and below
    - ``openbrain.receipts.state`` - what the slug is written into
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from pydantic import BaseModel, ConfigDict

#: The one directory tree Development work happens in, as shipped.
#:
#: The gate side became overridable (``openbrain_provider.development_scope``)
#: because a machine without this exact macOS volume resolves every scope to
#: None. This side reads the SAME variable, deliberately: a configurable value
#: on one side only would put the writer and the reader in different scopes,
#: which is what the previous literal-only comment was protecting against.
DEVELOPMENT_ROOT = Path.home() / "Development"

#: The override both sides honour. Spelled identically to the gate's.
DEVELOPMENT_ROOT_ENV_VAR = "OPENBRAIN_DEVELOPMENT_ROOT"


def development_root() -> Path:
    """Return the Development root, honouring the shared override.

    Read per call rather than frozen at import, matching the gate: the value is
    answered against the FILESYSTEM, and a module constant is evaluated during
    pytest collection, before a conftest can set the variable.

    Returns:
        The override when set and non-empty, else the shipped default.
    """
    override = os.environ.get(DEVELOPMENT_ROOT_ENV_VAR, "").strip()
    return Path(override) if override else DEVELOPMENT_ROOT


def development_root_missing() -> bool:
    """Report whether the configured Development root is absent here.

    Separates the two causes of a ``None`` scope: somebody else's repository
    (silent by design) versus a root that does not exist on this machine (a
    misconfiguration -- open-brain#556).

    Returns:
        True when the configured root is not an existing directory.
    """
    return _canonical_directory(development_root()) is None


def development_root_origin() -> str:
    """Name where the configured root's value came from.

    Returns:
        The environment variable name when it is set and non-empty, else
        ``shipped default``. Quoted in the diagnosis so an operator who already
        exported the variable is told the value THEY set, not a default they did
        not choose.
    """
    override = os.environ.get(DEVELOPMENT_ROOT_ENV_VAR, "").strip()
    return DEVELOPMENT_ROOT_ENV_VAR if override else "shipped default"


#: Temp roots a Development worktree may legitimately live under, matching
#: ``APPROVED_TEMP_WORKTREE_ROOTS``. The first is Rico's Mac, the second the
#: cc-* boxes.
APPROVED_TEMP_WORKTREE_ROOTS = (
    Path(os.environ.get("OPENBRAIN_TEMP_WORKSPACE", Path.home() / ".cache/open-brain")),
    Path("/mnt/collab/tmp_space"),
)

#: The slug used when no better name can be derived, matching ``projectSlug``.
FALLBACK_PROJECT = "development"

#: How long to wait for git before giving up on it, matching the TypeScript
#: ``spawnSync`` timeout. A hook runs against a short deadline, and a wedged git
#: must degrade to "no scope" rather than hold the session's hook open.
_GIT_TIMEOUT_SECONDS = 2.0

#: Characters a slug may keep; everything else becomes ``-``. Matches the
#: TypeScript ``replace(/[^a-zA-Z0-9._-]/g, "-")``.
_SLUG_UNSAFE = re.compile(r"[^a-zA-Z0-9._-]")

#: Git environment variables that OVERRIDE ``git -C`` and must be cleared.
#:
#: This is not hypothetical tidiness -- it was measured. ``git push`` exports
#: ``GIT_DIR`` and ``GIT_WORK_TREE`` to its hooks, and ``GIT_WORK_TREE`` beats
#: ``-C``: inside a pre-push hook, ``git -C <any path> rev-parse --show-toplevel``
#: answered ``/path/to/open-brain/Development`` for EVERY directory asked about.
#: Every receipt in every repo would then be filed under the single project slug
#: ``Development``, and the gate -- which keys its blocks per project -- would
#: never match one.
#:
#: Caught 2026-08-03 by the scope tests failing under the pre-push hook while
#: passing when run directly. Cleared rather than merely documented, because a
#: hook is exactly where these hooks run.
_OVERRIDING_GIT_ENV = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
)


class DevelopmentScope(BaseModel):
    """A resolved working directory and the project slug it belongs to.

    Attributes:
        cwd: The canonical (symlink-resolved) directory.
        project: The slug receipts for this directory are filed under.
    """

    model_config = ConfigDict(frozen=True)

    cwd: Path
    project: str


def resolve_development_scope(cwd: str | Path | None) -> DevelopmentScope | None:
    """Resolve a hook payload's ``cwd`` to the scope its receipts belong to.

    Args:
        cwd: The ``cwd`` field from the hook payload, or ``None`` when the
            payload carried none.

    Returns:
        The scope, or ``None`` when this directory is not Development work. A
        caller receiving ``None`` writes no receipt.

    Example:
        >>> resolve_development_scope("/nowhere-that-exists") is None
        True
        >>> resolve_development_scope(None) is None
        True
    """
    if cwd is None:
        return None

    scoped = _scoped_cwd(Path(cwd))
    if scoped is None:
        return None

    return DevelopmentScope(cwd=scoped, project=_project_slug(scoped))


def _scoped_cwd(cwd: Path) -> Path | None:
    """The canonical directory when it is in scope, else ``None``.

    In scope means inside ``Development``, or -- for a worktree -- the same git
    repository as ``Development`` AND under an approved temp root in the expected
    shape. The git check is what stops an arbitrary directory that happens to sit
    in the temp workspace from claiming Development scope.
    """
    root = _canonical_directory(development_root())
    candidate = _canonical_directory(cwd)
    if root is None or candidate is None:
        return None

    if _is_within(candidate, root):
        return candidate

    if _same_git_repository(candidate, root) and _approved_temp_worktree(candidate):
        return candidate

    return None


def _project_slug(cwd: Path) -> str:
    """The slug this directory's receipts are filed under.

    A directory belonging to the Development repository ITSELF -- the router, the
    shared ``_ob`` tooling -- is named after that repository, not after whichever
    subdirectory the session happened to open in. Anything else is named after
    its own git top level, falling back to the directory when git says nothing.
    """
    top = _git_path(cwd, "--show-toplevel")
    root = _canonical_directory(development_root())
    if top is not None and root is not None and _same_git_repository(top, root):
        return root.name

    named = top if top is not None else cwd
    return _SLUG_UNSAFE.sub("-", named.name) or FALLBACK_PROJECT


def _approved_temp_worktree(candidate: Path) -> bool:
    """Whether ``candidate`` sits in the ``<repo>/_worktrees/<name>`` temp shape.

    The shape is required, not just the root: it is what distinguishes a managed
    worktree from a scratch directory someone left in the temp workspace, and the
    gate applies the same test.
    """
    return any(
        _worktree_shaped(_relative_parts(candidate, _canonical_directory(root)))
        for root in APPROVED_TEMP_WORKTREE_ROOTS
    )


def _worktree_shaped(parts: tuple[str, ...] | None) -> bool:
    """Whether a path relative to a temp root is ``<repo>/_worktrees/<name>...``."""
    if parts is None or len(parts) < 3:
        return False
    return parts[1] == "_worktrees" and all(part not in {"", ".", ".."} for part in parts)


def _relative_parts(candidate: Path, root: Path | None) -> tuple[str, ...] | None:
    """``candidate``'s path segments below ``root``, or ``None`` when not below it."""
    if root is None:
        return None
    try:
        return candidate.relative_to(root).parts
    except ValueError:
        return None


def _is_within(candidate: Path, root: Path) -> bool:
    """Whether ``candidate`` is ``root`` itself or sits underneath it."""
    return candidate == root or _relative_parts(candidate, root) is not None


def _same_git_repository(left: Path, right: Path) -> bool:
    """Whether two directories belong to the same git repository.

    Compares ``--git-common-dir``, not ``--git-dir``: a worktree has its OWN git
    dir but SHARES the common one with its main checkout, and sharing it is
    exactly the relationship being tested.
    """
    left_common = _git_path(left, "--git-common-dir")
    right_common = _git_path(right, "--git-common-dir")
    return left_common is not None and left_common == right_common


def _git_path(cwd: Path, selector: str) -> Path | None:
    """Ask git for an absolute path from ``cwd``, or ``None`` when it cannot say.

    Args:
        cwd: Where to ask from.
        selector: ``--show-toplevel`` or ``--git-common-dir``.

    Returns:
        The path git reported, or ``None`` for a non-repository, a missing git, a
        timeout, or empty output.

    Never raises. Scope resolution runs inside a hook, and a git that is absent or
    slow must degrade to "no scope" rather than break the session.

    Runs with :data:`_OVERRIDING_GIT_ENV` stripped, because those variables beat
    ``-C`` and would make every directory answer with the invoking repository's
    paths instead of its own.
    """
    try:
        completed = subprocess.run(  # noqa: S603 -- fixed argv, no shell, no user input in the command
            ["git", "-C", str(cwd), "rev-parse", "--path-format=absolute", selector],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
            env=git_environment(),
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if completed.returncode != 0:
        return None

    reported = completed.stdout.strip()
    return Path(reported) if reported else None


def git_environment() -> dict[str, str]:
    """This process's environment with git's repository overrides removed.

    Returns:
        A copy of ``os.environ`` without :data:`_OVERRIDING_GIT_ENV`.

    A copy, not a mutation: this runs inside a hook whose parent process owns
    those variables, and clearing them globally would change the behaviour of
    anything else that shells out to git afterwards. Only the child sees them
    gone.
    """
    return {
        name: value
        for name, value in os.environ.items()
        if name not in _OVERRIDING_GIT_ENV
    }


def _canonical_directory(path: Path) -> Path | None:
    """``path`` with symlinks resolved, or ``None`` when it is not a directory.

    Symlinks are resolved on BOTH sides of every comparison in this module. A
    containment test between a resolved path and an unresolved one silently
    answers "no" for any directory reached through a symlink, which on a machine
    with a symlinked volume means no receipts at all.
    """
    try:
        resolved = path.resolve()
    except OSError:
        return None

    return resolved if resolved.is_dir() else None
