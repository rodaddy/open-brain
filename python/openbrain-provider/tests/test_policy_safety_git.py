"""Protected-branch behavior for the policy safety gate."""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest
from gate_harness import GateResult, run_policy_gate

PROTECTED_REF_REASON = "do not commit or push directly to main/master"
PROTECTED_BRANCH_REASON = "do not commit or push from a protected branch"


def _git(cwd: Path, *args: str) -> None:
    """Run one fixture-only git command."""
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo(path: Path, branch: str) -> None:
    """Create a committed repository on ``branch`` for branch-state tests."""
    path.mkdir()
    _git(path, "init", "-b", branch)
    _git(path, "config", "user.name", "Policy Safety Test")
    _git(path, "config", "user.email", "policy-safety@example.invalid")
    (path / "tracked.txt").write_text("fixture\n", encoding="utf8")
    _git(path, "add", "tracked.txt")
    _git(path, "commit", "-m", "fixture")


@pytest.fixture
def main_with_feature_worktree(tmp_path: Path) -> tuple[Path, Path]:
    """Return a main checkout and a linked feature worktree."""
    primary = tmp_path / "primary-main"
    feature = tmp_path / "feature-worktree"
    _init_repo(primary, "main")
    _git(primary, "worktree", "add", "-b", "feature/guard-fix", str(feature))
    return primary, feature


@pytest.fixture
def feature_with_main_worktree(tmp_path: Path) -> tuple[Path, Path]:
    """Return a feature checkout and a linked main worktree."""
    primary = tmp_path / "primary-feature"
    main_worktree = tmp_path / "main-worktree"
    _init_repo(primary, "feature/guard-fix")
    _git(primary, "branch", "main")
    _git(primary, "worktree", "add", str(main_worktree), "main")
    return primary, main_worktree


def _run(command: str, cwd: Path, state_path: Path) -> GateResult:
    """Run one Bash PreToolUse event through the real policy gate."""
    return run_policy_gate(
        state_path,
        "pre-tool-use",
        {
            "cwd": str(cwd),
            "tool_name": "Bash",
            "tool_input": {"command": command},
        },
    )


def test_feature_push_followed_by_pr_base_main_is_allowed(
    main_with_feature_worktree: tuple[Path, Path], tmp_path: Path
) -> None:
    primary, feature = main_with_feature_worktree
    command = (
        f"cd '{feature}' && git push -u origin feature/guard-fix "
        "&& gh pr create --base main --head feature/guard-fix"
    )

    result = _run(command, primary, tmp_path / "state.json")

    assert not result.blocked


def test_git_dash_c_feature_push_is_allowed(
    main_with_feature_worktree: tuple[Path, Path], tmp_path: Path
) -> None:
    primary, feature = main_with_feature_worktree

    result = _run(
        f"git -C {feature} push -u origin feature/guard-fix",
        primary,
        tmp_path / "state.json",
    )

    assert not result.blocked


@pytest.mark.parametrize(
    "refspec",
    ["main", "HEAD:main", ":main", "+HEAD:refs/heads/master"],
)
def test_push_to_main_is_refused(tmp_path: Path, refspec: str) -> None:
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")

    result = _run(
        f"git push origin {refspec}", repo, tmp_path / f"state-{refspec}.json"
    )

    assert result.blocked
    assert PROTECTED_REF_REASON in result.stdout


@pytest.mark.parametrize(
    "command",
    [
        "git push main feature/guard-fix",
        "git push -o main origin feature/guard-fix",
        "git push --receive-pack main origin feature/guard-fix",
        "git push --repo main feature/guard-fix",
        "git push origin feature/guard-fix && echo main",
        "git push origin feature/guard-fix && gh pr create --base main",
    ],
)
def test_non_ref_main_operands_are_allowed(tmp_path: Path, command: str) -> None:
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")

    result = _run(command, repo, tmp_path / "state.json")

    assert not result.blocked


@pytest.mark.parametrize(
    "command",
    [
        "git push --force-with-lease origin main",
        "git push --signed origin main",
        "git push --repo origin main",
        "env -u UNUSED git push origin main",
        "command -- git push origin main",
        "exec git push origin main",
        "nohup git push origin main",
        "sudo -u root git push origin main",
    ],
)
def test_flagged_push_to_main_is_still_refused(tmp_path: Path, command: str) -> None:
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")

    result = _run(command, repo, tmp_path / "state.json")

    assert result.blocked
    assert PROTECTED_REF_REASON in result.stdout


def test_unquoted_commit_message_main_is_allowed(tmp_path: Path) -> None:
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")

    result = _run("git commit -m main", repo, tmp_path / "state.json")

    assert not result.blocked


def test_cd_feature_worktree_push_uses_feature_branch(
    main_with_feature_worktree: tuple[Path, Path], tmp_path: Path
) -> None:
    primary, feature = main_with_feature_worktree

    result = _run(f"cd {feature} && git push", primary, tmp_path / "state.json")

    assert not result.blocked


