"""Where the advisory speaks, and why it is not a hardcoded token count.

The nag is the gate's only routine voice. If it fires with most of the window
still free it is noise, and noise is not harmless -- a channel that cries wolf
trains the reader to skip it, so a REAL budget warning arrives pre-discredited.
That is the failure issue #77 recorded: the gate ran on a 200k default against a
~399k compaction point and nagged every turn until it was ignored.

The cause was not the number. ``openbrain-hook-env`` starts the gate with
``exec env -i`` and an allowlist carrying no ``CONTEXT_BUDGET_*`` and no
``CLAUDE_CODE_AUTO_COMPACT_WINDOW``, so the operator's configured 300000 was
stripped before the gate could read it and the stale default silently won.
These tests pin both halves: the thresholds track the ACTIVE profile's real
compaction point, and they are resolved from the settings FILE so no wrapper
allowlist can strip them.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from gate_harness import PROJECT, SESSION, GatePaths, gate_paths

from openbrain_provider import context_budget_gate
from openbrain_provider.context_budget_gate import (
    compaction_trigger,
    resolve_thresholds,
)

#: The two windows actually in service on the operator's machine, read from
#: `~/.claude/settings.json` (global) and `~/.claudex/profiles/native` and
#: `.../sol` on 2026-08-05. They differ by 53000 tokens of window and ~49000 of
#: real trigger, which is precisely why one hardcoded number cannot serve both.
_GLOBAL_WINDOW = 450_000
_CLAUDEX_WINDOW = 397_000
_PCT = 92


def _write_settings(path: Path, env: dict[str, str]) -> None:
    """Write a Claude settings file carrying ``env``."""
    path.write_text(json.dumps({"env": env}), encoding="utf8")


def _usage_transcript(root: Path, tokens: int) -> str:
    """Write a transcript whose latest assistant turn reports ``tokens`` used."""
    path = root / f"usage-{tokens}.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "user", "message": {"content": "go"}}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "role": "assistant",
                            "content": [],
                            "usage": {
                                "input_tokens": tokens,
                                "cache_read_input_tokens": 0,
                                "cache_creation_input_tokens": 0,
                            },
                        },
                    }
                ),
            ]
        ),
        encoding="utf8",
    )
    return str(path)


def _run_unpinned(
    paths: GatePaths, tokens: int, *, env: dict[str, str] | None = None
) -> dict[str, Any]:
    """Drive one ``user-prompt-submit`` WITHOUT pinning the thresholds.

    ``gate_harness.run_gate`` passes explicit ``--nag-tokens/--hard-tokens`` so
    the other suites stay independent of configuration. This file is the one
    that must exercise resolution itself, so it builds its own argv and leaves
    both flags off.
    """
    argv = [
        "--event",
        "user-prompt-submit",
        "--state-path",
        str(paths.state),
        "--receipt-state-path",
        str(paths.receipts),
        "--settings-path",
        str(paths.settings),
        "--policy-state-path",
        str(paths.policy_state),
        "--spool-path",
        str(paths.spool),
        "--session-id",
        SESSION,
        "--project",
        PROJECT,
    ]
    payload = {
        "session_id": SESSION,
        "cwd": "/path/to/open-brain/Development",
        "transcript_path": _usage_transcript(paths.root, tokens),
    }
    stdout = io.StringIO()
    context_budget_gate.main(
        argv,
        stdin=io.StringIO(json.dumps(payload)),
        stdout=stdout,
        stderr=io.StringIO(),
        env=dict(env or {}, HOME=str(paths.root)),
    )
    return {"stdout": stdout.getvalue()}


def _nag_fired(result: dict[str, Any]) -> bool:
    """Return whether the advisory banner was injected into the turn."""
    for line in result["stdout"].splitlines():
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if isinstance(payload, dict) and "hookSpecificOutput" in payload:
            return True
    return False


class TestCompactionTrigger:
    """The formula the thresholds are measured against."""

    def test_mirrors_the_live_claudex_formula(self) -> None:
        """Reserve comes off the window first, then the percentage.

        Pinned against ``~/.claudex/doctor.ts::computedCompactAt``, read
        2026-08-05. A drift here means the gate is aiming at a point that no
        longer exists, which is silent -- nothing else in the system would fail.
        """
        assert compaction_trigger(_GLOBAL_WINDOW, _PCT) == 398_926
        assert compaction_trigger(_CLAUDEX_WINDOW, _PCT) == 350_166


class TestThresholdResolution:
    """Where the numbers come from when nobody passes a flag."""

    def test_reads_the_window_from_the_settings_file(self, tmp_path: Path) -> None:
        """A stripped environment still resolves, because the FILE is read.

        This is the #77 regression in one assertion: the environment is empty,
        exactly as ``env -i`` leaves it, and the thresholds must still land on
        the real window rather than falling back to a hardcoded 200000.
        """
        settings = tmp_path / "settings.json"
        _write_settings(
            settings,
            {
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(_GLOBAL_WINDOW),
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(_PCT),
            },
        )
        nag, advisory = resolve_thresholds({}, settings)
        trigger = compaction_trigger(_GLOBAL_WINDOW, _PCT)
        assert nag > 200_000
        assert nag < advisory < trigger

    def test_each_profile_gets_its_own_thresholds(self, tmp_path: Path) -> None:
        """The 450k and 397k profiles must not resolve to the same numbers."""
        wide = tmp_path / "wide.json"
        narrow = tmp_path / "narrow.json"
        _write_settings(
            wide,
            {
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(_GLOBAL_WINDOW),
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(_PCT),
            },
        )
        _write_settings(
            narrow,
            {
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(_CLAUDEX_WINDOW),
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(_PCT),
            },
        )
        assert resolve_thresholds({}, wide)[0] > resolve_thresholds({}, narrow)[0]

    def test_advisory_leaves_actionable_runway(self, tmp_path: Path) -> None:
        """The nag must be close enough to compaction to mean something.

        The bug was a nag at ~50% of the trigger. Anything under 80% is the same
        class of noise, so that is the floor this pins; the ceiling keeps it from
        arriving too late to act on.
        """
        settings = tmp_path / "settings.json"
        _write_settings(
            settings,
            {
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(_GLOBAL_WINDOW),
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(_PCT),
            },
        )
        nag, _ = resolve_thresholds({}, settings)
        trigger = compaction_trigger(_GLOBAL_WINDOW, _PCT)
        assert 0.80 <= nag / trigger <= 0.95

    def test_explicit_operator_values_win(self, tmp_path: Path) -> None:
        """A configured budget is honoured verbatim, not recomputed."""
        settings = tmp_path / "settings.json"
        _write_settings(
            settings,
            {
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(_GLOBAL_WINDOW),
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(_PCT),
                "CONTEXT_BUDGET_NAG": "300000",
                "CONTEXT_BUDGET_HARD": "390000",
            },
        )
        assert resolve_thresholds({}, settings) == (300_000, 390_000)

    def test_environment_outranks_the_file(self, tmp_path: Path) -> None:
        """When a variable DOES survive, it is still the more specific source."""
        settings = tmp_path / "settings.json"
        _write_settings(settings, {"CONTEXT_BUDGET_NAG": "300000"})
        nag, _ = resolve_thresholds({"CONTEXT_BUDGET_NAG": "310000"}, settings)
        assert nag == 310_000

    def test_unreadable_settings_do_not_raise(self, tmp_path: Path) -> None:
        """A hook fails open: a missing or corrupt file yields usable numbers."""
        corrupt = tmp_path / "corrupt.json"
        corrupt.write_text("{not json", encoding="utf8")
        for path in (corrupt, tmp_path / "absent.json"):
            nag, advisory = resolve_thresholds({}, path)
            assert 0 < nag < advisory


class TestNagFiringBehaviour:
    """End to end: the banner appears on the right side of the line."""

    def _configured(self, tmp_path: Path) -> GatePaths:
        paths = gate_paths(tmp_path / "gate")
        _write_settings(
            paths.settings,
            {
                "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(_GLOBAL_WINDOW),
                "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(_PCT),
            },
        )
        return paths

    def test_silent_below_the_threshold(self, tmp_path: Path) -> None:
        """210000 tokens fired the old gate. It must now say nothing.

        Measured on the live 0.9.0 gate through the real hook wrapper on
        2026-08-05: a 210000-token turn injected the advisory banner, against a
        compaction point of 398926 -- 47% of the way there.
        """
        paths = self._configured(tmp_path)
        assert _nag_fired(_run_unpinned(paths, 210_000)) is False

    def test_silent_just_under_the_line(self, tmp_path: Path) -> None:
        """One token below the resolved nag point is still silence."""
        paths = self._configured(tmp_path)
        nag, _ = resolve_thresholds({}, paths.settings)
        assert _nag_fired(_run_unpinned(paths, nag - 1)) is False

    def test_fires_at_the_threshold(self, tmp_path: Path) -> None:
        """At the resolved nag point the advisory appears."""
        paths = self._configured(tmp_path)
        nag, _ = resolve_thresholds({}, paths.settings)
        assert _nag_fired(_run_unpinned(paths, nag)) is True

    def test_fires_when_compaction_is_imminent(self, tmp_path: Path) -> None:
        """Just short of compaction the advisory is certainly owed."""
        paths = self._configured(tmp_path)
        trigger = compaction_trigger(_GLOBAL_WINDOW, _PCT)
        assert _nag_fired(_run_unpinned(paths, trigger - 5_000)) is True
