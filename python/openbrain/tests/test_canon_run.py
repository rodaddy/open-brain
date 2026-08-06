"""The reconcile entrypoint: exit codes, the dry-run default, and loud failure.

The entrypoint is the one module here that touches settings and a client, so
these tests drive `main` with the two seams it exposes -- the canon read and the
apply -- monkeypatched, and assert on the exit code and the printed report. That
is the whole contract an operator (or a CI check) depends on.
"""

from __future__ import annotations

import io
from typing import TYPE_CHECKING, Any

import pytest
from loguru import logger
from openbrain_memory import client as memory_client

from openbrain.apps.canon import run as canon_run
from openbrain.apps.canon.pack import Lane
from openbrain.apps.canon.writes import PlannedWrite
from openbrain.config import CanonSettings

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

PACK_TOML = """
kind = "canon"

[[entries]]
key = "process.no_tmp"
lane = "process_guidance"
text = "Never /tmp."
"""


@pytest.fixture
def pack_file(tmp_path: Path) -> Path:
    """A minimal one-rule pack on disk."""
    path = tmp_path / "canon.toml"
    path.write_text(PACK_TOML, encoding="utf-8")
    return path


def live(*items: dict[str, str]) -> dict[str, Any]:
    """A decoded pack payload carrying the given process_guidance items."""
    return {"sections": {"process_guidance": {"items": list(items)}}}


def planned_process_write() -> PlannedWrite:
    """One guidance write for direct apply-boundary tests."""
    return PlannedWrite(
        tool="append_session_event",
        key="process.no_tmp",
        lane=Lane.PROCESS,
        arguments={
            "session_key": "dev:open-brain",
            "event_type": "decision",
            "content": "Never /tmp.",
            "metadata": {"candidate_scope": {"key": "process.no_tmp"}},
        },
    )


