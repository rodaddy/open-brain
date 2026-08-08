"""The unconditional safety blocks the policy gate enforces on every tool call.

Purpose:
    These refusals do not depend on policy staleness, on a session, or on any
    state at all. They are hard blocks on a small set of operations that have
    each already cost real work, and each one carries the incident that put it
    here.

Architecture:
    Pure functions over a tool name and its arguments. No state, no I/O except
    one `git` call to read the current branch. Split out of the entrypoint
    because a safety refusal and a staleness refusal are different mechanisms
    with different triggers, and mixing them in one function is how one hides
    the other (`_plans/python-port-sequence.md`, the two-mechanisms-in-one-file
    finding).

Pattern/Convention:
    A block returns a REASON STRING; allow returns ``None``. The reason is
    operator-facing text naming the correct action, not just the refusal —
    "there is no such path, use this one" leaves nothing to route around,
    where a bare "denied" invites a rephrase.

See Also:
    - ``_ob/scripts/policy-refresh-gate.ts:375-479`` — the TypeScript this ports
"""

from __future__ import annotations

import os
import re
import subprocess
from typing import Any, Final

__all__ = [
    "SHELL_TOOLS",
    "is_risky_tool",
    "pre_tool_advisory",
    "pre_tool_safety_block_reason",
    "tmp_write_block_reason",
]

#: Every spelling of "run a command" across the runtimes.
SHELL_TOOLS: Final[frozenset[str]] = frozenset(
    {"bash", "shell", "exec_command", "functions.exec_command"}
)

#: Every spelling of "write a file".
_FILE_TOOLS: Final[frozenset[str]] = frozenset({"write", "edit", "notebookedit"})

#: policy-refresh-gate.ts:264-277 — tools whose use is risky while policy is
#: stale, in every spelling the runtimes send.
_RISKY_FILE_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "write",
        "edit",
        "notebookedit",
        "apply_patch",
        "function.apply_patch",
        "functions.apply_patch",
        "function.write",
        "functions.write",
        "function.edit",
        "functions.edit",
        "function.notebookedit",
        "functions.notebookedit",
    }
)

#: policy-refresh-gate.ts:285-287 — shell commands that mutate something.
_RISKY_COMMAND_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\b(git\s+(commit|push|merge|rebase|checkout|switch|reset)|rm\s+-|mv\s+|cp\s+"
    r"|scp\s+|ssh\s+|sudo\s+|bun\s+run|npm\s+|pnpm\s+|uv\s+|python\d?\s+|psql\s+"
    r"|launchctl\s+|brew\s+(install|upgrade|services))\b"
)

#: policy-refresh-gate.ts:316-321. Stated as ABSENCE, not prohibition: a rule
#: invites negotiation, "there is no such path" does not. The message names the
#: real location so the next attempt is correct rather than merely different.
_TMP_REMEDY: Final[str] = (
    "There is no writable system temp directory on this machine. $TMPDIR is "
    "already pointed at this repo's temp workspace, so just use it, or write to "
    "{temp_workspace}/{project-or-repo}/_scratch/ directly "
    # NOT scrubbed (#636): this module is a byte-parity port of
    # `_ob/scripts/policy-refresh-gate.ts:320`, which lives outside this repo and
    # still emits this exact sentence. `tests/test_ts_parity.py` asserts the two
    # answers are identical, so neutralising only this side fails that contract.
    # Scrubbing it means changing the TypeScript twin first.
    "(/Volumes/ThunderBolt/_tmp on this Mac, /mnt/collab/tmp_space on cc-* boxes). "
    "Temp policy: _DOCS/CODING_STANDARDS.md ## Workspace Hygiene."
)

#: policy-refresh-gate.ts:355. `$TMPDIR` is deliberately NOT matched: every repo
#: now points it at its own temp-workspace bucket, so writing there is the
#: CORRECT behaviour and flagging it would punish the right answer. Only literal
#: system temp paths are refused.
_TMP_PATH: Final[str] = r"(?:/private)?/tmp/|/var/tmp/"
_TMP_FILE_PATH: Final[re.Pattern[str]] = re.compile(
    r"^/(?:private/)?tmp(?:/|$)|^/var/tmp(?:/|$)"
)
_TMP_ANYWHERE: Final[re.Pattern[str]] = re.compile(_TMP_PATH)
_TMP_REDIRECT: Final[re.Pattern[str]] = re.compile(
    rf"(?:^|[^>\d])\d?>>?\s*[\"']?(?:{_TMP_PATH})"
)
_TMP_WRITER: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|(])"
    r"(?:cp|mv|rsync|touch|mkdir|install|tee|dd|curl|wget|git\s+clone|tar|unzip|zip)"
    rf"\b[^\n;|&]*?(?:{_TMP_PATH})"
)

