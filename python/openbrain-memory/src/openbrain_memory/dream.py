from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from .client import JSON

CURATION_LIMIT_MAX = 100


class DreamClient(Protocol):
    def list_stale(self, **arguments: Any) -> JSON: ...

    def tier_recommendations(self, **arguments: Any) -> JSON: ...

    def set_tier(self, **arguments: Any) -> JSON: ...

    def scan_namespace(self, **arguments: Any) -> JSON: ...

    def promote_entry(self, **arguments: Any) -> JSON: ...

    def decompose_entry(self, **arguments: Any) -> JSON: ...

    def find_duplicates(self, **arguments: Any) -> JSON: ...


@dataclass(frozen=True)
class DreamPolicy:
    limit: int = 20
    stale_days: int = 30
    duplicate_threshold: float = 0.08
    promote_threshold_days: int = 7
    demote_threshold_days: int = 30
    target_namespace: str = "shared-kb"

    def __post_init__(self) -> None:
        if type(self.limit) is not int or not 1 <= self.limit <= CURATION_LIMIT_MAX:
            raise ValueError(
                f"DreamPolicy.limit must be between 1 and {CURATION_LIMIT_MAX}"
            )
        if type(self.stale_days) is not int or self.stale_days < 1:
            raise ValueError("DreamPolicy.stale_days must be >= 1")
        if (
            type(self.promote_threshold_days) is not int
            or self.promote_threshold_days < 1
        ):
            raise ValueError("DreamPolicy.promote_threshold_days must be >= 1")
        if (
            type(self.demote_threshold_days) is not int
            or self.demote_threshold_days < 1
        ):
            raise ValueError("DreamPolicy.demote_threshold_days must be >= 1")
        if (
            isinstance(self.duplicate_threshold, bool)
            or not isinstance(self.duplicate_threshold, int | float)
            or not 0 <= self.duplicate_threshold <= 1
        ):
            raise ValueError("DreamPolicy.duplicate_threshold must be between 0 and 1")
        if not self.target_namespace:
            raise ValueError("DreamPolicy.target_namespace must not be empty")


@dataclass(frozen=True)
class DreamAction:
    tool: str
    arguments: Mapping[str, Any]
    reason: str | None = None
    dry_run: bool = True
    result: Mapping[str, Any] | None = None

    def as_dict(self) -> JSON:
        payload: JSON = {
            "tool": self.tool,
            "arguments": dict(self.arguments),
            "dry_run": self.dry_run,
        }
        if self.reason is not None:
            payload["reason"] = self.reason
        if self.result is not None:
            payload["result"] = dict(self.result)
        return payload


@dataclass(frozen=True)
class DreamRun:
    dry_run: bool
    reports: Mapping[str, Any]
    actions: tuple[DreamAction, ...] = field(default_factory=tuple)

    def as_dict(self) -> JSON:
        return {
            "dry_run": self.dry_run,
            "reports": dict(self.reports),
            "actions": [action.as_dict() for action in self.actions],
        }


