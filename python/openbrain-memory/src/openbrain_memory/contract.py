from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
from typing import Any

from .client import CURRENT_CONTRACT_VERSION, REQUIRED_CONTRACT_TOOLS

EXPECTED_CONTRACT_SCOPE = "required_openbrain_memory_contract"
DEFAULT_CLIENT_NAME = "openbrain-memory"

_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_RANGE_TOKEN_RE = re.compile(r"(>=|>|<=|<|=)?\s*([0-9]+\.[0-9]+\.[0-9]+)")
_DISPLAY_DIGEST_LENGTH = 12


@dataclass(frozen=True)
class ContractValidationResult:
    ok: bool
    reasons: tuple[str, ...]


def validate_contract_manifest(
    manifest: Mapping[str, Any],
    *,
    client_name: str = DEFAULT_CLIENT_NAME,
    client_version: str | None = None,
    required_tools: Iterable[str] = (),
    expected_scope: str = EXPECTED_CONTRACT_SCOPE,
    compatible_contract_versions: Iterable[str] = (),
) -> ContractValidationResult:
    """Validate a live Open Brain contract manifest without network access."""

    reasons: list[str] = []
    if not isinstance(manifest, Mapping):
        return ContractValidationResult(
            ok=False,
            reasons=("contract manifest must be a mapping",),
        )

    scope = manifest.get("contract_scope")
    if scope != expected_scope:
        reasons.append(
            "contract_scope mismatch: "
            f"expected {expected_scope!r}, got {_display_value(scope)}",
        )

    contract_version = manifest.get("contract_version")
    if not isinstance(contract_version, str) or not contract_version:
        reasons.append("contract_version is missing or not a non-empty string")
    elif compatible_contract_versions:
        compatible_versions = tuple(compatible_contract_versions)
        if contract_version not in compatible_versions:
            expected = ", ".join(_display_value(item) for item in compatible_versions)
            reasons.append(
                "contract_version "
                f"{_display_value(contract_version)} is not compatible; "
                f"expected one of: {expected}",
            )

    _validate_required_tools(
        manifest,
        required_tools=tuple(required_tools),
        reasons=reasons,
    )
    if client_version is not None:
        _validate_client_version(
            manifest,
            client_name=client_name,
            client_version=client_version,
            reasons=reasons,
        )

    return ContractValidationResult(ok=not reasons, reasons=tuple(reasons))


def validate_required_memory_contract(
    manifest: Mapping[str, Any],
    *,
    client_name: str = DEFAULT_CLIENT_NAME,
    client_version: str | None = None,
) -> ContractValidationResult:
    """Validate the package's required Open Brain memory contract."""

    return validate_contract_manifest(
        manifest,
        client_name=client_name,
        client_version=client_version,
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )


def _validate_required_tools(
    manifest: Mapping[str, Any],
    *,
    required_tools: Sequence[str],
    reasons: list[str],
) -> None:
    if not required_tools:
        return

    required_tool_set = set(required_tools)
    capability_tools = _capability_tool_names(manifest.get("capabilities"))
    missing_capabilities = sorted(required_tool_set - capability_tools)
    if missing_capabilities:
        reasons.append(
            "required tool(s) missing from contract capabilities: "
            + ", ".join(missing_capabilities),
        )

    tool_contracts = manifest.get("tool_contracts")
    if not isinstance(tool_contracts, Mapping):
        reasons.append("tool_contracts is missing or not a mapping")
        return

    missing_contracts = sorted(
        required_tool_set - set(_tool_contract_names(tool_contracts)),
    )
    if missing_contracts:
        reasons.append(
            "required tool(s) missing from tool_contracts: "
            + ", ".join(missing_contracts),
        )

    for tool_name in required_tools:
        if tool_name in tool_contracts:
            _validate_tool_contract_entry(
                tool_name,
                tool_contracts[tool_name],
                reasons=reasons,
            )


def _validate_tool_contract_entry(
    tool_name: str,
    value: Any,
    *,
    reasons: list[str],
) -> None:
    if not isinstance(value, Mapping):
        reasons.append(f"tool_contracts[{tool_name!r}] must be a mapping")
        return

    version = value.get("version")
    if version is None or version == "":
        reasons.append(f"tool_contracts[{tool_name!r}].version is missing or empty")

    input_schema = value.get("input_schema")
    if not isinstance(input_schema, Mapping):
        reasons.append(f"tool_contracts[{tool_name!r}].input_schema must be a mapping")

    output_shape = value.get("output_shape")
    output_schema = value.get("output_schema")
    if not (
        (isinstance(output_shape, str) and output_shape.strip())
        or isinstance(output_schema, Mapping)
    ):
        reasons.append(
            f"tool_contracts[{tool_name!r}] must define a non-empty output_shape "
            "or output_schema mapping",
        )


