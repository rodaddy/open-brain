"""Decide whether a working directory is inside the Development lane.

The gate enforces nothing outside `/Volumes/ThunderBolt/Development` and the
approved temp worktree roots. A cwd that resolves to neither yields no project,
and a gate with no project emits nothing — that is what keeps the hook silent in
somebody else's repository.

Ported from `ob-memory-provider.ts:336-338` (`resolveDevelopmentScope`) and its
helpers at `:1455-1534`, which is the only piece of that 2,046-line module the
gates actually import.

What this module does NOT do: it does not read config, contact a server, or
decide anything about memory. It answers one question about one path.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Final

__all__ = [
    "APPROVED_TEMP_WORKTREE_ROOTS",
    "DEVELOPMENT_ROOT",
    "DevelopmentScope",
    "approved_temp_worktree_path",
    "resolve_development_scope",
]

#: ob-memory-provider.ts:143. The one lane root.
DEVELOPMENT_ROOT: Final[Path] = Path("/Volumes/ThunderBolt/Development")

#: ob-memory-provider.ts:144-147. A worktree under one of these still counts as
#: Development work, but only when git agrees it is the same repository — see
#: :func:`resolve_development_scope`.
APPROVED_TEMP_WORKTREE_ROOTS: Final[tuple[Path, ...]] = (
    Path("/Volumes/ThunderBolt/_tmp"),
    Path("/mnt/collab/tmp_space"),
)

#: ob-memory-provider.ts:1508 — anything outside this becomes a hyphen, so a
#: project slug is always safe to embed in a state-file key or a shell string.
_UNSAFE_SLUG_CHARS: Final[re.Pattern[str]] = re.compile(r"[^a-zA-Z0-9._-]")

#: A git call that hangs would hang the hook, and the hook is on the agent's
#: critical path. Two seconds matches ob-memory-provider.ts:1520.
_GIT_TIMEOUT_SECONDS: Final[float] = 2.0


@dataclass(frozen=True)
class DevelopmentScope:
    """A resolved Development working directory.

    Attributes:
        cwd: The canonicalised directory.
        project: The project slug the gate scopes state by.
    """

    cwd: Path
    project: str


def _canonical_directory(path: str | Path) -> Path | None:
    """Resolve a path to a real existing directory.

    Args:
        path: Candidate path.

    Returns:
        The fully-resolved directory, or None when it does not exist or is not a
        directory. Symlinks are followed, so two spellings of one directory
        compare equal.
    """
    try:
        resolved = Path(path).resolve()
    except OSError:
        return None
    try:
        return resolved if resolved.is_dir() else None
    except OSError:
        return None


def _git_path(cwd: Path, selector: str) -> Path | None:
    """Ask git for an absolute path, or None when git cannot answer.

    Args:
        cwd: Directory to ask from.
        selector: ``--show-toplevel`` or ``--git-common-dir``.

    Returns:
        The canonicalised path git reported, or None on any failure. Every
        failure mode is the same answer here: git missing, not a repository,
        timed out, or a path that no longer exists.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--path-format=absolute", selector],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    reported = completed.stdout.strip()
    if not reported:
        return None
    try:
        resolved = Path(reported).resolve()
    except OSError:
        return None
    return resolved if resolved.exists() else None


def _same_git_repository(left: Path, right: Path) -> bool:
    """Report whether two directories share one git object store.

    ``--git-common-dir`` is the right question rather than ``--show-toplevel``:
    a linked worktree has its own toplevel but the same common dir, which is
    exactly the case this exists to accept.

    Args:
        left: One directory.
        right: The other.

    Returns:
        True when both resolve to the same common git directory.
    """
    left_common = _git_path(left, "--git-common-dir")
    right_common = _git_path(right, "--git-common-dir")
    return left_common is not None and left_common == right_common


def _is_within(candidate: Path, root: Path) -> bool:
    """Report whether ``candidate`` is ``root`` or lives under it."""
    try:
        candidate.relative_to(root)
    except ValueError:
        return False
    return True


def approved_temp_worktree_path(candidate: Path) -> bool:
    """Report whether a path is an approved temp worktree location.

    The shape is fixed: ``<temp root>/<area>/_worktrees/<name>[/...]``. Requiring
    the ``_worktrees`` bucket is what stops an arbitrary scratch directory from
    inheriting Development enforcement just by sitting on the same volume.

    Args:
        candidate: Directory to test.

    Returns:
        True when the path matches that shape under an approved root.
    """
    try:
        absolute = candidate.resolve()
    except OSError:
        return False
    for temp_root in APPROVED_TEMP_WORKTREE_ROOTS:
        try:
            relative = absolute.relative_to(temp_root.resolve())
        except (OSError, ValueError):
            continue
        parts = relative.parts
        if len(parts) < 3:
            continue
        if parts[1] != "_worktrees":
            continue
        if any(part in ("", ".", "..") for part in parts):
            continue
        return True
    return False


def _project_slug(cwd: Path) -> str:
    """Return the project slug for a Development directory.

    Args:
        cwd: A canonicalised Development directory.

    Returns:
        The git toplevel's basename, sanitised. A directory inside the
        Development repository ITSELF reports ``Development`` rather than a
        subdirectory name, so every hook in that repo shares one state key.
    """
    toplevel = _git_path(cwd, "--show-toplevel")
    development = _canonical_directory(DEVELOPMENT_ROOT)
    if toplevel is not None and development is not None:
        if _same_git_repository(toplevel, development):
            return development.name
    source = toplevel if toplevel is not None else cwd
    return _UNSAFE_SLUG_CHARS.sub("-", source.name) or "development"


def resolve_development_scope(cwd: str | Path | None) -> DevelopmentScope | None:
    """Resolve a working directory to a Development scope, or None.

    Args:
        cwd: The hook's reported working directory.

    Returns:
        The scope when the directory is inside Development, or inside an
        approved temp worktree of the SAME repository. None otherwise — and None
        is what makes the gate silent outside its lane.
    """
    if cwd is None:
        return None
    root = _canonical_directory(DEVELOPMENT_ROOT)
    candidate = _canonical_directory(cwd)
    if root is None or candidate is None:
        return None
    if _is_within(candidate, root):
        return DevelopmentScope(cwd=candidate, project=_project_slug(candidate))
    if approved_temp_worktree_path(candidate) and _same_git_repository(candidate, root):
        return DevelopmentScope(cwd=candidate, project=_project_slug(candidate))
    return None
