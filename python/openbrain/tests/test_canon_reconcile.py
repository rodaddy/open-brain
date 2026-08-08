"""The canon reconciler's behaviour: what a pack declares, and what drift means.

These are functional input/output tests at the module boundary -- a pack file's
text in, a parsed pack out; a declared pack and a live payload in, a report out;
an entry in, the exact tool call out. Nothing here mocks a client, because
nothing in `pack`, `reconcile`, or `writes` has one: that separation is the
design (`apps/canon/__init__.py`), and these tests are what it buys.

The live payloads are the shape `agent_context_pack` actually returns, taken from
the fields `session_start._render_item` reads on the same objects: guidance items
carry `scope_key` + `guidance`, repo facts carry `subject` + `fact`.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from openbrain.apps.canon.pack import FactType, Lane, Pack, PackEntry, PackKind
from openbrain.apps.canon.reconcile import (
    DriftStatus,
    diff_lane,
    diff_pack,
    format_report,
    live_items,
    live_key_of,
    live_text_of,
)
from openbrain.apps.canon.writes import (
    PROMOTE_ACTION,
    RETIRE_ACTION,
    FactProvenance,
    plan_promote,
    plan_retire,
)

PACK_TOML = """
kind = "canon"

[[entries]]
key = "process.no_tmp"
lane = "process_guidance"
text = "Never /tmp, $TMPDIR, or mktemp -d. Use the temp workspace."
source = "AGENTS.md"

[[entries]]
key = "profile.never_speedrun"
lane = "profile_guidance"
text = "Discussion is the default. Editing, committing, and pushing each need explicit authorization."

[[entries]]
key = "repo.two_hosts"
lane = "repo_facts"
subject = "hosts"
text = "There are exactly two hosts: this machine while developing, and deployment_host."
fact_type = "gotcha"
"""


def a_pack(*entries: PackEntry) -> Pack:
    """A pack over the given entries, so a test names only what it varies."""
    return Pack(kind=PackKind.CANON, entries=entries)


def guidance_item(key: str, text: str) -> dict[str, str]:
    """One live `profile_guidance`/`process_guidance` item, as the server sends it."""
    return {"scope_key": key, "guidance": text, "candidate_type": "process_rule"}


def fact_item(subject: str, text: str) -> dict[str, str]:
    """One live `repo_facts` item, as the server sends it."""
    return {"subject": subject, "fact": text, "fact_type": "gotcha"}


def live_pack(**sections: list[dict[str, str]]) -> dict[str, object]:
    """A decoded `agent_context_pack` payload carrying the given sections."""
    return {
        "schema": "openbrain.agent_context_pack.v1",
        "scope": {"namespace": "rico"},
        "sections": {name: {"items": items} for name, items in sections.items()},
    }


class TestPackFormat:
    """Parsing a pack file: what is accepted, and what is refused at parse."""

    def test_parses_all_three_lanes_from_toml(self) -> None:
        pack = Pack.from_toml(PACK_TOML)
        assert pack.kind is PackKind.CANON
        assert len(pack.entries) == 3
        assert [entry.lane for entry in pack.entries] == [
            Lane.PROCESS,
            Lane.PROFILE,
            Lane.REPO_FACTS,
        ]

    def test_entries_for_filters_by_lane_in_file_order(self) -> None:
        pack = Pack.from_toml(PACK_TOML)
        assert [entry.key for entry in pack.entries_for(Lane.PROCESS)] == [
            "process.no_tmp"
        ]

    def test_lane_maps_to_the_servers_candidate_type(self) -> None:
        pack = Pack.from_toml(PACK_TOML)
        types = {entry.lane: entry.candidate_type for entry in pack.entries}
        assert types[Lane.PROFILE] == "user_preference"
        assert types[Lane.PROCESS] == "process_rule"
        # Repo facts are entities, not lifecycle rows -- asking for a candidate
        # type is a category error, answered with None rather than a made-up value.
        assert types[Lane.REPO_FACTS] is None

    def test_a_lens_pack_is_refused_while_452_is_open(self) -> None:
        """`kind` accepts only `canon`, so a stance cannot be promoted as a rule."""
        with pytest.raises(ValidationError):
            Pack.from_toml('kind = "lens"\nentries = []\n')

    def test_an_entry_without_a_key_is_refused(self) -> None:
        """#445: a promoted row with no scope key can never be proven current."""
        with pytest.raises(ValidationError):
            Pack.from_toml(
                'kind = "canon"\n[[entries]]\nlane = "process_guidance"\ntext = "x"\n'
            )

    def test_a_blank_rule_is_refused_but_a_long_one_is_not(self) -> None:
        with pytest.raises(ValidationError):
            PackEntry(key="k", lane=Lane.PROCESS, text="   ")
        # No ceiling exists, and none may be added: docs/CODING_STANDARDS.md s6.
        long_rule = "x" * 20_000
        assert PackEntry(key="k", lane=Lane.PROCESS, text=long_rule).text == long_rule

    def test_a_repo_fact_without_a_subject_is_refused_at_parse(self) -> None:
        """upsert_repo_fact validates this; catching it here beats a server error."""
        with pytest.raises(ValidationError):
            PackEntry(key="k", lane=Lane.REPO_FACTS, text="a fact")

    def test_a_duplicate_key_is_refused(self) -> None:
        """Standing state per key is a single newest action; two texts cannot both win."""
        with pytest.raises(ValidationError):
            a_pack(
                PackEntry(key="dup", lane=Lane.PROCESS, text="one"),
                PackEntry(key="dup", lane=Lane.PROCESS, text="two"),
            )

    def test_an_unknown_field_is_refused(self) -> None:
        with pytest.raises(ValidationError):
            Pack.from_toml(
                'kind = "canon"\n[[entries]]\nkey = "k"\n'
                'lane = "process_guidance"\ntext = "t"\nteir = "hot"\n'
            )

    def test_an_unknown_fact_type_is_refused_at_parse(self) -> None:
        """The server validates z.enum(FACT_TYPES); a typo must not reach it."""
        with pytest.raises(ValidationError):
            PackEntry(
                key="k",
                lane=Lane.REPO_FACTS,
                subject="s",
                text="t",
                fact_type="convention",  # type: ignore[arg-type]
            )

    def test_fact_type_defaults_to_gotcha(self) -> None:
        entry = PackEntry(key="k", lane=Lane.REPO_FACTS, subject="s", text="t")
        assert entry.fact_type is FactType.GOTCHA


