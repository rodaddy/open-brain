"""The console-script entrypoint: read a pack file, read live canon, report drift.

Purpose:
    An operator runs this to answer "is canon what we said it is". It parses the
    declared pack, reads the live ``agent_context_pack`` through the same client
    the SessionStart hook uses, diffs them, and prints the report -- then, only
    when explicitly told to, writes the missing and stale rules through the
    lifecycle path #445 established.

Architecture:
    A parse-and-drive shell, the canon mirror of ``apps.bulk.run``. Every
    decision lives in the capabilities: ``pack`` parses, ``reconcile`` diffs,
    ``writes`` builds the calls. This module builds the client and orders them.

    The client is the SAME construction the canon read already uses --
    ``apps.hooks.session._canon_context`` -- reached by calling
    ``run_session_start`` with a synthesised ``SessionStart`` payload rather than
    by opening a second connection path. There is exactly one place that knows
    how to read canon, and this is not a second one.

Pattern/Convention:
    DRY RUN IS THE DEFAULT, and that is a design position, not caution. Canon is
    an AUTHORITY model, not a decay model (``docs/code-brain-design.md``: canon >
    decided > observed), and #444 -- deciding what canon contains -- is an open
    HITL grilling ticket whose own text says "Rico decides; do not answer this
    one alone". A tool that promoted rules into the standing set the moment it
    was run would be answering it. So the default run REPORTS, prints the exact
    calls it would make, and changes nothing; ``--apply`` is the operator saying
    the pack is the decision.

    LOUD, NOT SWALLOWED -- the inverse of the hook entrypoints' exit-0 contract.
    A missing endpoint, an unparseable pack, or an unreachable server exits
    NON-ZERO, because a person is watching and can act. Drift itself also exits
    non-zero, so this is usable as a check: "canon matches the file" is the only
    green state.

    NO TOKEN, NO ENDPOINT, IN ANY OUTPUT. Reporting goes through ``loguru``, the
    one logging surface this package has (``utils.logging_config`` owns every
    sink); nothing here calls ``print``. The report carries rule TEXT (see
    ``reconcile.format_report``), which is not a secret and is the whole point of
    a drift report. What never appears is anything from settings: a failure is
    logged as its exception CLASS alone, because a transport error's message
    carries the endpoint it could not reach and an operator log is a file someone
    pastes into a ticket.

See Also:
    - ``openbrain.apps.canon.reconcile`` - the diff this drives
    - ``openbrain.apps.bulk.run`` - the operator-entrypoint shape this mirrors
    - ``openbrain.apps.hooks.session.run_session_start`` - the one canon read
"""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from openbrain.apps.canon.pack import Lane, Pack
from openbrain.apps.canon.reconcile import (
    DriftReport,
    diff_pack,
    format_report,
    live_items,
    live_key_of,
    live_text_of,
)
from openbrain.apps.canon.writes import FactProvenance, PlannedWrite, plan_promote
from openbrain.apps.hooks.session import SessionStartHook, run_session_start
from openbrain.config import load_canon_settings

if TYPE_CHECKING:
    from openbrain.config import CanonSettings

