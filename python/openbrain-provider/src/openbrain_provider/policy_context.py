"""The policy text the refresh gate injects.

Purpose:
    The startup block, the stale-context notice, the post-compact standing
    requirements, and the refresh confirmation — the four pieces of prose this
    gate exists to put in front of an agent at the right moment.

Architecture:
    Text only. No state, no decisions. The one non-trivial function reads the
    runtime fast-path block out of a source-owned ``AGENTS.md`` for non-Claude
    runtimes, so that block has ONE home and this gate quotes it rather than
    keeping a second copy that drifts.

Pattern/Convention:
    Byte-identical to ``policy-refresh-gate.ts:539-633``. These strings are
    compared against recordings of the live gate, so an edit here is a
    behaviour change, not a wording change.

See Also:
    - ``_ob/scripts/policy-refresh-gate.ts`` — the TypeScript this ports
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

__all__ = [
    "post_compact_requirements",
    "refresh_context",
    "stale_context",
    "startup_context",
]

#: The markers delimiting the fast-path block inside a source-owned AGENTS.md.
_FAST_PATH_START: Final[str] = "<!-- runtime-fast-path:start -->"
_FAST_PATH_END: Final[str] = "<!-- runtime-fast-path:end -->"

#: Runtimes whose startup hydration is already done by the Python adapter.
_DIRECT_HYDRATION_RUNTIMES: Final[frozenset[str]] = frozenset({"claude", "claudex"})

_DEVELOPMENT_AGENTS: Final[Path] = Path("/Volumes/ThunderBolt/Development/AGENTS.md")


def _runtime_fast_path_block(command_cwd: str, runtime: str) -> str:
    """Return the runtime-specific fast-path section.

    Args:
        command_cwd: The session's working directory.
        runtime: The active runtime.

    Returns:
        The section, or an empty string when no source supplies one.

    For Claude/Claudex the answer is fixed, because hydration is already done by
    the package-owned SessionStart adapter and the visible ``OB ✓ gate passed``
    line is the proof. For every other runtime the block is READ from the
    source-owned ``AGENTS.md`` rather than restated here — a second copy of a
    startup recipe is a copy that will be stale the first time the real one
    changes.
    """
    if runtime in _DIRECT_HYDRATION_RUNTIMES:
        return "\n".join(
            [
                "",
                "## Runtime Fast Path",
                "Claude/Claudex startup memory hydration is already performed by "
                "the package-owned direct Open Brain SessionStart adapter.",
                "- Do not run `mcp2cli open-brain`; that operational path is "
                "retired and blocked for Claude.",
                "- Treat the visible `OB ✓ gate passed` line as the direct-recall "
                "proof.",
                "- Use `/Volumes/ThunderBolt/Development/_ob/repo-context/"
                "development.md` only when direct recall is missing, stale, or "
                "reports `OB ✗ gate unavailable`.",
            ]
        )

    candidates = [Path(command_cwd) / "AGENTS.md", _DEVELOPMENT_AGENTS]
    for path in candidates:
        try:
            text = path.read_text(encoding="utf8")
        except OSError:
            continue
        start = text.find(_FAST_PATH_START)
        end = text.find(_FAST_PATH_END)
        if start < 0 or end <= start:
            continue
        block = text[start : end + len(_FAST_PATH_END)]
        return "\n".join(
            [
                "",
                "## Runtime Fast Path",
                "This block was loaded from the source-owned AGENTS.md. For "
                "startup hydration, run its direct UUID recipe before any help, "
                "schema, semantic search, or broad filesystem discovery; then run "
                "its validator and proceed with the user's action.",
                block,
            ]
        )
    return ""


def startup_context(command_cwd: str, runtime: str) -> str:
    """Render the session-start policy block.

    Args:
        command_cwd: The session's working directory.
        runtime: The active runtime.

    Returns:
        The multi-line block.

    Critical mode is deliberately NOT injected as a default. It is an INVOKED
    command precisely because a mode that is always on stops being a mode — the
    challenge degrades into a required field, and invoking it then buys nothing
    because there is no contrast to switch into. What stays on is the part that
    should never be a toggle: verify before asserting, and do not agree
    reflexively.
    """
    fast_path = _runtime_fast_path_block(command_cwd, runtime)
    # NOTE: no blank line after the heading. The TypeScript builds this array
    # with a `""` separator and then calls `.filter(Boolean)` to drop an absent
    # fast-path block -- which drops the separator too. That is emitted
    # behaviour, verified against a recording of the live gate, so reinstating
    # the "obviously intended" blank line would be a parity failure.
    lines = [
        "<!-- Development Policy Refresh: session-start -->",
        "## Development Policy Refresh",
        "- Pony style is active by default: identify the owning boundary, make "
        "the smallest correct owned change, preserve callers/invariants, and "
        "verify.",
        '- Say what you mean: verify before asserting. Every factual claim about '
        "the system comes from something checked this session, not memory or "
        'inference. Name the exact object. "I don\'t know yet" is a complete '
        "answer; a guess in the grammar of a fact is not. Do not agree "
        "reflexively, and do not manufacture a concern to look rigorous.",
        "- ADHD output shaping is active by default for user-facing responses: "
        "lead with the next concrete action, number multi-step work, restate "
        "state each turn, suppress tangents, give task-only time estimates, and "
        "make wins visible (`_ob/skills/adhd-mode/_DOCS/procedure.md`).",
        "- Source-of-truth order: live/source files and current system state beat "
        "OB/qmd, which beat compacted memory or recalled summaries.",
        "- Hard local rules: no `/bin/bash` on macOS, no system Python for "
        "project processes, temp work under `{temp_workspace}/{project-or-repo}/"
        "...` with stale artifacts moved to `_archive/`, temp has no lifetime "
        "persistence guarantee, no raw `rm -f`/`rm -rf` temp cleanup, no secrets "
        "in logs/git, no protected-branch mutation.",
        "- After compaction, resume, or phase change, reread the active router "
        "and triggered SOPs before risky action.",
        "- Model routing: the head/controller is Claude Opus 5 at high effort and "
        "is also the normal Claude workhorse; every worker runs as a Workflow "
        "`agent()` node, with Claude workers as direct native Workflow models and "
        "Codex Luna/Sol/Terra through the Workflow-owned non-native "
        "`codex:codex-rescue` integration; runners own code swarms, highly "
        "parallel mutation, clean repro, dirty experiments, heavy dependencies, "
        "detached jobs, and best-of-N; Sonnet max medium; Fable only as an "
        "explicit non-default low/medium/high route; never Ultra or reasoning "
        "above high.",
    ]
    if fast_path:
        lines.append(fast_path)
    lines.append("<!-- End Development Policy Refresh -->")
    return "\n".join(lines)


def stale_context(reason: str) -> str:
    """Render the stale-policy notice.

    Args:
        reason: Why policy went stale.

    Returns:
        The multi-line notice.
    """
    return "\n".join(
        [
            "<!-- Development Policy Refresh Required -->",
            "Policy refresh is required before risky action.",
            f"Reason: {reason}.",
            "Reread the active router plus triggered SOPs, then restate Pony "
            "style, critical mode, source order, and next action.",
            "<!-- End Development Policy Refresh Required -->",
        ]
    )


def post_compact_requirements() -> str:
    """Render the requirements that survive a compaction.

    Returns:
        The multi-line block. These are restated because a compaction summary
        keeps whatever it keeps, and "the summary probably mentioned it" is not
        a control.
    """
    return "\n".join(
        [
            "<!-- Post-Compact Standing Requirements -->",
            "## Post-Compact Standing Requirements",
            "",
            "These requirements survive compaction regardless of what the summary "
            "retained:",
            "",
            "- The pre-merge review gauntlet is MANDATORY at every PR boundary for "
            "non-trivial behavior/logic changes. Do not mark a PR ready, merge, or "
            "declare a slice complete without it.",
            "- Canonical procedure: `/Volumes/ThunderBolt/Development/_ob/skills/"
            "pre-merge-gauntlet/SKILL.md` (registry: `_ob/skills/registry.json`). "
            "Reread it before the next PR-boundary action -- do not run the "
            "gauntlet from memory of the pre-compact context.",
            "- Reviews run at PR boundaries only; review weight is tiered by blast "
            "radius (full gauntlet for repo-set/deploy-path code; lighter "
            "single-review tier for dev tooling/docs). The skill defines the "
            "current ordering.",
            "<!-- End Post-Compact Standing Requirements -->",
        ]
    )


def refresh_context(refreshed: int) -> str:
    """Render the confirmation printed after an explicit refresh.

    Args:
        refreshed: How many session states were marked refreshed.

    Returns:
        The multi-line confirmation, including what must be restated.
    """
    plural = "" if refreshed == 1 else "s"
    return "\n".join(
        [
            f"Policy refresh marked complete for {refreshed} session state{plural}.",
            "",
            "Restate before acting:",
            "- Pony: owning boundary, smallest correct owned change, verify.",
            "- Critical: challenge assumptions, surface risk, ask if ambiguity "
            "matters.",
            "- Source order: source/live state > OB/qmd > memory/summary.",
            "- Next action must name the controlling SOPs and concrete "
            "verification.",
        ]
    )