#: policy-refresh-gate.ts:419-436 — the git and gh operations that need an
#: explicit human decision.
_GIT_RESET_HARD: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|()])git\s+reset\s+--hard(?:\s|$)", re.IGNORECASE
)
_GIT_CHECKOUT_DISCARD: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|()])git\s+checkout\s+--(?:\s|$)", re.IGNORECASE
)
_GIT_SWITCH_PROTECTED: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|()])git\s+(?:checkout|switch)\s+(?:main|master)(?:\s|$)", re.IGNORECASE
)
_CLAUDE_WORKTREE: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|()])claude\s+(?:(?![#\n]).)*--worktree(?:[=\s]|$)"
)
_GH_PR_MERGE: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|()])gh\s+pr\s+merge(?:\s|$)"
)
_GH_MERGE_AUTOMATIC: Final[re.Pattern[str]] = re.compile(
    r"(?:^|\s)--(?:admin|auto)(?:\s|$)"
)
_GIT_MUTATES_HISTORY: Final[re.Pattern[str]] = re.compile(
    r"(^|[\s;&|()])git\s+(?:commit|push)(?:\s|$)", re.IGNORECASE
)
_PROTECTED_REF: Final[re.Pattern[str]] = re.compile(
    r"\b(?:origin\s+)?(?:main|master)(?::|(?:\s|$))", re.IGNORECASE
)
_DOUBLE_QUOTED: Final[re.Pattern[str]] = re.compile(r'"(?:[^"\\]|\\.)*"')
_SINGLE_QUOTED: Final[re.Pattern[str]] = re.compile(r"'[^']*'")

#: policy-refresh-gate.ts:466-473 — the transient image-output directory.
_GENERATED_DIR: Final[str] = (
    r"(?:~/\.codex/generated_images/|/Users/rico/\.codex/generated_images/"
    r"|\$HOME/\.codex/generated_images/|\$\{HOME\}/\.codex/generated_images/)"
)
_WRITES_INTO_GENERATED: Final[re.Pattern[str]] = re.compile(
    rf"(?:>|>>|\b(?:cp|mv|rsync|curl|wget|touch|mkdir|install|tee|dd)\b)"
    rf"[^\n;|]*?{_GENERATED_DIR}"
)
_GENERATED_EGRESS: Final[re.Pattern[str]] = re.compile(
    rf"^\s*(?:cp|mv)\s+(?:--\s+)?[\"']?{_GENERATED_DIR}[^\s\"']+[\"']?\s+"
    rf"[\"']?(?!/Users/rico/\.codex(?:/|$))/[^\s\"']+[\"']?\s*$"
)

#: A branch read that hangs would hang the hook.
_GIT_TIMEOUT_SECONDS: Final[float] = 0.5


def _command_of(tool_input: dict[str, Any]) -> str:
    """Return the command a shell tool call carries, in any spelling."""
    for key in ("command", "cmd", "cmdline"):
        value = tool_input.get(key)
        if value:
            return str(value)
    return ""


def _file_path_of(tool_input: dict[str, Any]) -> str:
    """Return the path a file tool call targets, in any spelling."""
    for key in ("file_path", "filePath", "path"):
        value = tool_input.get(key)
        if value:
            return str(value)
    return ""


