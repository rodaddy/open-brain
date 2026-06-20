from __future__ import annotations

from copy import deepcopy

from openbrain_memory import (
    CURRENT_CONTRACT_VERSION,
    REQUIRED_CONTRACT_TOOLS,
    validate_contract_manifest,
)


def live_shaped_manifest() -> dict:
    return {
        "service": "open-brain",
        "contract_version": CURRENT_CONTRACT_VERSION,
        "contract_scope": "required_openbrain_memory_contract",
        "schema_version": 1,
        "schema_hash": "abc123",
        "generated_at": "2026-06-19T00:00:00.000Z",
        "min_client_versions": {
            "openbrain-memory": "0.1.0",
            "rtech-hermes-runtime": "0.1.0",
        },
        "compatible_client_ranges": {
            "openbrain-memory": ">=0.1.0 <1.0.0",
            "rtech-hermes-runtime": ">=0.1.0 <1.0.0",
        },
        "transport": {
            "mcp": "streamable-http",
            "auth": "bearer",
            "namespace_boundary": "authorization",
            "session_required": True,
        },
        "capabilities": [
            {
                "name": tool_name,
                "version": 1,
                "kind": "tool",
                "description": f"{tool_name} helper",
            }
            for tool_name in REQUIRED_CONTRACT_TOOLS
        ],
        "tool_contracts": {
            tool_name: {
                "version": 1,
                "input_schema": {"type": "object"},
                "output_shape": "object",
            }
            for tool_name in REQUIRED_CONTRACT_TOOLS
        },
    }


def test_validate_contract_manifest_accepts_live_get_contract_shape():
    result = validate_contract_manifest(
        live_shaped_manifest(),
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is True
    assert result.reasons == ()


def test_validate_contract_manifest_reports_missing_required_tool():
    manifest = live_shaped_manifest()
    manifest["capabilities"] = [
        item for item in manifest["capabilities"] if item["name"] != "search_all"
    ]
    del manifest["tool_contracts"]["search_all"]

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == (
        "required tool(s) missing from contract capabilities/tool_contracts: "
        "search_all",
    )


def test_validate_contract_manifest_reports_scope_and_contract_version_mismatch():
    manifest = live_shaped_manifest()
    manifest["contract_scope"] = "optional_tool_listing"
    manifest["contract_version"] = "2026-01-01.memory-tools.v1"

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == (
        "contract_scope mismatch: expected "
        "'required_openbrain_memory_contract', got 'optional_tool_listing'",
        "contract_version '2026-01-01.memory-tools.v1' is not compatible; "
        f"expected one of: {CURRENT_CONTRACT_VERSION!r}",
    )


def test_validate_contract_manifest_reports_min_client_version_failure():
    manifest = live_shaped_manifest()

    result = validate_contract_manifest(manifest, client_version="0.0.9")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory 0.0.9 is below required minimum 0.1.0",
        "openbrain-memory 0.0.9 does not satisfy compatible range '>=0.1.0 <1.0.0'",
    )


def test_validate_contract_manifest_reports_compatible_range_failure():
    manifest = live_shaped_manifest()

    result = validate_contract_manifest(manifest, client_version="1.0.0")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory 1.0.0 does not satisfy compatible range '>=0.1.0 <1.0.0'",
    )


def test_validate_contract_manifest_reports_malformed_client_compatibility_fields():
    manifest = deepcopy(live_shaped_manifest())
    manifest["min_client_versions"]["openbrain-memory"] = 1
    manifest["compatible_client_ranges"]["openbrain-memory"] = []

    result = validate_contract_manifest(manifest, client_version="0.1.0")

    assert result.ok is False
    assert result.reasons == (
        "min_client_versions['openbrain-memory'] is not a string",
        "compatible_client_ranges['openbrain-memory'] is not a string",
    )


def test_validate_contract_manifest_does_not_require_snapshot_constants():
    manifest = live_shaped_manifest()
    manifest["contract_version"] = "2026-06-20.memory-tools.v6"

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
    )

    assert result.ok is True
    assert result.reasons == ()
