from __future__ import annotations

import pytest

from openbrain_memory import DreamAction, DreamEngine, DreamPolicy, DreamRun


class FakeDreamClient:
    def __init__(self) -> None:
        self.calls = []
        self.responses = {
            "list_stale": {"entries": [{"id": "stale-1", "table": "thoughts"}]},
            "tier_recommendations": {
                "promote": {
                    "candidates": [
                        {
                            "id": "hot-1",
                            "table": "thoughts",
                            "suggested_tier": "hot",
                            "reasoning": "frequently accessed",
                        },
                        {
                            "id": "hot-2",
                            "table": "decisions",
                            "suggested_tier": "hot",
                            "reasoning": "frequently accessed",
                        },
                    ]
                },
                "demote": {
                    "candidates": [
                        {
                            "id": "cold-1",
                            "table": "decisions",
                            "suggested_tier": "cold",
                            "reasoning": "stale and low access",
                        }
                    ]
                },
            },
            "find_duplicates": {"duplicates": [{"table": "thoughts"}]},
            "scan_namespace": {
                "candidates": [
                    {"id": "promote-1", "table": "thoughts"},
                    {"id": "promote-2", "table": "decisions"},
                ],
                "duplicates": [],
            },
            "decompose_entry": {
                "dry_run": True,
                "oversized": True,
                "source_ref": {
                    "source": "brain",
                    "table": "thoughts",
                    "id": "large-1",
                    "namespace": "bilby",
                },
                "proposed_replacements": [
                    {
                        "content": "smaller chunk",
                        "chunk_index": 0,
                        "source_ref": {
                            "source": "brain",
                            "table": "thoughts",
                            "id": "large-1",
                            "namespace": "bilby",
                        },
                        "provenance": {
                            "source_table": "thoughts",
                            "source_id": "large-1",
                            "source_namespace": "bilby",
                        },
                    }
                ],
            },
        }

    def _record(self, name, arguments):
        self.calls.append((name, arguments))
        return {"tool": name, "arguments": arguments}

    def list_stale(self, **arguments):
        self.calls.append(("list_stale", arguments))
        return self.responses["list_stale"]

    def tier_recommendations(self, **arguments):
        self.calls.append(("tier_recommendations", arguments))
        return self.responses["tier_recommendations"][arguments["action"]]

    def set_tier(self, **arguments):
        return self._record("set_tier", arguments)

    def scan_namespace(self, **arguments):
        self.calls.append(("scan_namespace", arguments))
        return self.responses["scan_namespace"]

    def promote_entry(self, **arguments):
        return self._record("promote_entry", arguments)

    def decompose_entry(self, **arguments):
        self.calls.append(("decompose_entry", arguments))
        return self.responses["decompose_entry"]

    def find_duplicates(self, **arguments):
        self.calls.append(("find_duplicates", arguments))
        return self.responses["find_duplicates"]


def test_dream_once_defaults_to_dry_run_and_does_not_mutate():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once(namespace="bilby", table="thoughts", limit=5)

    assert isinstance(result, DreamRun)
    assert result.dry_run is True
    assert [name for name, _ in client.calls] == [
        "list_stale",
        "find_duplicates",
        "scan_namespace",
    ]
    assert [action.tool for action in result.actions] == [
        "promote_entry",
    ]
    assert [action.arguments["table"] for action in result.actions] == [
        "thoughts",
    ]
    assert all(action.dry_run for action in result.actions)


def test_dream_once_is_dry_run_only_for_first_release():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    with pytest.raises(ValueError, match="dry_run=True only"):
        engine.dream_once(dry_run=False, namespace="bilby")

    assert client.calls == []


def test_dream_without_namespace_does_not_scan_or_promote():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once()

    assert "scan_namespace" not in [name for name, _ in client.calls]
    assert [action.tool for action in result.actions] == [
        "set_tier",
        "set_tier",
        "set_tier",
    ]


def test_dream_table_filter_scopes_tier_actions_without_namespace():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once(table="thoughts")

    assert [action.tool for action in result.actions] == ["set_tier"]
    assert [action.arguments["table"] for action in result.actions] == ["thoughts"]
    assert [action.arguments["id"] for action in result.actions] == ["hot-1"]


def test_namespace_dream_suppresses_unscoped_tier_actions():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once(namespace="bilby")

    assert [action.tool for action in result.actions] == [
        "promote_entry",
        "promote_entry",
    ]
    assert "tier_recommendations" not in [name for name, _ in client.calls]