def tmp_write_block_reason(
    normalized_name: str, tool_input: dict[str, Any]
) -> str | None:
    """Refuse a WRITE into a system temp path, and only a write.

    Args:
        normalized_name: Lowercased tool name.
        tool_input: The tool's arguments.

    Returns:
        The refusal text, or None.

    WHY THIS IS A HOOK AND NOT A RULE. It is the single most-repeated
    instruction in this repo set and it kept being violated anyway, usually as a
    one-line redirect buried inside a larger task. `/tmp` is on the small main
    disk, and on macOS it is per-process sandbox-local: an artifact written
    there is invisible to runners and to the operator, so "I saved it to /tmp"
    silently means the work is gone.

    READS ARE ALLOWED. Only writes are refused. Plenty of legitimate work reads
    system-owned paths under `/tmp` (sockets, other processes' files), and
    blocking those would break real tasks and teach agents to route around the
    guard.
    """
    if normalized_name in _FILE_TOOLS:
        path = _file_path_of(tool_input)
        if _TMP_FILE_PATH.search(path):
            return (
                f"That path does not exist as an agent-writable location. {_TMP_REMEDY}"
            )
        return None

    if normalized_name not in SHELL_TOOLS:
        return None

    command = _command_of(tool_input)
    if not command or not _TMP_ANYWHERE.search(command):
        return None

    # `mktemp` is deliberately allowed: it resolves through $TMPDIR, which every
    # repo points at its own temp-workspace bucket. `mktemp -p /tmp` still trips
    # the literal-path check.
    if _TMP_REDIRECT.search(command) or _TMP_WRITER.search(command):
        return (
            "That path is not an agent-writable location: it is on the small main "
            "disk and is sandbox-local, so anything written there is invisible to "
            f"runners and to the operator. {_TMP_REMEDY}"
        )
    return None


def _agent_tool_block_reason(env: dict[str, str]) -> str | None:
    """Refuse a direct Agent/Task call only under a proxied session.

    Args:
        env: Environment mapping.

    Returns:
        The refusal text under Claudex, or None on a native session.

    The failure this prevents is proxy-specific. Under Claudex,
    `ANTHROPIC_BASE_URL` points at CLIProxyAPI, and an unrouted Agent call
    silently collapses the worker to the head model -- a Sol session reviewing
    its own work while the record says Opus did. A native session talks to
    Anthropic directly and cannot reach that failure mode, so blocking there
    would refuse a safe operation to prevent an impossible one.

    `--runtime claude` is NOT the test: it is true for both cases. The proxy
    variable is the honest signal. This block used to be unconditional, and the
    cost was not just a refused call -- a native session that hits it infers it
    must be under the Claudex contract and then defends that belief, because a
    hook that BEHAVES like Claudex is more persuasive than prose saying it is not.
    """
    if not env.get("ANTHROPIC_BASE_URL"):
        return None
    return (
        "Direct Agent and Task tools are disabled under Claudex: ANTHROPIC_BASE_URL "
        "routes through CLIProxyAPI, where an unrouted call collapses the worker to "
        "the head model. Launch workers only through a Workflow `agent()` node with "
        "the model and effort pinned per _DOCS/MODEL_ROUTING.md."
    )


def _git_history_block_reason(command: str, command_cwd: str) -> str | None:
    """Refuse a commit or push that would land on a protected branch.

    Args:
        command: The shell command.
        command_cwd: Directory the command would run in.

    Returns:
        The refusal text, or None.
    """
    if not _GIT_MUTATES_HISTORY.search(command):
        return None
    # Test the ref pattern only OUTSIDE quoted strings: a commit message
    # containing the English word "main" is not a push to main. Refspecs
    # (`git push origin main`) are unquoted and still match.
    outside_quotes = _SINGLE_QUOTED.sub("''", _DOUBLE_QUOTED.sub('""', command))
    if _PROTECTED_REF.search(outside_quotes):
        return (
            "Codex git guard: do not commit or push directly to main/master "
            "without explicit approval."
        )
    try:
        completed = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=command_cwd or None,
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return (
            "Codex git guard: unable to verify the current branch; commit/push is "
            "blocked until branch state is readable."
        )
    branch = completed.stdout.strip()
    if branch in ("main", "master"):
        return (
            f"Codex git guard: current branch is {branch}; do not commit or push "
            "from a protected branch."
        )
    return None