class TestLivePackReading:
    """Pulling the live side apart, defensively -- a partial pack still reports."""

    def test_reads_one_lanes_items(self) -> None:
        payload = live_pack(process_guidance=[guidance_item("a", "rule")])
        assert live_items(payload, Lane.PROCESS) == ({
            "scope_key": "a",
            "guidance": "rule",
            "candidate_type": "process_rule",
        },)

    @pytest.mark.parametrize(
        "payload",
        [
            None,
            "not a pack",
            {},
            {"sections": None},
            {"sections": {"process_guidance": None}},
            {"sections": {"process_guidance": {"items": "nope"}}},
        ],
    )
    def test_a_malformed_payload_yields_no_items_rather_than_raising(
        self, payload: object
    ) -> None:
        assert live_items(payload, Lane.PROCESS) == ()

    def test_key_comes_from_scope_key_then_subject(self) -> None:
        assert live_key_of({"scope_key": "k"}) == "k"
        assert live_key_of({"subject": "s"}) == "s"
        assert live_key_of({"guidance": "text but no key"}) is None

    def test_text_comes_from_guidance_then_fact(self) -> None:
        assert live_text_of({"guidance": " a rule "}) == "a rule"
        assert live_text_of({"fact": "a fact"}) == "a fact"
        assert live_text_of({}) == ""