def test_namespace_dream_scans_against_policy_target_namespace():
    client = FakeDreamClient()
    engine = DreamEngine(client, policy={"target_namespace": "team"})

    result = engine.dream_once(namespace="bilby", table="thoughts")

    scan_call = [call for call in client.calls if call[0] == "scan_namespace"][0]
    assert scan_call == (
        "scan_namespace",
        {
            "namespace": "bilby",
            "table": "thoughts",
            "limit": 20,
            "target_namespace": "team",
        },
    )
    assert result.actions[0].arguments["target_namespace"] == "team"
    assert [action.arguments["table"] for action in result.actions] == ["thoughts"]


def test_namespace_dream_defaults_target_namespace_to_shared_kb():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once(namespace="bilby", table="thoughts")

    scan_call = [call for call in client.calls if call[0] == "scan_namespace"][0]
    assert scan_call[1]["target_namespace"] == "shared-kb"
    assert result.actions[0].arguments["target_namespace"] == "shared-kb"


def test_namespace_dream_table_filter_skips_non_matching_scan_candidates():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once(namespace="bilby", table="decisions")

    assert [action.tool for action in result.actions] == ["promote_entry"]
    assert [action.arguments["table"] for action in result.actions] == ["decisions"]
    assert [action.arguments["id"] for action in result.actions] == ["promote-2"]


def test_dream_once_fails_closed_on_malformed_tier_candidate():
    client = FakeDreamClient()
    client.responses["tier_recommendations"]["promote"] = {
        "candidates": [
            {
                "id": "hot-1",
                "table": "thoughts",
                "suggested_tier": "hot",
            },
            {
                "id": "bad-1",
                "table": "thoughts",
            },
        ]
    }
    engine = DreamEngine(client)

    with pytest.raises(ValueError, match="suggested_tier"):
        engine.dream_once()


def test_dream_once_fails_closed_on_mixed_namespace_scan_candidates():
    client = FakeDreamClient()
    client.responses["scan_namespace"] = {
        "candidates": [
            {"id": "promote-1", "table": "thoughts"},
            {"id": "bad-1"},
        ],
    }
    engine = DreamEngine(client)

    with pytest.raises(ValueError, match="table"):
        engine.dream_once(namespace="bilby")


def test_dream_once_fails_closed_on_malformed_report_shapes():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    client.responses["tier_recommendations"]["promote"] = {"candidates": "bad"}
    with pytest.raises(ValueError, match="candidates"):
        engine.dream_once()

    client = FakeDreamClient()
    client.responses["tier_recommendations"]["promote"] = "bad"
    engine = DreamEngine(client)
    with pytest.raises(ValueError, match="object"):
        engine.dream_once()


def test_wrapper_methods_pass_arguments_correctly():
    client = FakeDreamClient()
    engine = DreamEngine(client, policy={"target_namespace": "team"})

    assert (
        engine.list_stale(table="thoughts", tier="warm")
        == client.responses["list_stale"]
    )
    assert (
        engine.tier_recommendations("promote", limit=3)
        == client.responses["tier_recommendations"]["promote"]
    )
    assert (
        engine.find_duplicates(table="decisions", threshold=0.05)
        == client.responses["find_duplicates"]
    )
    assert (
        engine.scan_namespace("bilby", table="thoughts")
        == client.responses["scan_namespace"]
    )

    assert client.calls[:4] == [
        ("list_stale", {"table": "thoughts", "tier": "warm"}),
        ("tier_recommendations", {"action": "promote", "limit": 3}),
        ("find_duplicates", {"table": "decisions", "threshold": 0.05}),
        ("scan_namespace", {"namespace": "bilby", "table": "thoughts"}),
    ]

    assert engine.set_tier("thoughts", "id-1", "hot") == {
        "tool": "set_tier",
        "arguments": {"table": "thoughts", "id": "id-1", "tier": "hot"},
        "dry_run": True,
    }
    assert engine.promote_entry("decisions", "id-2", reason="useful") == {
        "tool": "promote_entry",
        "arguments": {
            "table": "decisions",
            "id": "id-2",
            "target_namespace": "team",
            "reason": "useful",
        },
        "dry_run": True,
        "reason": "useful",
    }


