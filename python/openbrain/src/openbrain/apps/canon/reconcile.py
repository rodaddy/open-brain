"""Diff a declared canon pack against the canon Open Brain actually serves.

Purpose:
    A pack file says what canon is SUPPOSED to hold; ``agent_context_pack`` says
    what it DOES hold. This module is the comparison, and the comparison is the
    product: #445 measured all three lanes at zero items while the machinery was
    "provably working -- returning the right answer to a question with no data
    behind it". Nothing detected that except a person querying the database by
    hand. A drift report is what turns that into a check anyone can run.

Architecture:
    Two pure functions over data, and no I/O:

        diff_lane   -- one lane's declared entries against one lane's live items
        diff_pack   -- every lane, into one :class:`DriftReport`

    The live side arrives as the already-decoded ``agent_context_pack`` payload,
    the same object ``apps.hooks.session.run_session_start`` returns and
    ``apps.hooks.session_start.render_pack`` renders. This module does not build
    a client, does not know an endpoint, and does not write: the entrypoint
    (``run``) owns all three. That is what makes the whole diff testable from a
    dict without a server, and it is why the report can be produced against a
    captured pack as easily as a live one.

Pattern/Convention:
    THE DIRECTION IS FILES -> OB, AND ONLY THAT. The pack is the original; the
    rows are the projection (``_plans/canon-always-known.md``, "Skills stay in
    files"). So a rule in the pack and not in OB is MISSING (the pack wins, write
    it); a rule whose text differs is STALE (the pack wins, rewrite it); and a
    rule in OB but not in the pack is UNDECLARED -- REPORTED, never deleted.

    Undeclared is not "delete it", for two reasons. Canon may legitimately be
    written by hand through the same lifecycle path an operator uses directly, so
    an undeclared row is as likely to be a rule someone promoted deliberately as
    it is to be a leftover. And retiring canon is a ``relegate``/``discard``
    lifecycle WRITE on the key (#445), not a deletion -- there is no delete
    surface to call even if it were wanted. So the reconciler surfaces the row
    and stops; the operator decides.

    NOTHING HERE BOUNDS OR NORMALISES RULE TEXT beyond stripping the surrounding
    whitespace that a TOML multi-line string adds. Comparing on a shortened or
    lowercased rule would silently call two different rules equal, which is the
    one thing a drift check must never do.

Example:
    >>> pack = Pack.model_validate(
    ...     {"kind": "canon", "entries": [
    ...         {"key": "p.a", "lane": "process_guidance", "text": "Never /tmp."}]})
    >>> report = diff_pack(pack, {"sections": {"process_guidance": {"items": []}}})
    >>> report.has_drift
    True
    >>> report.findings[0].status
    <DriftStatus.MISSING: 'missing'>

See Also:
    - ``openbrain.apps.canon.pack`` - the declared side
    - ``openbrain.apps.hooks.session.run_session_start`` - where the live side comes from
    - ``src/tools/agent-context-pack-guidance.ts`` - how OB decides what is standing
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict

from openbrain.apps.canon.pack import Lane, Pack, PackEntry


class DriftStatus(StrEnum):
    """What the pack and Open Brain disagree about for one key.

    Attributes:
        MATCHED: Declared, present, and the text is identical. No action.
        MISSING: Declared in the pack, absent from the live pack. The write to
            make.
        STALE: Declared and present, but the live text differs. The rewrite to
            make -- a newer ``promote`` on the same key supersedes the old one.
        UNDECLARED: Present in the live pack, absent from the file. REPORTED
            only; retirement is an operator-authored ``relegate``, never a
            deletion by this tool.
    """

    MATCHED = "matched"
    MISSING = "missing"
    STALE = "stale"
    UNDECLARED = "undeclared"


class DriftFinding(BaseModel):
    """One key's verdict, with both texts so the report explains itself.

    Attributes:
        lane: Which lane the key belongs to.
        key: The stable scope key (or, for repo facts, the subject the live pack
            reports).
        status: The verdict.
        declared_text: The pack's text, or ``None`` when the key is undeclared.
        live_text: Open Brain's text, or ``None`` when the key is missing.
    """

    model_config = ConfigDict(frozen=True)

    lane: Lane
    key: str
    status: DriftStatus
    declared_text: str | None = None
    live_text: str | None = None


class DriftReport(BaseModel):
    """Every finding from one reconcile, plus the counts an operator reads first.

    Attributes:
        findings: Every key's verdict, lane by lane in pack order, then the
            undeclared live keys.
    """

    model_config = ConfigDict(frozen=True)

    findings: tuple[DriftFinding, ...]

    @property
    def counts(self) -> dict[DriftStatus, int]:
        """How many findings landed in each status, every status present."""
        tally = dict.fromkeys(DriftStatus, 0)
        for finding in self.findings:
            tally[finding.status] += 1
        return tally

    @property
    def has_drift(self) -> bool:
        """Whether anything at all disagrees.

        ``UNDECLARED`` counts. A row standing in canon that no file declares is a
        real divergence between the source of truth and the served set, even
        though this tool will not act on it -- reporting it as "no drift" would
        make the check useless for exactly the case it exists to surface.
        """
        return any(
            finding.status is not DriftStatus.MATCHED for finding in self.findings
        )

    def actionable(self) -> tuple[DriftFinding, ...]:
        """The findings a files->OB write would fix: missing and stale, in order.

        Undeclared is excluded BY DESIGN: this direction never deletes, so an
        undeclared row has no write that resolves it (see the module docstring).
        """
        return tuple(
            finding
            for finding in self.findings
            if finding.status in {DriftStatus.MISSING, DriftStatus.STALE}
        )


def live_items(pack_payload: Any, lane: Lane) -> tuple[Mapping[str, Any], ...]:
    """Pull one lane's items out of a decoded ``agent_context_pack`` payload.

    Args:
        pack_payload: The decoded pack, or anything at all. A malformed payload
            yields no items rather than raising -- the same defensive posture
            ``session_start.render_pack`` takes, and for the same reason: a
            partial pack should report what it does carry.
        lane: The section to read.

    Returns:
        The section's items, or empty when the payload does not carry that shape.
    """
    if not isinstance(pack_payload, Mapping):
        return ()
    sections = pack_payload.get("sections")
    if not isinstance(sections, Mapping):
        return ()
    section = sections.get(str(lane))
    if not isinstance(section, Mapping):
        return ()
    items = section.get("items")
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        return ()
    return tuple(item for item in items if isinstance(item, Mapping))


def live_key_of(item: Mapping[str, Any]) -> str | None:
    """The stable key a live pack item is identified by, or ``None``.

    Guidance items carry ``scope_key``; repo facts carry ``subject``. Both are
    read because the two lanes come from two different stores with two different
    write surfaces (#445), and the pack renders them side by side --
    ``session_start._render_item`` reads exactly these two fields for exactly
    this reason.

    An item with neither is unidentifiable: #445 recorded that a promoted item
    with no scope key "cannot be proven current", so it cannot be matched against
    a declared key either. ``None`` says so rather than inventing a match.
    """
    for field in ("scope_key", "subject"):
        value = item.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def live_text_of(item: Mapping[str, Any]) -> str:
    """The rule text a live pack item carries, whole.

    Guidance items carry ``guidance``; repo facts carry ``fact``. Same two shapes
    ``session_start._render_item`` renders. Never shortened.
    """
    for field in ("guidance", "fact"):
        value = item.get(field)
        if isinstance(value, str):
            return value.strip()
    return ""


def diff_lane(
    declared: Sequence[PackEntry],
    live: Sequence[Mapping[str, Any]],
    lane: Lane,
) -> tuple[DriftFinding, ...]:
    """Compare one lane's declared entries against its live items.

    Args:
        declared: The pack's entries for this lane, in file order.
        live: The lane's items from the live pack.
        lane: The lane being compared, carried onto every finding.

    Returns:
        A finding per declared entry in file order, then a finding per live key
        the pack did not declare, sorted so the report is stable run to run.

    A live item carrying no identifiable key is skipped rather than reported
    undeclared: it cannot be matched to a declared key, so calling it undeclared
    would accuse the pack of omitting something it may well declare under that
    key already. #445's uncertainty marker is the server's job, not this one's.
    """
    by_key: dict[str, str] = {}
    for item in live:
        key = live_key_of(item)
        if key is not None:
            by_key[key] = live_text_of(item)

    findings: list[DriftFinding] = []
    for entry in declared:
        if entry.key not in by_key:
            findings.append(
                DriftFinding(
                    lane=lane,
                    key=entry.key,
                    status=DriftStatus.MISSING,
                    declared_text=entry.text,
                )
            )
            continue
        live_value = by_key[entry.key]
        status = (
            DriftStatus.MATCHED if live_value == entry.text else DriftStatus.STALE
        )
        findings.append(
            DriftFinding(
                lane=lane,
                key=entry.key,
                status=status,
                declared_text=entry.text,
                live_text=live_value,
            )
        )

    declared_keys = {entry.key for entry in declared}
    for key in sorted(by_key.keys() - declared_keys):
        findings.append(
            DriftFinding(
                lane=lane,
                key=key,
                status=DriftStatus.UNDECLARED,
                live_text=by_key[key],
            )
        )
    return tuple(findings)


def diff_pack(pack: Pack, pack_payload: Any) -> DriftReport:
    """Compare a whole declared pack against a whole live pack.

    Args:
        pack: The declared canon.
        pack_payload: The decoded ``agent_context_pack`` payload.

    Returns:
        One report covering all three lanes, lanes in declaration order.

    Every lane is compared, including one the pack declares nothing for: that is
    how an undeclared live rule in an untouched lane still reaches the report.
    """
    findings: list[DriftFinding] = []
    for lane in Lane:
        findings.extend(
            diff_lane(pack.entries_for(lane), live_items(pack_payload, lane), lane)
        )
    return DriftReport(findings=tuple(findings))


def format_report(report: DriftReport) -> str:
    """Render a report as the plain text an operator reads in a terminal.

    Args:
        report: The report to render.

    Returns:
        A counts header, then one line per non-matched finding:
        ``<status> [<lane>] <key>``, followed by the declared and live texts
        indented beneath a stale finding so the difference is visible without a
        second command. Matched findings are summarised in the header only --
        listing every rule that is fine is how a report stops being read.

    CONTENT-FREE IT IS NOT, and deliberately: canon is rules, not secrets, and a
    drift report whose whole job is "these two texts differ" that declines to
    print either text is useless. What it must never carry is a token or an
    endpoint, and it carries neither -- nothing here touches settings.
    """
    counts = report.counts
    header = "CANON DRIFT | " + ", ".join(
        f"{status}={counts[status]}" for status in DriftStatus
    )
    lines = [header]
    for finding in report.findings:
        if finding.status is DriftStatus.MATCHED:
            continue
        lines.append(f"{finding.status} [{finding.lane}] {finding.key}")
        if finding.status is DriftStatus.STALE:
            lines.append(f"    declared: {finding.declared_text}")
            lines.append(f"    live:     {finding.live_text}")
        elif finding.status is DriftStatus.MISSING:
            lines.append(f"    declared: {finding.declared_text}")
        else:
            lines.append(f"    live:     {finding.live_text}")
    return "\n".join(lines)