class TestDrift:
    """The comparison itself: the four verdicts, and what each one means."""

    def test_identical_text_is_matched_and_is_not_drift(self) -> None:
        entry = PackEntry(key="p.a", lane=Lane.PROCESS, text="Never /tmp.")
        report = diff_pack(
            a_pack(entry),
            live_pack(process_guidance=[guidance_item("p.a", "Never /tmp.")]),
        )
        assert report.findings[0].status is DriftStatus.MATCHED
        assert report.has_drift is False
        assert report.actionable() == ()

    def test_a_declared_rule_absent_from_open_brain_is_missing(self) -> None:
        """#445's measured state: the lanes read zero while the machinery worked."""
        entry = PackEntry(key="p.a", lane=Lane.PROCESS, text="Never /tmp.")
        report = diff_pack(a_pack(entry), live_pack(process_guidance=[]))
        (finding,) = report.findings
        assert finding.status is DriftStatus.MISSING
        assert finding.declared_text == "Never /tmp."
        assert finding.live_text is None
        assert report.has_drift is True

    def test_a_changed_rule_is_stale_and_carries_both_texts(self) -> None:
        entry = PackEntry(key="p.a", lane=Lane.PROCESS, text="Never /tmp. Ever.")
        report = diff_pack(
            a_pack(entry),
            live_pack(process_guidance=[guidance_item("p.a", "Never /tmp.")]),
        )
        (finding,) = report.findings
        assert finding.status is DriftStatus.STALE
        assert finding.declared_text == "Never /tmp. Ever."
        assert finding.live_text == "Never /tmp."

    def test_a_rule_no_file_declares_is_undeclared_and_never_actionable(self) -> None:
        """Reported, never deleted: retirement is an operator-authored relegate."""
        report = diff_pack(
            a_pack(),
            live_pack(process_guidance=[guidance_item("ghost", "an old rule")]),
        )
        (finding,) = report.findings
        assert finding.status is DriftStatus.UNDECLARED
        assert finding.live_text == "an old rule"
        assert report.has_drift is True
        assert report.actionable() == ()

    def test_a_live_item_with_no_identifiable_key_is_skipped_not_accused(self) -> None:
        """#445: a keyless promoted row cannot be proven current, so nor matched."""
        report = diff_pack(
            a_pack(), live_pack(process_guidance=[{"guidance": "keyless"}])
        )
        assert report.findings == ()
        assert report.has_drift is False

    def test_repo_facts_match_on_subject(self) -> None:
        entry = PackEntry(
            key="repo.hosts", lane=Lane.REPO_FACTS, subject="hosts", text="Two hosts."
        )
        report = diff_pack(
            a_pack(entry), live_pack(repo_facts=[fact_item("repo.hosts", "Two hosts.")])
        )
        assert report.findings[0].status is DriftStatus.MATCHED

    def test_every_lane_is_compared_even_one_the_pack_ignores(self) -> None:
        """An undeclared rule in an untouched lane still reaches the report."""
        entry = PackEntry(key="p.a", lane=Lane.PROCESS, text="rule")
        report = diff_pack(
            a_pack(entry),
            live_pack(
                process_guidance=[guidance_item("p.a", "rule")],
                profile_guidance=[guidance_item("u.x", "a preference")],
            ),
        )
        assert {(f.lane, f.status) for f in report.findings} == {
            (Lane.PROCESS, DriftStatus.MATCHED),
            (Lane.PROFILE, DriftStatus.UNDECLARED),
        }

    def test_undeclared_findings_are_sorted_so_a_run_is_reproducible(self) -> None:
        findings = diff_lane(
            [],
            [guidance_item("z", "z"), guidance_item("a", "a")],
            Lane.PROCESS,
        )
        assert [finding.key for finding in findings] == ["a", "z"]

    def test_counts_report_every_status_including_the_empty_ones(self) -> None:
        report = diff_pack(
            a_pack(PackEntry(key="p.a", lane=Lane.PROCESS, text="rule")),
            live_pack(process_guidance=[]),
        )
        assert report.counts == {
            DriftStatus.MATCHED: 0,
            DriftStatus.MISSING: 1,
            DriftStatus.STALE: 0,
            DriftStatus.UNDECLARED: 0,
        }


class TestReport:
    """The rendered report: what an operator actually reads."""

    def test_names_the_counts_and_every_non_matched_finding(self) -> None:
        report = diff_pack(
            a_pack(
                PackEntry(key="p.a", lane=Lane.PROCESS, text="new text"),
                PackEntry(key="p.b", lane=Lane.PROCESS, text="fine"),
            ),
            live_pack(
                process_guidance=[
                    guidance_item("p.a", "old text"),
                    guidance_item("p.b", "fine"),
                ]
            ),
        )
        rendered = format_report(report)
        assert "matched=1" in rendered
        assert "stale=1" in rendered
        assert "declared: new text" in rendered
        assert "live:     old text" in rendered
        # A report that lists every rule that is fine stops being read.
        assert "p.b" not in rendered