def _validate_client_version(
    manifest: Mapping[str, Any],
    *,
    client_name: str,
    client_version: str,
    reasons: list[str],
) -> None:
    parsed_client_version = _parse_version(client_version)
    if parsed_client_version is None:
        reasons.append(
            f"client_version {client_version!r} is not a supported semver version",
        )
        return

    min_versions = manifest.get("min_client_versions")
    if min_versions is not None:
        if not isinstance(min_versions, Mapping):
            reasons.append("min_client_versions is present but is not a mapping")
        else:
            min_version = min_versions.get(client_name)
            if min_version is None:
                reasons.append(
                    "min_client_versions is present but has no entry for "
                    f"{client_name!r}",
                )
            else:
                if not isinstance(min_version, str):
                    reasons.append(
                        f"min_client_versions[{client_name!r}] is not a string",
                    )
                else:
                    parsed_min_version = _parse_version(min_version)
                    if parsed_min_version is None:
                        reasons.append(
                            f"min_client_versions[{client_name!r}]="
                            f"{_display_value(min_version)} "
                            "is not a supported semver version",
                        )
                    elif parsed_client_version < parsed_min_version:
                        reasons.append(
                            f"{client_name} {_display_value(client_version)} is below "
                            f"required minimum {_display_value(min_version)}",
                        )

    compatible_ranges = manifest.get("compatible_client_ranges")
    if compatible_ranges is None:
        return
    if not isinstance(compatible_ranges, Mapping):
        reasons.append("compatible_client_ranges is present but is not a mapping")
        return

    compatible_range = compatible_ranges.get(client_name)
    if compatible_range is None:
        reasons.append(
            f"compatible_client_ranges is present but has no entry for {client_name!r}",
        )
        return
    if not isinstance(compatible_range, str):
        reasons.append(f"compatible_client_ranges[{client_name!r}] is not a string")
        return
    if not _version_satisfies_range(client_version, compatible_range):
        reasons.append(
            f"{client_name} {_display_value(client_version)} does not satisfy "
            f"compatible range {_display_value(compatible_range)}",
        )


def _capability_tool_names(value: Any) -> set[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return set()
    names: set[str] = set()
    for capability in value:
        if (
            isinstance(capability, Mapping)
            and capability.get("kind") == "tool"
            and isinstance(capability.get("name"), str)
        ):
            names.add(capability["name"])
    return names


def _tool_contract_names(value: Any) -> set[str]:
    if not isinstance(value, Mapping):
        return set()
    return {key for key in value if isinstance(key, str)}


def _version_satisfies_range(version: str, range_text: str) -> bool:
    parsed_version = _parse_version(version)
    if parsed_version is None:
        return False

    constraints = _parse_range_constraints(range_text)
    if not constraints:
        return False

    for operator, constraint_version in constraints:
        parsed_constraint = _parse_version(constraint_version)
        if parsed_constraint is None:
            return False
        op = operator or "="
        if op == ">=" and parsed_version < parsed_constraint:
            return False
        if op == ">" and parsed_version <= parsed_constraint:
            return False
        if op == "<=" and parsed_version > parsed_constraint:
            return False
        if op == "<" and parsed_version >= parsed_constraint:
            return False
        if op == "=" and parsed_version != parsed_constraint:
            return False
    return True


def _parse_range_constraints(range_text: str) -> tuple[tuple[str, str], ...]:
    constraints: list[tuple[str, str]] = []
    position = 0
    while position < len(range_text):
        while position < len(range_text) and range_text[position].isspace():
            position += 1
        if position >= len(range_text):
            break
        match = _RANGE_TOKEN_RE.match(range_text, position)
        if not match:
            return ()
        operator, constraint_version = match.groups()
        position = match.end()
        if position < len(range_text) and not range_text[position].isspace():
            return ()
        constraints.append((operator or "=", constraint_version))
    return tuple(constraints)


def _parse_version(version: str) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match(version.strip())
    if not match:
        return None
    major, minor, patch = match.groups()
    return int(major), int(minor), int(patch)


def _display_value(value: Any) -> str:
    if isinstance(value, str):
        digest = sha256(value.encode("utf-8")).hexdigest()[:_DISPLAY_DIGEST_LENGTH]
        return f"str(len={len(value)}, sha256={digest})"
    else:
        return repr(type(value).__name__)
