"""Decide whether a working directory is inside the Development lane.

The gate enforces nothing outside `/path/to/open-brain/Development` and the
approved temp worktree roots. A cwd that resolves to neither yields no project,
and a gate with no project emits nothing — that is what keeps the hook silent in
somebody else's repository.

Ported from `ob-memory-provider.ts:336-338` (`resolveDevelopmentScope`) and its
helpers at `:1455-1534`, which is the only piece of that 2,046-line module the
gates actually import.

A `None` answer has two causes, and they are not the same event. The cwd may be
somebody else's repository — expected, and silent on purpose. Or the CONFIGURED
ROOT ITSELF may not exist on this machine, which is a misconfiguration of the
operator's own box and has no business being silent. `development_root_missing`
and `describe_development_root` separate them, so a caller can stay quiet for
the first and speak up for the second (open-brain#556).

What this module does NOT do: it does not read config, contact a server, or
decide anything about memory. It answers one question about one path. It also
does not decide what a caller does with a diagnosis — it renders the text and
leaves the verdict to the gate, whose fail posture is its own.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Final

__all__ = [
    "APPROVED_TEMP_WORKTREE_ROOTS",
    "DEFAULT_DEVELOPMENT_ROOT",
    "development_root",
    "development_root_missing",
    "DevelopmentScope",
    "ScopeDiagnosis",
    "approved_temp_worktree_path",
    "describe_development_root",
    "render_scope_diagnosis",
    "resolve_development_scope",
]

#: The environment variable that overrides the shipped root. Named once here so
#: the diagnosis can quote the exact spelling an operator has to export.
DEVELOPMENT_ROOT_ENV_VAR: Final[str] = "OPENBRAIN_DEVELOPMENT_ROOT"

#: ob-memory-provider.ts:143. The one lane root, as shipped. Public because the
#: parity fixtures were recorded against it and have to recognise it by name.
DEFAULT_DEVELOPMENT_ROOT: Final[Path] = Path.home() / "Development"


def development_root() -> Path:
    """Return the Development lane root.

    Read per call rather than frozen at import, and overridable via
    `OPENBRAIN_DEVELOPMENT_ROOT`, for one reason: this module answers by asking
    the FILESYSTEM -- `_canonical_directory` requires the path to exist and be a
    directory. On any machine without this exact macOS volume (a Linux CI
    runner, a container) every scope resolves to None, the gate correctly falls
    silent, and every test depending on a resolved scope then asserts against
    silence. That shipped green locally and failed 11 tests on CI.

    A module constant could not fix it: it is evaluated when the module is first
    imported, which under pytest happens during collection -- before a conftest
    can set the variable. A function has no such ordering to get wrong.

    The TypeScript already threads `developmentRoot` as a parameter through its
    helpers (`ob-memory-provider.ts:1455-1469`) and pins it only at the entry
    point; this is that same seam.

    Returns:
        The override when set and non-empty, else the shipped default. The
        default is unchanged, so production behaviour is identical.
    """
    override = os.environ.get(DEVELOPMENT_ROOT_ENV_VAR, "").strip()
    return Path(override) if override else DEFAULT_DEVELOPMENT_ROOT


def development_root_missing() -> bool:
    """Report whether the configured Development root is absent on this machine.

    This is the half of a `None` scope that is a MISCONFIGURATION rather than a
    correct silence. Kept separate from :func:`resolve_development_scope` on
    purpose: a caller in somebody else's repository asks about a cwd and should
    hear nothing, while a caller on a machine whose root does not exist has a
    problem no amount of cwd changing will fix.

    Returns:
        True when the configured root is not an existing directory.
    """
    return _canonical_directory(development_root()) is None


@dataclass(frozen=True)
class ScopeDiagnosis:
    """Why scope could not resolve, in the terms an operator can act on.

    Attributes:
        configured_root: The root that was consulted and found absent.
        source: Where that value came from -- the env var name, or ``default``.
        cwd: The directory actually measured, never a composed substitute.
    """

    configured_root: Path
    source: str
    cwd: Path


def describe_development_root(cwd: str | Path | None) -> ScopeDiagnosis | None:
    """Describe an absent Development root, or None when nothing is wrong.

    Args:
        cwd: The directory the caller is actually in. Recorded as measured; a
            caller that has no cwd to report gets the process's, because a
            diagnosis quoting a composed path is the defect this closes.

    Returns:
        The diagnosis when the configured root does not exist, else None. An
        existing root always answers None, even when the cwd is out of lane --
        that case is not a misconfiguration and must stay silent.
    """
    if not development_root_missing():
        return None
    override = os.environ.get(DEVELOPMENT_ROOT_ENV_VAR, "").strip()
    measured = Path(cwd) if cwd is not None else Path.cwd()
    return ScopeDiagnosis(
        configured_root=development_root(),
        source=DEVELOPMENT_ROOT_ENV_VAR if override else "default",
        cwd=measured,
    )


def render_scope_diagnosis(diagnosis: ScopeDiagnosis) -> str:
    """Render a diagnosis as the operator-facing line.

    Three facts, in the order a reader needs them: the root that was consulted
    and where that value came from, the directory actually measured, and the one
    command that resolves it. The cwd is labelled, so the configured root can
    never be misread as the session's directory -- which is exactly what
    happened on the Air (open-brain#556).

    Args:
        diagnosis: The absent-root diagnosis.

    Returns:
        A single multi-line string, safe for stderr or a receipt field.
    """
    origin = (
        "shipped default"
        if diagnosis.source == "default"
        else f"set via {DEVELOPMENT_ROOT_ENV_VAR}"
    )
    return (
        "Open Brain: the configured Development root does not exist on this "
        "machine.\n"
        f"  configured root: {diagnosis.configured_root} ({origin})\n"
        f"  cwd: {diagnosis.cwd}\n"
        f"  fix: export {DEVELOPMENT_ROOT_ENV_VAR}=<this machine's Development "
        "directory>"
    )


#: ob-memory-provider.ts:144-147. A worktree under one of these still counts as
#: Development work, but only when git agrees it is the same repository — see
#: :func:`resolve_development_scope`.
APPROVED_TEMP_WORKTREE_ROOTS: Final[tuple[Path, ...]] = (
    Path(os.environ.get("OPENBRAIN_TEMP_WORKSPACE", Path.home() / ".cache/open-brain")),
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
    development = _canonical_directory(development_root())
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

        None does NOT distinguish "not my repository" from "the configured root
        is absent on this machine". A caller that reports anything to an
        operator must ask :func:`describe_development_root` before falling
        silent, or it reproduces open-brain#556.
    """
    if cwd is None:
        return None
    root = _canonical_directory(development_root())
    candidate = _canonical_directory(cwd)
    if root is None or candidate is None:
        return None
    if _is_within(candidate, root):
        return DevelopmentScope(cwd=candidate, project=_project_slug(candidate))
    if approved_temp_worktree_path(candidate) and _same_git_repository(candidate, root):
        return DevelopmentScope(cwd=candidate, project=_project_slug(candidate))
    return None