class TestPlannedWrites:
    """The mapping from a declared entry to the exact call that lands it (#445)."""

    def test_a_process_rule_promotes_with_its_scope_key(self) -> None:
        entry = PackEntry(
            key="process.no_tmp",
            lane=Lane.PROCESS,
            text="Never /tmp.",
            source="AGENTS.md",
        )
        planned = plan_promote(entry, session_key="dev:open-brain")
        assert planned.tool == "append_session_event"
        metadata = planned.arguments["metadata"]
        assert metadata["memory_lifecycle_action"] == PROMOTE_ACTION
        assert metadata["candidate_type"] == "process_rule"
        assert metadata["candidate_scope"] == {"key": "process.no_tmp"}
        assert planned.arguments["content"] == "Never /tmp."
        # append-session-event.ts refuses a lifecycle action with a blank reason.
        assert "AGENTS.md" in metadata["candidate_reason"]

    def test_a_user_preference_promotes_into_the_profile_lane(self) -> None:
        entry = PackEntry(key="profile.x", lane=Lane.PROFILE, text="a preference")
        planned = plan_promote(entry, session_key="dev:open-brain")
        assert planned.arguments["metadata"]["candidate_type"] == "user_preference"

    def test_promote_is_never_candidate(self) -> None:
        """A bare candidate is excluded from the standing set -- that is why canon was empty."""
        entry = PackEntry(key="p.a", lane=Lane.PROCESS, text="rule")
        planned = plan_promote(entry, session_key="lane")
        assert planned.arguments["metadata"]["memory_lifecycle_action"] != "candidate"

    def test_a_repo_fact_uses_the_pack_path_not_its_prose_source(self) -> None:
        prose_source = "open-brain PR #84; approved 2026-08-03"
        source_path = "docs/canon/repo-facts.toml"
        source_commit = "abc123"
        entry = PackEntry(
            key="repo.hosts",
            lane=Lane.REPO_FACTS,
            subject="hosts",
            text="Two hosts.",
            source=prose_source,
        )
        planned = plan_promote(
            entry,
            session_key="lane",
            provenance=FactProvenance(
                repo="open-brain",
                source_path=source_path,
                source_commit=source_commit,
                source_url=(
                    "https://github.com/rodaddy/open-brain/blob/"
                    f"{source_commit}/{source_path}"
                ),
                verified_at="2026-08-02T00:00:00Z",
            ),
        )
        assert planned.tool == "upsert_repo_fact"
        metadata = planned.arguments["metadata"]
        assert metadata["source_system"] == "qmd"
        assert metadata["repo"] == "open-brain"
        assert metadata["path"] == source_path
        assert metadata["source_url"] == (
            "https://github.com/rodaddy/open-brain/blob/"
            f"{source_commit}/{metadata['path']}"
        )
        assert metadata["refresh_hint"] == f"Declared canon provenance: {prose_source}"
        assert metadata["subject"] == "hosts"
        assert metadata["fact_type"] == "gotcha"
        assert metadata["staleness_policy"] == "stable_fact_verify_source"

    def test_a_repo_fact_missing_provenance_fails_before_anything_is_sent(self) -> None:
        entry = PackEntry(
            key="repo.hosts", lane=Lane.REPO_FACTS, subject="hosts", text="Two hosts."
        )
        with pytest.raises(ValueError, match="provenance"):
            plan_promote(entry, session_key="lane")

    def test_retirement_is_a_relegate_write_on_the_same_key(self) -> None:
        entry = PackEntry(key="p.a", lane=Lane.PROCESS, text="an old rule")
        planned = plan_retire(entry, session_key="lane")
        assert planned.arguments["metadata"]["memory_lifecycle_action"] == RETIRE_ACTION
        assert planned.arguments["metadata"]["candidate_scope"] == {"key": "p.a"}

    def test_a_repo_fact_has_no_lifecycle_retirement(self) -> None:
        entry = PackEntry(
            key="repo.hosts", lane=Lane.REPO_FACTS, subject="hosts", text="Two hosts."
        )
        with pytest.raises(ValueError, match="entities"):
            plan_retire(entry, session_key="lane")


class TestShippedExample:
    """The example pack in `docs/canon/` parses, so the documentation cannot rot.

    A format example that no test loads is a comment, and it goes stale the first
    time a field is renamed. This is the gate that makes it real.
    """

    def test_the_documented_example_pack_parses(self) -> None:
        from pathlib import Path

        example = (
            Path(__file__).resolve().parents[3] / "docs" / "canon" / "example-pack.toml"
        )
        pack = Pack.from_path(example)
        assert pack.kind is PackKind.CANON
        # Every entry carries the scope key #445 established as the prerequisite.
        assert all(entry.key for entry in pack.entries)