def _shell_safety_block_reason(command: str, command_cwd: str) -> str | None:
    """Refuse the shell commands that need an explicit human decision.

    Args:
        command: The shell command.
        command_cwd: Directory the command would run in.

    Returns:
        The refusal text, or None.
    """
    if _GIT_RESET_HARD.search(command):
        return "Codex git guard: `git reset --hard` needs explicit user approval."
    if _GIT_CHECKOUT_DISCARD.search(command):
        return (
            "Codex git guard: `git checkout --` can discard work and needs "
            "explicit user approval."
        )
    if _GIT_SWITCH_PROTECTED.search(command):
        return (
            "Codex git guard: do not switch to main/master for work; use a "
            "focused work branch."
        )
    if _CLAUDE_WORKTREE.search(command):
        return (
            'Do not use `claude --worktree` directly. Use `gwt "name"` with the '
            "intended runtime."
        )
    if _GH_PR_MERGE.search(command) and _GH_MERGE_AUTOMATIC.search(command):
        return (
            "Codex merge guard: do not use `gh pr merge --admin/--auto`. Inspect "
            "checks and merge deliberately."
        )

    history = _git_history_block_reason(command, command_cwd)
    if history is not None:
        return history

    if _WRITES_INTO_GENERATED.search(command) and not _GENERATED_EGRESS.search(command):
        return (
            # Byte-parity with `policy-refresh-gate.ts:475`; see the note on
            # TEMP_GUIDANCE above. Not scrubbed for the same reason (#636).
            "Treat ~/.codex/generated_images as transient output. Move the selected "
            "image to /Volumes/ThunderBolt/_tmp/_image-gen2/ or the user-requested "
            "destination."
        )
    return None


def pre_tool_safety_block_reason(
    name: str,
    tool_input: dict[str, Any],
    command_cwd: str,
    env: dict[str, str] | None = None,
) -> str | None:
    """Return the reason this tool call is refused outright, or None.

    Args:
        name: Tool name in any casing.
        tool_input: The tool's arguments.
        command_cwd: Directory the command would run in.
        env: Environment mapping. Defaults to ``os.environ``.

    Returns:
        Operator-facing refusal text, or None to allow.
    """
    environment = dict(os.environ) if env is None else env
    normalized = name.lower()

    tmp_write = tmp_write_block_reason(normalized, tool_input)
    if tmp_write is not None:
        return tmp_write

    if normalized in ("agent", "task"):
        return _agent_tool_block_reason(environment)
    if normalized == "enterworktree":
        if tool_input.get("path"):
            return None
        return (
            "Enter only an existing user-approved worktree path; do not create "
            "nested .claude worktrees."
        )
    if normalized not in SHELL_TOOLS:
        return None

    return _shell_safety_block_reason(_command_of(tool_input), command_cwd)


def pre_tool_advisory(
    name: str, runtime: str, env: dict[str, str] | None = None
) -> str | None:
    """Return non-blocking guidance for a direct Agent/Task call, or None.

    Args:
        name: Tool name in any casing.
        runtime: The active runtime.
        env: Environment mapping. Defaults to ``os.environ``.

    Returns:
        Advisory text, or None.

    A native session MAY use Agent/Task; the Workflow route is still preferred
    because it pins model and effort. That is guidance, not a safety rule, so it
    rides `additionalContext` instead of blocking. Codex is excluded: its
    PreToolUse honours only the FIRST verdict and treats plain stdout as allow,
    so emitting this there risks eating a real decision.
    """
    environment = dict(os.environ) if env is None else env
    if runtime == "codex":
        return None
    if environment.get("ANTHROPIC_BASE_URL"):
        return None
    if name.lower() not in ("agent", "task"):
        return None
    return (
        "Native session (no ANTHROPIC_BASE_URL): direct Agent/Task is permitted. "
        "Prefer a Workflow `agent()` node with model and effort pinned per "
        "_DOCS/MODEL_ROUTING.md when the work is a delegated worker rather than a "
        "one-off search."
    )


def is_risky_tool(name: str, tool_input: dict[str, Any]) -> bool:
    """Report whether this call is risky enough to need fresh policy.

    Args:
        name: Tool name in any casing.
        tool_input: The tool's arguments.

    Returns:
        True for a file mutation, or a shell command that mutates something.
    """
    normalized = name.lower()
    if normalized in _RISKY_FILE_TOOLS:
        return True
    if normalized not in SHELL_TOOLS:
        return False
    return _RISKY_COMMAND_PATTERN.search(_command_of(tool_input)) is not None