def test_mutating_wrappers_require_explicit_dry_run_false():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    tier_result = engine.set_tier("thoughts", "id-1", "hot", dry_run=False)
    promote_result = engine.promote_entry(
        "thoughts",
        "id-2",
        target_namespace="shared",
        dry_run=False,
    )

    assert tier_result == {
        "tool": "set_tier",
        "arguments": {"table": "thoughts", "id": "id-1", "tier": "hot"},
    }
    assert promote_result == {
        "tool": "promote_entry",
        "arguments": {"table": "thoughts", "id": "id-2", "target_namespace": "shared"},
    }


def test_decompose_entry_defaults_to_dry_run_client_call():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.decompose_entry(
        "thoughts",
        "large-1",
        max_chunk_chars=700,
        overlap_chars=50,
    )

    assert result["dry_run"] is True
    assert result["proposed_replacements"][0]["provenance"] == {
        "source_table": "thoughts",
        "source_id": "large-1",
        "source_namespace": "bilby",
    }
    assert client.calls[-1] == (
        "decompose_entry",
        {
            "table": "thoughts",
            "id": "large-1",
            "max_chunk_chars": 700,
            "overlap_chars": 50,
            "dry_run": True,
        },
    )


def test_decompose_entry_apply_requires_explicit_apply_mode():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    with pytest.raises(ValueError, match="write_replacements"):
        engine.decompose_entry("thoughts", "large-1", dry_run=False)

    assert client.calls == []

    engine.decompose_entry(
        "thoughts",
        "large-1",
        dry_run=False,
        apply_mode="write_replacements",
    )

    assert client.calls[-1] == (
        "decompose_entry",
        {
            "table": "thoughts",
            "id": "large-1",
            "dry_run": False,
            "apply_mode": "write_replacements",
        },
    )


def test_decompose_entry_bounds_match_server_schema():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    with pytest.raises(ValueError, match="max_chunk_chars"):
        engine.decompose_entry("thoughts", "large-1", max_chunk_chars=499)

    with pytest.raises(ValueError, match="overlap_chars"):
        engine.decompose_entry("thoughts", "large-1", overlap_chars=-1)

    with pytest.raises(ValueError, match="overlap_chars"):
        engine.decompose_entry("thoughts", "large-1", overlap_chars=1001)

    with pytest.raises(ValueError, match="overlap_chars must be less"):
        engine.decompose_entry(
            "thoughts",
            "large-1",
            max_chunk_chars=500,
            overlap_chars=500,
        )

    assert client.calls == []

    engine.decompose_entry(
        "thoughts",
        "large-1",
        max_chunk_chars=500,
        overlap_chars=0,
    )
    assert client.calls[-1] == (
        "decompose_entry",
        {
            "table": "thoughts",
            "id": "large-1",
            "max_chunk_chars": 500,
            "overlap_chars": 0,
            "dry_run": True,
        },
    )


def test_dream_structures_can_render_to_dicts():
    action = DreamAction(
        "set_tier", {"table": "thoughts", "id": "id-1", "tier": "cold"}
    )
    run = DreamRun(dry_run=True, reports={"stale": {}}, actions=(action,))

    assert run.as_dict() == {
        "dry_run": True,
        "reports": {"stale": {}},
        "actions": [
            {
                "tool": "set_tier",
                "arguments": {"table": "thoughts", "id": "id-1", "tier": "cold"},
                "dry_run": True,
            }
        ],
    }


def test_policy_and_inputs_are_validated():
    with pytest.raises(ValueError, match="limit"):
        DreamPolicy(limit=0)
    with pytest.raises(ValueError, match="limit"):
        DreamPolicy(limit=101)
    with pytest.raises(ValueError, match="limit"):
        DreamPolicy(limit=True)
    with pytest.raises(ValueError, match="stale_days"):
        DreamPolicy(stale_days=True)
    with pytest.raises(ValueError, match="threshold"):
        DreamPolicy(duplicate_threshold=True)
    with pytest.raises(ValueError, match="threshold"):
        DreamPolicy(duplicate_threshold=2)

    engine = DreamEngine(FakeDreamClient())
    with pytest.raises(ValueError, match="action"):
        engine.tier_recommendations("archive")
    with pytest.raises(ValueError, match="namespace"):
        engine.scan_namespace("")
    with pytest.raises(ValueError, match="limit"):
        engine.dream_once(limit=0)
    with pytest.raises(ValueError, match="limit"):
        engine.dream_once(limit=101)
    with pytest.raises(ValueError, match="days"):
        engine.dream_once(days=True)
    with pytest.raises(ValueError, match="threshold"):
        engine.dream_once(threshold=True)