class DreamEngine:
    def __init__(
        self,
        client: DreamClient,
        policy: DreamPolicy | Mapping[str, Any] | None = None,
    ) -> None:
        self.client = client
        self.policy = _coerce_policy(policy)

    def dream_once(
        self,
        dry_run: bool = True,
        namespace: str | None = None,
        **filters: Any,
    ) -> DreamRun:
        if dry_run is not True:
            raise ValueError(
                "dream_once currently supports dry_run=True only; "
                "call set_tier/promote_entry explicitly"
            )
        limit = _bounded_int(
            filters.get("limit"), self.policy.limit, "limit", CURATION_LIMIT_MAX
        )
        table_filter = _optional_str(filters.get("table"))
        reports: dict[str, Any] = {}

        reports["stale"] = self.list_stale(
            **_only(
                filters,
                {"table", "tier", "offset", "response_format"},
                limit=limit,
                days=_bounded_int(
                    filters.get("days"), self.policy.stale_days, "days", 365
                ),
            )
        )
        if namespace is None:
            reports["promote_recommendations"] = self.tier_recommendations(
                "promote",
                limit=limit,
                threshold_days=_bounded_int(
                    filters.get("promote_threshold_days"),
                    self.policy.promote_threshold_days,
                    "promote_threshold_days",
                    365,
                ),
            )
            reports["demote_recommendations"] = self.tier_recommendations(
                "demote",
                limit=limit,
                threshold_days=_bounded_int(
                    filters.get("demote_threshold_days"),
                    self.policy.demote_threshold_days,
                    "demote_threshold_days",
                    365,
                ),
            )
        reports["duplicates"] = self.find_duplicates(
            **_only(
                filters,
                {"table"},
                limit=limit,
                threshold=_float_between(
                    filters.get("threshold"),
                    self.policy.duplicate_threshold,
                    "threshold",
                ),
            )
        )

        if namespace is not None:
            reports["namespace_scan"] = self.scan_namespace(
                namespace,
                **_only(
                    filters,
                    {"table", "since"},
                    limit=limit,
                    target_namespace=self.policy.target_namespace,
                ),
            )

        actions = self._planned_actions(
            reports, namespace=namespace, table_filter=table_filter
        )
        return DreamRun(dry_run=True, reports=reports, actions=tuple(actions))

    def list_stale(self, **filters: Any) -> JSON:
        return self.client.list_stale(**filters)

    def tier_recommendations(self, action: str, **filters: Any) -> JSON:
        if action not in {"promote", "demote"}:
            raise ValueError(
                "tier_recommendations action must be 'promote' or 'demote'"
            )
        return self.client.tier_recommendations(action=action, **filters)

    def set_tier(
        self,
        table: str,
        entry_id: str,
        tier: str,
        *,
        dry_run: bool = True,
    ) -> JSON:
        arguments = {"table": table, "id": entry_id, "tier": tier}
        if dry_run:
            return DreamAction("set_tier", arguments).as_dict()
        return self.client.set_tier(**arguments)

    def scan_namespace(self, namespace: str, **filters: Any) -> JSON:
        if not namespace:
            raise ValueError("namespace must not be empty")
        return self.client.scan_namespace(namespace=namespace, **filters)

    def promote_entry(
        self,
        table: str,
        entry_id: str,
        *,
        reason: str | None = None,
        target_namespace: str | None = None,
        dry_run: bool = True,
    ) -> JSON:
        arguments: dict[str, Any] = {
            "table": table,
            "id": entry_id,
            "target_namespace": target_namespace or self.policy.target_namespace,
        }
        if reason is not None:
            arguments["reason"] = reason
        if dry_run:
            return DreamAction("promote_entry", arguments, reason=reason).as_dict()
        return self.client.promote_entry(**arguments)

    def decompose_entry(
        self,
        table: str,
        entry_id: str,
        *,
        max_chunk_chars: int | None = None,
        overlap_chars: int | None = None,
        dry_run: bool = True,
        apply_mode: str | None = None,
    ) -> JSON:
        arguments: dict[str, Any] = {"table": table, "id": entry_id}
        if max_chunk_chars is not None:
            arguments["max_chunk_chars"] = _bounded_int(
                max_chunk_chars, max_chunk_chars, "max_chunk_chars", 8000
            )
        if overlap_chars is not None:
            arguments["overlap_chars"] = _bounded_int(
                overlap_chars + 1, overlap_chars + 1, "overlap_chars", 1001
            ) - 1
        if dry_run:
            arguments["dry_run"] = True
            return self.client.decompose_entry(**arguments)
        if apply_mode != "write_replacements":
            raise ValueError(
                "decompose_entry dry_run=False requires apply_mode='write_replacements'"
            )
        arguments["dry_run"] = False
        arguments["apply_mode"] = apply_mode
        return self.client.decompose_entry(**arguments)

    def find_duplicates(self, **filters: Any) -> JSON:
        return self.client.find_duplicates(**filters)

    def _planned_actions(
        self,
        reports: Mapping[str, Any],
        *,
        namespace: str | None,
        table_filter: str | None,
    ) -> list[DreamAction]:
        actions: list[DreamAction] = []
        for report_name in ("promote_recommendations", "demote_recommendations"):
            if namespace is not None:
                continue
            report = reports.get(report_name)
            for candidate in _candidate_items(report, "candidates"):
                table = _required_str(candidate, "table")
                if table_filter is not None and table != table_filter:
                    continue
                entry_id = _required_str(candidate, "id")
                tier = _required_str(candidate, "suggested_tier")
                actions.append(
                    DreamAction(
                        "set_tier",
                        {"table": table, "id": entry_id, "tier": tier},
                        reason=_optional_str(candidate.get("reasoning")),
                    )
                )

        if namespace is not None:
            scan = reports.get("namespace_scan")
            for candidate in _candidate_items(scan, "candidates"):
                table = _required_str(candidate, "table")
                if table_filter is not None and table != table_filter:
                    continue
                entry_id = _required_str(candidate, "id")
                actions.append(
                    DreamAction(
                        "promote_entry",
                        {
                            "table": table,
                            "id": entry_id,
                            "target_namespace": self.policy.target_namespace,
                            "reason": (
                                f"DreamEngine promotion candidate from {namespace}"
                            ),
                        },
                        reason="namespace promotion candidate",
                    )
                )
        return actions


def _coerce_policy(policy: DreamPolicy | Mapping[str, Any] | None) -> DreamPolicy:
    if policy is None:
        return DreamPolicy()
    if isinstance(policy, DreamPolicy):
        return policy
    return DreamPolicy(**dict(policy))


def _only(source: Mapping[str, Any], keys: set[str], **defaults: Any) -> dict[str, Any]:
    result = {key: source[key] for key in keys if key in source}
    result.update(defaults)
    return {key: value for key, value in result.items() if value is not None}


def _bounded_int(value: Any, default: int, name: str, maximum: int) -> int:
    if value is None:
        return default
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer between 1 and {maximum}")
    return value


def _float_between(value: Any, default: float, name: str) -> float:
    if value is None:
        return default
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not 0 <= float(value) <= 1
    ):
        raise ValueError(f"{name} must be between 0 and 1")
    return float(value)


def _candidate_items(report: Any, key: str) -> list[Mapping[str, Any]]:
    if not isinstance(report, Mapping):
        raise ValueError("Dream report was not an object")
    items = report.get(key, [])
    if not isinstance(items, list):
        raise ValueError(f"Dream report {key} was not a list")
    if not all(isinstance(item, Mapping) for item in items):
        raise ValueError(f"Dream report {key} contained non-object candidates")
    return items


def _required_str(mapping: Mapping[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Dream recommendation missing {key}")
    return value


def _optional_str(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None
