"""Turn a declared pack entry into the exact Open Brain write that lands it.

Purpose:
    #445 answered "how does anything get INTO canon" from live source: there is
    no missing writer, there are two existing ones, and canon is empty because
    nothing was ever promoted through them. This module holds that answer as
    code -- one function per lane producing the precise tool call and metadata
    that the read side's selectors will later recognise -- so the mapping stops
    being a paragraph in a closed issue that the next agent has to re-derive.

Architecture:
    Pure functions returning a :class:`PlannedWrite`: a tool name and its
    arguments, and nothing else. No client, no endpoint, no I/O. That separation
    is what lets the reconciler PRINT exactly what it would send during a dry run
    -- the default -- rather than describing it in prose and hoping the real call
    matches.

    Two lanes, two entirely different write surfaces, because Open Brain stores
    them in two different places (#445):

        profile_guidance / process_guidance
            -> ``append_session_event`` with ``metadata.candidate_type`` and
               ``metadata.memory_lifecycle_action = 'promote'``, keyed by
               ``metadata.candidate_scope.key``. An ``ob_session_events`` row.
        repo_facts
            -> ``upsert_repo_fact`` with ``repoFactMetadata``. An ``ob_entities``
               row, bound to the repo EXACTLY with no fallback.

Pattern/Convention:
    PROMOTE, NOT CANDIDATE. The guidance selector requires
    ``memory_lifecycle_action='promote'``; a bare ``candidate`` carries
    ``candidate_presence_effect = "no_durable_write_no_shared_write"`` and is
    deliberately excluded from the standing set
    (``src/tools/agent-context-pack-guidance.ts``). Writing candidates is exactly
    how the lanes came to measure zero while holding rows -- the one
    ``user_preference`` and one ``process_rule`` in the database on 2026-07-30
    were both still candidates. So this writes ``promote`` and there is no option
    to write anything else.

    RETIREMENT IS A WRITE, NEVER A DELETE. :func:`plan_retire` exists so the
    retirement path is the same typed, keyed lifecycle write as promotion. There
    is no delete function in this module because there is no delete surface in
    the mechanism (#445: "a newer ``relegate`` or ``discard`` on the same
    ``candidate_scope.key``").

Example:
    >>> entry = PackEntry(key="process.no_tmp", lane=Lane.PROCESS, text="Never /tmp.")
    >>> planned = plan_promote(entry, session_key="dev:open-brain")
    >>> planned.tool
    'append_session_event'
    >>> planned.arguments["metadata"]["memory_lifecycle_action"]
    'promote'

See Also:
    - ``src/tools/append-session-event.ts`` - the lifecycle metadata validator
    - ``src/tools/repo-facts.ts`` - ``repoFactMetadata``, the fact validator
    - ``_plans/issues/445-...`` - where this mapping was established from live source
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

from openbrain.apps.canon.pack import Lane, PackEntry

#: The lifecycle action that makes a row standing guidance. Not configurable:
#: anything else is excluded by the read-side selector, so an option to write it
#: would be an option to write rows nothing serves.
PROMOTE_ACTION = "promote"

#: The lifecycle action that retires a standing key. ``relegate`` rather than
#: ``discard`` because relegation is the reversible one -- a later ``promote`` on
#: the same key makes it standing again -- and a reconciler should never reach
#: for the harsher verb on the operator's behalf.
RETIRE_ACTION = "relegate"

#: The provenance marker ``repoFactMetadata`` requires: ``z.literal("qmd")``.
#: Repo facts are only accepted from the qmd derivation pipeline, so a pack-
#: authored fact declares the same source system; the pack file itself is the
#: qmd-indexed document it was derived from.
REPO_FACT_SOURCE_SYSTEM = "qmd"

#: The staleness policy a pack-authored fact carries. ``stable_fact_verify_source``
#: is the honest one for a fact whose authority is a reviewed file in this repo:
#: it means "re-verify against the source", which is exactly what re-running the
#: reconciler against the pack does. ``refresh_required`` would age the fact out
#: on a 30-day horizon it has no reason to obey, and ``commit_pinned`` would
#: invalidate every fact on the next commit to the pack.
REPO_FACT_STALENESS_POLICY = "stable_fact_verify_source"


class FactProvenance(BaseModel):
    """The five values ``repoFactMetadata`` validates on every repo fact.

    They travel as ONE object rather than parallel arguments because they are
    one fact about one verification: the repo, the pack's repo-relative path,
    the commit, the URL naming that commit and path, and when it was checked.
    ``repoFactMetadata`` refuses the write unless ``source_url`` contains the
    exact same commit and path, so splitting them across a call signature invites
    exactly the mismatched tuple the server rejects.

    Attributes:
        repo: The repo the fact binds to, EXACTLY -- the ``repo_facts`` selector
            has no fallback, so a fact under the wrong repo is invisible rather
            than misfiled.
        source_path: The canon pack's repo-relative path, exactly as encoded in
            ``source_url``.
        source_commit: The commit the fact was verified at.
        source_url: The URL naming that commit and path.
        verified_at: When it was verified, as an ISO-8601 instant.
    """

    model_config = ConfigDict(frozen=True)

    repo: str
    source_path: str
    source_commit: str
    source_url: str
    verified_at: str


class PlannedWrite(BaseModel):
    """One tool call the reconciler would make, held as data so it can be shown.

    Attributes:
        tool: The MCP tool name.
        arguments: The call's arguments, exactly as they would be sent.
        key: The entry's stable key, carried for reporting.
        lane: The entry's lane, carried for reporting.
    """

    model_config = ConfigDict(frozen=True)

    tool: str
    arguments: dict[str, Any]
    key: str
    lane: Lane


def plan_promote(
    entry: PackEntry,
    *,
    session_key: str,
    provenance: FactProvenance | None = None,
) -> PlannedWrite:
    """Plan the write that makes one declared entry standing canon.

    Args:
        entry: The declared rule.
        session_key: The lane the lifecycle event is appended to. Guidance rows
            live in ``ob_session_events``, which is a lane-scoped store, so a
            lane must be named even though the guidance selector queries across
            them by ``candidate_type``.
        provenance: The repo, commit, URL, and verification instant a
            ``repo_facts`` entry needs. Unused by the guidance lanes, which are
            lifecycle events rather than sourced entities.

    Returns:
        The planned call.

    Raises:
        ValueError: A ``repo_facts`` entry with no provenance. Failing here,
            before any call, means a half-written reconcile cannot happen -- the
            run stops with nothing sent rather than after landing three of five
            facts.
    """
    if entry.lane is Lane.REPO_FACTS:
        return _plan_repo_fact(entry, provenance=provenance)
    return _plan_guidance(entry, session_key=session_key, action=PROMOTE_ACTION)


def plan_retire(entry: PackEntry, *, session_key: str) -> PlannedWrite:
    """Plan the write that retires a standing guidance key.

    Args:
        entry: The rule being retired. Only its key and lane are load-bearing;
            the text rides along as the event content so the retirement is
            self-describing in the lane.
        session_key: The lane the event is appended to.

    Returns:
        The planned ``relegate`` call.

    Raises:
        ValueError: The entry is a repo fact. Repo facts are entities, not
            lifecycle rows -- there is no ``relegate`` for one, and pretending
            otherwise would emit a call the server rejects.

    Not called by the reconcile run: undeclared rows are REPORTED, never acted on
    (``reconcile`` module docstring). This exists so the retirement path is
    expressed in the same typed place as promotion, and so an operator tool can
    reach it without re-deriving the metadata shape from a closed issue.
    """
    if entry.lane is Lane.REPO_FACTS:
        message = "repo facts are entities; they have no lifecycle retirement"
        raise ValueError(message)
    return _plan_guidance(entry, session_key=session_key, action=RETIRE_ACTION)


def _plan_guidance(
    entry: PackEntry, *, session_key: str, action: str
) -> PlannedWrite:
    """Build an ``append_session_event`` lifecycle call for a guidance entry.

    Every field ``append-session-event.ts`` validates for a lifecycle action is
    supplied: ``candidate_type`` (required, from a closed set),
    ``candidate_reason`` (required, non-empty), and ``candidate_scope.key``,
    which the guidance selector needs to prove the row current (#445).
    """
    candidate_type = entry.candidate_type
    if candidate_type is None:  # pragma: no cover - guarded by the caller
        message = f"lane {entry.lane} has no candidate type"
        raise ValueError(message)
    return PlannedWrite(
        tool="append_session_event",
        key=entry.key,
        lane=entry.lane,
        arguments={
            "session_key": session_key,
            "event_type": "decision",
            "content": entry.text,
            "metadata": {
                "memory_lifecycle_action": action,
                "candidate_type": candidate_type,
                "candidate_reason": _reason_for(entry, action),
                "candidate_scope": {"key": entry.key},
            },
        },
    )


def _reason_for(entry: PackEntry, action: str) -> str:
    """The required ``candidate_reason``: why this row was written, citing its source.

    ``append-session-event.ts`` refuses a lifecycle action with a blank reason,
    so this is never empty. It names the pack as the authority and carries the
    entry's own ``source`` when it has one, which is what makes a row in the lane
    traceable back to the reviewed file that declared it.
    """
    origin = f" (source: {entry.source})" if entry.source else ""
    return f"{action} from declared canon pack: {entry.key}{origin}"


def _plan_repo_fact(
    entry: PackEntry, *, provenance: FactProvenance | None
) -> PlannedWrite:
    """Build an ``upsert_repo_fact`` call for a repo-fact entry.

    ``repoFactMetadata`` validates every field named here, and refuses the write
    when ``source_url`` does not contain both the commit and the path. The
    provenance therefore comes from the CALLER (the entrypoint resolves it from
    the pack file's own location and the repo's HEAD) rather than being invented
    per entry: a fabricated commit would pass this function and fail at the
    server, which is the worst place to find out.
    """
    if provenance is None:
        message = (
            f"repo fact {entry.key} needs provenance "
            "(repo, source_commit, source_url, verified_at); "
            "upsert_repo_fact validates all of them"
        )
        raise ValueError(message)
    return PlannedWrite(
        tool="upsert_repo_fact",
        key=entry.key,
        lane=entry.lane,
        arguments={
            "metadata": {
                "source_system": REPO_FACT_SOURCE_SYSTEM,
                "repo": provenance.repo,
                "collection": "canon-pack",
                "path": provenance.source_path,
                "subject": entry.subject,
                "fact_type": str(entry.fact_type),
                "fact": entry.text,
                "source_commit": provenance.source_commit,
                "source_url": provenance.source_url,
                "verified_at": provenance.verified_at,
                "staleness_policy": REPO_FACT_STALENESS_POLICY,
                **(
                    {"refresh_hint": f"Declared canon provenance: {entry.source}"}
                    if entry.source
                    else {}
                ),
            }
        },
    )