def test_cd_main_worktree_commit_is_refused(
    feature_with_main_worktree: tuple[Path, Path], tmp_path: Path
) -> None:
    primary, main_worktree = feature_with_main_worktree

    result = _run(f"cd {main_worktree} && git commit", primary, tmp_path / "state.json")

    assert result.blocked
    assert PROTECTED_BRANCH_REASON in result.stdout


def test_heredoc_body_is_not_parsed_as_a_command(tmp_path: Path) -> None:
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")
    command = "git commit -F - <<'MSG'\nnotes: git push origin main\nMSG"

    result = _run(command, repo, tmp_path / "state.json")

    assert not result.blocked


def test_quoted_heredoc_marker_does_not_hide_a_later_push(tmp_path: Path) -> None:
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")
    command = "echo '<<' MSG\ngit push origin main\nMSG"

    result = _run(command, repo, tmp_path / "state.json")

    assert result.blocked
    assert PROTECTED_REF_REASON in result.stdout


def test_unreadable_branch_still_fails_closed(tmp_path: Path) -> None:
    non_repo = tmp_path / "not-a-repo"
    non_repo.mkdir()

    result = _run("git push", non_repo, tmp_path / "state.json")

    assert result.blocked
    assert "unable to verify the current branch" in result.stdout


@pytest.mark.parametrize(
    "command",
    [
        "git commit -m 'subject line\n\nbody line'",
        "git commit -m 'chore: land it\n\nnotes: push origin main was avoided'",
    ],
)
def test_multiline_quoted_message_resolves_the_real_branch(
    tmp_path: Path, command: str
) -> None:
    """Issue 740 D2: a newline inside the quoted message must not fail closed."""
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")

    result = _run(command, repo, tmp_path / "state.json")

    assert not result.blocked


def test_quoted_message_naming_main_on_a_feature_branch_is_allowed(
    tmp_path: Path,
) -> None:
    """Issue 618: conviction comes from branch state, never from message text."""
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")

    result = _run(
        "git commit -m 'fix: stop pushing to main by accident'",
        repo,
        tmp_path / "state.json",
    )

    assert not result.blocked


def test_multiline_quoted_message_on_main_is_still_refused(tmp_path: Path) -> None:
    """The parser fix must not weaken the protected-branch rule itself."""
    repo = tmp_path / "main-repo"
    _init_repo(repo, "main")

    result = _run("git commit -m 'subject\n\nbody'", repo, tmp_path / "state.json")

    assert result.blocked
    assert PROTECTED_BRANCH_REASON in result.stdout


def test_unverifiable_branch_message_names_what_failed(tmp_path: Path) -> None:
    """Issue 740 D3: the refusal states the command run and what it returned."""
    non_repo = tmp_path / "not-a-repo"
    non_repo.mkdir()

    result = _run("git push", non_repo, tmp_path / "state.json")

    assert result.blocked
    assert "git branch --show-current" in result.stdout
    assert str(non_repo) in result.stdout
    assert "exited" in result.stdout


def _approve_main_push(repo: Path, expires: int) -> None:
    """Write the marker `_ob/bin/approve-main-push` writes, with one expiry."""
    git_dir = subprocess.run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    (Path(git_dir) / "guard-main-push-approved").write_text(
        f"expires={expires}\n", encoding="utf8"
    )


def test_push_to_main_with_a_live_approval_marker_is_allowed(
    tmp_path: Path,
) -> None:
    """Rico ruling 2026-09-11: the marker IS the explicit approval the refusal names."""
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")
    _approve_main_push(repo, int(time.time()) + 600)

    result = _run("git push origin main", repo, tmp_path / "state.json")

    assert not result.blocked


def test_push_to_main_with_an_expired_marker_is_refused(tmp_path: Path) -> None:
    """A past expiry is a missing approval: the marker cannot become standing."""
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")
    _approve_main_push(repo, int(time.time()) - 1)

    result = _run("git push origin main", repo, tmp_path / "state.json")

    assert result.blocked
    assert PROTECTED_REF_REASON in result.stdout


def test_malformed_marker_is_refused(tmp_path: Path) -> None:
    """Anything but one `expires=<epoch>` line keeps the guard refusing."""
    repo = tmp_path / "feature-repo"
    _init_repo(repo, "feature/guard-fix")
    git_dir = repo / ".git"
    (git_dir / "guard-main-push-approved").write_text("yes\n", encoding="utf8")

    result = _run("git push origin main", repo, tmp_path / "state.json")

    assert result.blocked


def test_git_dash_c_push_to_main_reads_the_target_repo_marker(
    tmp_path: Path,
) -> None:
    """`git -C <repo> push origin main` is judged by <repo>'s marker, not the cwd's."""
    approved = tmp_path / "approved-repo"
    _init_repo(approved, "feature/guard-fix")
    _approve_main_push(approved, int(time.time()) + 600)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()

    result = _run(
        f"git -C {approved} push origin main", elsewhere, tmp_path / "state.json"
    )

    assert not result.blocked
