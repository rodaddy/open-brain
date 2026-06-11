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
                "candidates": [{"id": "promote-1", "table": "thoughts"}],
                "duplicates": [],
                "already_promoted": [],
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
        "tier_recommendations",
        "tier_recommendations",
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


def test_namespace_dream_suppresses_unscoped_tier_actions():
    client = FakeDreamClient()
    engine = DreamEngine(client)

    result = engine.dream_once(namespace="bilby")

    assert [action.tool for action in result.actions] == ["promote_entry"]


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