def settings(*, agent: str = "claude") -> CanonSettings:
    """Canon settings with an endpoint and token, so nothing fails as unconfigured."""
    return CanonSettings(
        OPENBRAIN_BASE_URL="https://openbrain.invalid",  # type: ignore[call-arg]
        # noqa: S106 -- not a real secret; the tests assert this literal is
        # NEVER logged, so it has to be a recognisable sentinel.
        OPENBRAIN_TOKEN="not-a-real-token",  # type: ignore[call-arg]  # noqa: S106
        OPENBRAIN_CANON_AGENT=agent,  # type: ignore[call-arg]
    )


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the entrypoint at settings that are configured but never dialled."""
    monkeypatch.setattr(canon_run, "load_canon_settings", settings)


@pytest.fixture
def logged() -> Iterator[io.StringIO]:
    """Capture the entrypoint's loguru output, diagnose ON.

    ``diagnose=True`` matters for the secret-leak assertions: it renders an
    exception's locals, so a sink WITHOUT it would pass those tests for the wrong
    reason. This is the same sink shape ``test_capture_hooks`` uses.
    """
    sink = io.StringIO()
    sink_id = logger.add(sink, backtrace=True, diagnose=True, level="INFO")
    try:
        yield sink
    finally:
        logger.remove(sink_id)


def test_matching_canon_exits_zero(
    pack_file: Path, wired: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        canon_run,
        "read_live_pack",
        lambda _s: live({"scope_key": "process.no_tmp", "guidance": "Never /tmp."}),
    )
    assert canon_run.main([str(pack_file)]) == 0


def test_drift_exits_one_and_names_the_missing_rule(
    pack_file: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
    logged: io.StringIO,
) -> None:
    monkeypatch.setattr(canon_run, "read_live_pack", lambda _s: live())
    assert canon_run.main([str(pack_file)]) == 1
    out = logged.getvalue()
    assert "missing=1" in out
    assert "process.no_tmp" in out


def test_the_default_run_plans_the_write_but_never_sends_it(
    pack_file: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
    logged: io.StringIO,
) -> None:
    """Promotion is an operator decision (#444 is HITL), not a side effect of a check."""
    sent: list[PlannedWrite] = []
    monkeypatch.setattr(canon_run, "read_live_pack", lambda _s: live())
    monkeypatch.setattr(canon_run, "_apply", lambda planned, _s: sent.extend(planned))

    canon_run.main([str(pack_file)])

    assert sent == []
    out = logged.getvalue()
    assert "1 write(s) planned" in out
    assert "append_session_event" in out


def test_apply_sends_exactly_the_planned_writes(
    pack_file: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[PlannedWrite] = []
    monkeypatch.setattr(canon_run, "read_live_pack", lambda _s: live())
    monkeypatch.setattr(canon_run, "_apply", lambda planned, _s: sent.extend(planned))

    canon_run.main([str(pack_file), "--apply"])

    assert [(call.tool, call.key) for call in sent] == [
        ("append_session_event", "process.no_tmp")
    ]


def test_apply_still_exits_one_because_the_rows_were_not_re_read(
    pack_file: Path, wired: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A write is not an observation. Nothing has seen the row standing yet."""
    monkeypatch.setattr(canon_run, "read_live_pack", lambda _s: live())
    monkeypatch.setattr(canon_run, "_apply", lambda _p, _s: None)
    assert canon_run.main([str(pack_file), "--apply"]) == 1


def test_apply_rejects_a_receipt_from_the_token_namespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An admin-token receipt must not be reported as a successful skippy write."""

    class MisScopedClient:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def call_tool(self, _tool: str, _arguments: dict[str, Any]) -> dict[str, Any]:
            return {
                "writer_identity": "admin",
                "token_identity": "admin",
                "delegated_agent_id": None,
                "namespace_source": "token",
            }

        def agent_context_pack(self, **_arguments: Any) -> dict[str, Any]:
            raise AssertionError

        def close(self) -> None:
            pass

    monkeypatch.setattr(memory_client, "OpenBrainClient", MisScopedClient)

    with pytest.raises(canon_run.NamespaceMismatchError, match="landed in admin"):
        canon_run._apply([planned_process_write()], settings(agent="skippy"))


def test_apply_reads_back_when_the_receipt_has_no_namespace_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A future sparse receipt still fails when the scoped read resolves to admin."""
    state = {"read_back": False}

    class SparseReceiptClient:
        def __init__(self, **_kwargs: Any) -> None:
            pass

        def call_tool(self, _tool: str, _arguments: dict[str, Any]) -> dict[str, Any]:
            return {"event_id": "event-1"}

        def agent_context_pack(self, **_arguments: Any) -> dict[str, Any]:
            state["read_back"] = True
            return {
                "scope": {"namespace": "admin"},
                "sections": {"process_guidance": {"items": []}},
            }

        def close(self) -> None:
            pass

    monkeypatch.setattr(memory_client, "OpenBrainClient", SparseReceiptClient)

    with pytest.raises(canon_run.NamespaceMismatchError, match="read back from admin"):
        canon_run._apply([planned_process_write()], settings(agent="skippy"))
    assert state["read_back"] is True


def test_an_undeclared_rule_is_reported_and_never_written(
    pack_file: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
    logged: io.StringIO,
) -> None:
    sent: list[PlannedWrite] = []
    monkeypatch.setattr(
        canon_run,
        "read_live_pack",
        lambda _s: live(
            {"scope_key": "process.no_tmp", "guidance": "Never /tmp."},
            {"scope_key": "ghost", "guidance": "an old rule"},
        ),
    )
    monkeypatch.setattr(canon_run, "_apply", lambda planned, _s: sent.extend(planned))

    assert canon_run.main([str(pack_file), "--apply"]) == 1
    assert sent == []
    assert "undeclared" in logged.getvalue()


def test_an_unreadable_pack_exits_two(
    tmp_path: Path, wired: None, logged: io.StringIO
) -> None:
    bad = tmp_path / "bad.toml"
    bad.write_text('kind = "lens"\nentries = []\n', encoding="utf-8")
    assert canon_run.main([str(bad)]) == 2
    assert "canon pack unreadable" in logged.getvalue()


def test_a_failed_canon_read_exits_two_without_naming_the_endpoint(
    pack_file: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
    logged: io.StringIO,
) -> None:
    def boom(_settings: CanonSettings) -> Any:
        message = "connection refused"
        raise RuntimeError(message)

    monkeypatch.setattr(canon_run, "read_live_pack", boom)

    assert canon_run.main([str(pack_file)]) == 2
    err = logged.getvalue()
    assert "canon read failed" in err
    assert "openbrain.invalid" not in err
    assert "not-a-real-token" not in err


def test_repo_fact_provenance_derives_the_pack_repo_relative_path(
    tmp_path: Path,
) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    pack = repo / "docs" / "canon" / "facts.toml"
    pack.parent.mkdir(parents=True)
    pack.write_text('kind = "canon"\nentries = []\n', encoding="utf-8")
    args = canon_run._parse_args(
        [
            str(pack),
            "--repo-source-commit",
            "abc123",
            "--repo-source-url",
            "https://github.com/rodaddy/open-brain/blob/abc123/docs/canon/facts.toml",
            "--repo-verified-at",
            "2026-08-02T00:00:00Z",
        ]
    )

    provenance = canon_run.provenance_from(args, settings())

    assert provenance is not None
    assert provenance.source_path == "docs/canon/facts.toml"


def test_a_repo_fact_without_provenance_exits_two_before_any_write(
    tmp_path: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
    logged: io.StringIO,
) -> None:
    """Planning happens for all writes before any is sent, so a run cannot half-land."""
    path = tmp_path / "facts.toml"
    path.write_text(
        'kind = "canon"\n[[entries]]\nkey = "repo.hosts"\n'
        'lane = "repo_facts"\nsubject = "hosts"\ntext = "Two hosts."\n',
        encoding="utf-8",
    )
    sent: list[PlannedWrite] = []
    monkeypatch.setattr(
        canon_run, "read_live_pack", lambda _s: {"sections": {"repo_facts": {"items": []}}}
    )
    monkeypatch.setattr(canon_run, "_apply", lambda planned, _s: sent.extend(planned))

    assert canon_run.main([str(path), "--apply"]) == 2
    assert sent == []
    assert "provenance" in logged.getvalue()


def test_an_apply_failure_exits_two_content_free(
    pack_file: Path,
    wired: None,
    monkeypatch: pytest.MonkeyPatch,
    logged: io.StringIO,
) -> None:
    def boom(_planned: object, _settings: CanonSettings) -> None:
        message = "https://openbrain.invalid refused"
        raise RuntimeError(message)

    monkeypatch.setattr(canon_run, "read_live_pack", lambda _s: live())
    monkeypatch.setattr(canon_run, "_apply", boom)

    assert canon_run.main([str(pack_file), "--apply"]) == 2
    err = logged.getvalue()
    assert "apply failed" in err
    # Only the exception CLASS is printed -- never the message, which here would
    # have carried the endpoint.
    assert "openbrain.invalid" not in err
