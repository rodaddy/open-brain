"""The admitted worktree shapes, asserted against explicit paths.

Two shapes admit a worktree outside the Development root as Development work
(ob-memory-provider.ts ``approvedTempWorktreePath``, mirrored here):

- ``<orca root>/<project>/<name>[/...]`` -- the ONE common worktree place,
  Rico ruling 2026-09-15. Before this shape existed, a session in an Orca
  worktree resolved to no project at all, so the context-budget gate could
  never clear its own post-compact read-back from that checkout.
- ``<temp root>/<area>/_worktrees/<name>[/...]`` -- legacy, still standing.

Path-shape assertions use explicit strings, never the ambient location of the
checkout running the suite (Development #153).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from openbrain_provider.development_scope import (
    ORCA_WORKSPACES_ROOT_ENV_VAR,
    WORKTREES_ROOT_ENV_VAR,
    approved_temp_worktree_path,
    orca_workspaces_root,
    worktrees_root,
)


@pytest.fixture
def orca_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the Orca workspaces root at a real, empty directory."""
    root = tmp_path / "orca" / "workspaces"
    root.mkdir(parents=True)
    monkeypatch.setenv(ORCA_WORKSPACES_ROOT_ENV_VAR, str(root))
    return root


def test_orca_root_defaults_to_home_and_honours_the_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(ORCA_WORKSPACES_ROOT_ENV_VAR, raising=False)
    assert orca_workspaces_root() == Path.home() / "orca" / "workspaces"
    monkeypatch.setenv(ORCA_WORKSPACES_ROOT_ENV_VAR, "/elsewhere/wt")
    assert orca_workspaces_root() == Path("/elsewhere/wt")


def test_orca_worktree_shape_is_admitted(orca_root: Path) -> None:
    assert approved_temp_worktree_path(orca_root / "Development" / "dace")
    nested = orca_root / "open-brain" / "agent-abc" / "nested"
    assert approved_temp_worktree_path(nested)


@pytest.mark.parametrize(
    "relative",
    [
        "",  # the root itself
        "Development",  # a project directory is not a worktree
    ],
)
def test_orca_root_and_project_dir_alone_are_not_worktrees(
    orca_root: Path, relative: str
) -> None:
    assert not approved_temp_worktree_path(orca_root / relative)


def test_a_path_beside_the_orca_root_is_not_admitted(orca_root: Path) -> None:
    assert not approved_temp_worktree_path(orca_root.parent / "elsewhere" / "x")


@pytest.mark.parametrize(
    "path",
    [
        "/srv/_tmp/development/_worktrees/pr65-audit",
        "/mnt/shared/tmp_space/development/_worktrees/pr65-audit/nested",
    ],
)
def test_legacy_temp_worktree_shape_is_still_admitted(path: str) -> None:
    assert approved_temp_worktree_path(Path(path))


@pytest.mark.parametrize(
    "path",
    [
        "/srv/_tmp/development/_reviews/pr65-audit",
        "/srv/_tmp/development/_worktrees",
        "/srv/_tmp/_worktrees/pr65-audit",
        "/srv/review-worktrees/pr65-audit",
    ],
)
def test_other_shapes_are_rejected(path: str) -> None:
    assert not approved_temp_worktree_path(Path(path))


@pytest.fixture
def common_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point WORKTREES_ROOT at ``<tmp>/_worktrees/native``; return its parent."""
    root = tmp_path / "_worktrees"
    (root / "native").mkdir(parents=True)
    monkeypatch.setenv(WORKTREES_ROOT_ENV_VAR, str(root / "native"))
    return root


def test_worktrees_root_defaults_to_the_ts_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(WORKTREES_ROOT_ENV_VAR, raising=False)
    assert worktrees_root() == Path("/srv/_tmp/_worktrees/native")


def test_four_level_claude_worktree_is_admitted(common_root: Path) -> None:
    path = common_root / "claude" / "rodaddy" / "open-brain" / "fix-branch"
    assert approved_temp_worktree_path(path)


@pytest.mark.parametrize("harness", ["native", "codex"])
def test_other_harness_dirs_are_admitted(common_root: Path, harness: str) -> None:
    assert approved_temp_worktree_path(
        common_root / harness / "rodaddy" / "open-brain" / "b"
    )


def test_unknown_harness_dir_is_refused(common_root: Path) -> None:
    assert not approved_temp_worktree_path(
        common_root / "gsd" / "rodaddy" / "open-brain" / "b"
    )


def test_harness_and_owner_alone_are_too_shallow(common_root: Path) -> None:
    assert not approved_temp_worktree_path(common_root / "claude" / "rodaddy")


def test_a_dotdot_segment_is_refused(common_root: Path) -> None:
    assert not approved_temp_worktree_path(
        Path(f"{common_root}/claude/rodaddy/../../gsd/x/y")
    )


def test_legacy_shape_still_admitted_beside_common_root(common_root: Path) -> None:
    assert approved_temp_worktree_path(
        Path("/srv/_tmp/open-brain/_worktrees/lane-1")
    )