#: The ``source`` on the synthesised SessionStart payload. ``startup`` is the
#: ordinary value and the read does not gate on it (``run_session_start``:
#: "``source`` is read but does not gate the read"); naming it explicitly beats
#: inventing a fake one that a later reader would have to interpret.
_READ_SOURCE = "startup"


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the reconcile command line."""
    parser = argparse.ArgumentParser(
        prog="openbrain-canon-reconcile",
        description=(
            "Compare a declared canon pack file against the canon Open Brain "
            "actually serves, and report the drift. Reports only unless "
            "--apply is given: promoting a rule into the standing set is an "
            "operator decision, not a side effect of running a check."
        ),
    )
    parser.add_argument("pack", type=Path, help="the canon pack file, read whole")
    parser.add_argument(
        "--apply",
        action="store_true",
        help=(
            "write the missing and stale rules. Without it the run reports and "
            "changes nothing. Undeclared live rules are NEVER written or "
            "deleted either way -- retiring canon is an operator-authored "
            "relegate on the key."
        ),
    )
    parser.add_argument(
        "--repo-source-commit",
        default=None,
        help="the commit repo facts are verified at (required to apply repo facts)",
    )
    parser.add_argument(
        "--repo-source-url",
        default=None,
        help="the source URL naming that commit and path (required to apply repo facts)",
    )
    parser.add_argument(
        "--repo-verified-at",
        default=None,
        help="ISO-8601 instant the repo facts were verified (required to apply)",
    )
    return parser.parse_args(argv)


def read_live_pack(settings: CanonSettings) -> Any:
    """Read the live canon pack through the one canon read path.

    Args:
        settings: The canon configuration -- endpoint, token, scope, sections.

    Returns:
        The decoded ``agent_context_pack`` payload, or ``None`` when canon is
        configured to request no sections.

    Raises:
        Whatever the read raises -- notably ``CanonNotConfiguredError`` when no
        endpoint or token is set. UNLIKE the hook, this does not swallow: an
        operator running a check must be told the check could not run.
    """
    payload = SessionStartHook.model_validate(
        {"hook_event_name": "SessionStart", "source": _READ_SOURCE}
    )
    return asyncio.run(run_session_start(payload, settings))


def _repo_relative_pack_path(pack_path: Path) -> str | None:
    """Return the pack's path below its nearest git root.

    The pack file is the reviewed artifact the repo fact cites. A worktree's
    ``.git`` marker is a file rather than a directory, so ``exists`` deliberately
    accepts either shape. No marker means the path cannot be proven repo-relative
    and repo-fact planning must stop before a write is sent.
    """
    resolved = pack_path.resolve()
    for parent in resolved.parents:
        if (parent / ".git").exists():
            return resolved.relative_to(parent).as_posix()
    return None


def provenance_from(
    args: argparse.Namespace, settings: CanonSettings
) -> FactProvenance | None:
    """Assemble the repo-fact provenance, or ``None`` when it is incomplete.

    Args:
        args: The parsed command line, carrying the pack path, commit, URL, and
            verification instant.
        settings: The canon configuration, carrying the repo the facts bind to.

    Returns:
        The provenance, or ``None`` when any part is absent. All-or-nothing:
        ``repoFactMetadata`` refuses a write whose ``source_url`` does not
        contain both the commit and the pack's exact repo-relative path, so a
        half-filled provenance is never closer to valid than none at all.
    """
    source_path = _repo_relative_pack_path(args.pack)
    if not (
        source_path
        and args.repo_source_commit
        and args.repo_source_url
        and args.repo_verified_at
    ):
        return None
    if settings.repo is None:
        # Same all-or-nothing rule: a fact cannot bind without a repo, and the
        # cwd-derived None (#517) must never become a half-filled provenance.
        return None
    return FactProvenance(
        repo=settings.repo,
        source_path=source_path,
        source_commit=args.repo_source_commit,
        source_url=args.repo_source_url,
        verified_at=args.repo_verified_at,
    )


def plan_writes(
    pack: Pack, report: DriftReport, args: argparse.Namespace, settings: CanonSettings
) -> list[PlannedWrite]:
    """Build the write for every actionable finding, or fail before sending any.

    Args:
        pack: The declared pack, used to recover each finding's full entry.
        report: The drift report.
        args: The parsed command line, carrying the repo-fact provenance.
        settings: The canon configuration, carrying the lane and repo.

    Returns:
        One planned write per missing or stale finding, in report order.

    Raises:
        ValueError: A repo fact is missing provenance the server validates. Every
            write is planned BEFORE any is sent, so this stops the run with
            nothing written rather than after landing half of them.
    """
    by_key = {(entry.lane, entry.key): entry for entry in pack.entries}
    provenance = provenance_from(args, settings)
    return [
        plan_promote(
            by_key[(finding.lane, finding.key)],
            session_key=settings.session_key,
            provenance=provenance,
        )
        for finding in report.actionable()
    ]


def _describe(planned: Sequence[PlannedWrite]) -> str:
    """Render the planned writes as the lines a dry run prints.

    One line per call: the tool, the lane, and the key. Not the whole argument
    payload -- the rule text is already in the drift report directly above, and
    printing it twice buries the list of calls that is the point of this block.
    """
    if not planned:
        return "no writes needed"
    lines = [f"{len(planned)} write(s) planned:"]
    lines.extend(
        f"    {call.tool} [{call.lane}] {call.key}" for call in planned
    )
    return "\n".join(lines)


class NamespaceMismatchError(RuntimeError):
    """A canon write or verification read resolved outside the intended agent."""


class ReadbackConfigurationError(ValueError):
    """A scoped read cannot observe every lane in the planned writes."""


def _receipt_namespace(receipt: Any) -> str | None:
    """Resolve the authoritative namespace from a write receipt."""
    if not isinstance(receipt, Mapping):
        return None
    namespace = receipt.get("namespace")
    if isinstance(namespace, str) and namespace:
        return namespace
    writer_identity = receipt.get("writer_identity")
    return (
        writer_identity
        if isinstance(writer_identity, str) and writer_identity
        else None
    )


def _pack_readback_scope(settings: CanonSettings) -> dict[str, Any]:
    """Build the same scoped read arguments the SessionStart canon path uses."""
    scope: dict[str, Any] = {
        "agent": settings.agent,
        "platform": settings.platform,
        "server_id": settings.server_id,
        "channel_id": settings.channel_id,
        "session_key": settings.session_key,
        "requested_sections": list(settings.sections),
    }
    if settings.repo is not None:
        scope["repo"] = settings.repo
    return scope


def _validate_readback_settings(
    planned: Sequence[PlannedWrite], settings: CanonSettings
) -> None:
    """Require a scoped pack read that can observe every planned lane."""
    requested = set(settings.sections)
    missing_lanes = sorted({call.lane.value for call in planned} - requested)
    if missing_lanes:
        message = f"canon read-back lane {', '.join(missing_lanes)} is not requested"
        raise ReadbackConfigurationError(message)
    if settings.repo is None and any(call.lane is Lane.REPO_FACTS for call in planned):
        message = "canon read-back of repo_facts requires a repo"
        raise ReadbackConfigurationError(message)


def _verify_readback(
    planned: Sequence[PlannedWrite], payload: Any, settings: CanonSettings
) -> None:
    """Prove unknown-receipt writes are visible under the intended namespace."""
    _validate_readback_settings(planned, settings)
    intended_namespace = settings.agent
    if not isinstance(payload, Mapping):
        message = "canon write read-back returned no scoped pack"
        raise NamespaceMismatchError(message)
    scope = payload.get("scope")
    actual_namespace = scope.get("namespace") if isinstance(scope, Mapping) else None
    if isinstance(actual_namespace, str) and actual_namespace != intended_namespace:
        message = (
            f"canon writes intended for {intended_namespace} read back from "
            f"{actual_namespace}"
        )
        raise NamespaceMismatchError(message)

    missing: list[str] = []
    for call in planned:
        metadata = call.arguments.get("metadata", {})
        expected_key = metadata.get("subject") if call.lane is Lane.REPO_FACTS else call.key
        expected_text = (
            metadata.get("fact")
            if call.lane is Lane.REPO_FACTS
            else call.arguments.get("content")
        )
        items = live_items(payload, call.lane)
        if not any(
            live_key_of(item) == expected_key and live_text_of(item) == expected_text
            for item in items
        ):
            missing.append(call.key)
    if missing:
        message = f"canon writes not visible for {intended_namespace}: {', '.join(missing)}"
        raise NamespaceMismatchError(message)


def _apply(
    planned: Sequence[PlannedWrite], settings: CanonSettings
) -> tuple[int, int]:
    """Send every planned write and return new and already-present counts.

    The client is built here rather than in a capability for the same reason
    ``apps.bulk.run`` builds its own: this is the operator path, so it does NOT
    inherit the hook path's single-attempt, deadline-pinned policy -- an operator
    run may retry, which is the sibling client's default.

    Every write receipt is checked against ``settings.agent``. Append-event
    receipts expose the persisted namespace as ``writer_identity``; repo-fact
    writes return ``namespace`` directly. Duplicate receipts count as already
    present rather than newly applied. If a future write surface carries neither
    namespace signal, one scoped pack read verifies the exact written keys and
    texts instead of reporting success from an unverified call count.

    Returns:
        A pair of ``(applied, already_present)`` counts.

    Raises:
        CanonNotConfiguredError: No endpoint or token. Raised before the import
            so an unconfigured run fails identically whether or not the sibling
            package is installed.
        NamespaceMismatchError: A receipt or verification read resolves outside
            the intended agent namespace.
    """
    from openbrain.apps.hooks.session import CanonNotConfiguredError

    if settings.base_url is None or settings.token is None:
        missing = ", ".join(
            name
            for name, value in (
                ("base_url", settings.base_url),
                ("token", settings.token),
            )
            if value is None
        )
        raise CanonNotConfiguredError(missing)

    from openbrain_memory.client import OpenBrainClient

    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        namespace=settings.agent,
        # The LAN opt-in (#525). The operator path reads the same environment the
        # hooks do, so an operator on a LAN host reconciles canon rather than
        # hitting the client's loopback-only refusal.
        allow_insecure_http=settings.allow_insecure_http,
    )
    unknown_receipt = False
    already_present = 0
    try:
        for call in planned:
            receipt = client.call_tool(call.tool, call.arguments)
            already_present += int(
                isinstance(receipt, Mapping) and receipt.get("duplicate") is True
            )
            actual_namespace = _receipt_namespace(receipt)
            if actual_namespace is None:
                unknown_receipt = True
                continue
            if actual_namespace != settings.agent:
                message = (
                    f"canon write {call.key} intended for {settings.agent} "
                    f"landed in {actual_namespace}"
                )
                raise NamespaceMismatchError(message)
        if unknown_receipt:
            readback = client.agent_context_pack(**_pack_readback_scope(settings))
            _verify_readback(planned, readback, settings)
        return len(planned) - already_present, already_present
    finally:
        client.close()


def main(argv: Sequence[str] | None = None) -> int:
    """Run one reconcile and report what it found.

    Args:
        argv: The command line, or ``None`` to read ``sys.argv``.

    Returns:
        ``0`` only when the declared pack and the live canon agree. ``1`` when
        they drift -- including after a successful ``--apply``, because the
        written rows have not been re-read and this process has not observed
        them standing. ``2`` when the run could not complete: an unparseable
        pack, an unconfigured or unreachable service, a repo fact missing the
        provenance its write path validates.
    """
    args = _parse_args(argv)

    try:
        pack = Pack.from_path(args.pack)
    except Exception as error:  # noqa: BLE001 -- reported to the operator, then exit
        logger.error(
            "canon pack unreadable ({}): {}", type(error).__name__, args.pack
        )
        return 2

    try:
        settings = load_canon_settings()
        live = read_live_pack(settings)
    except Exception as error:  # noqa: BLE001 -- reported to the operator, then exit
        # The exception CLASS only. A transport error's message carries the
        # endpoint it failed to reach, and an operator log is a file someone
        # pastes.
        logger.error("canon read failed ({})", type(error).__name__)
        return 2

    report = diff_pack(pack, live)
    logger.info("\n{}", format_report(report))

    try:
        planned = plan_writes(pack, report, args, settings)
    except ValueError as error:
        logger.error("cannot plan writes: {}", error)
        return 2

    logger.info("{}", _describe(planned))

    if args.apply and planned:
        try:
            applied, already_present = _apply(planned, settings)
        except Exception as error:  # noqa: BLE001 -- reported to the operator, then exit
            logger.error("apply failed ({})", type(error).__name__)
            return 2
        logger.info(
            "applied {} write(s); already present {}", applied, already_present
        )

    return 1 if report.has_drift else 0


if __name__ == "__main__":
    raise SystemExit(main())
