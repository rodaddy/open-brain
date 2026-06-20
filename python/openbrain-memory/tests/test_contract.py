from __future__ import annotations

from copy import deepcopy

from openbrain_memory import (
    CURRENT_CONTRACT_VERSION,
    REQUIRED_CONTRACT_TOOLS,
    validate_contract_manifest,
)


def representative_contract_manifest() -> dict:
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


def test_validate_contract_manifest_accepts_representative_contract_shape():
    result = validate_contract_manifest(
        representative_contract_manifest(),
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is True
    assert result.reasons == ()


def test_validate_contract_manifest_reports_missing_required_tool():
    manifest = representative_contract_manifest()
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
        "required tool(s) missing from contract capabilities: search_all",
        "required tool(s) missing from tool_contracts: search_all",
    )


def test_validate_contract_manifest_rejects_capability_only_required_tool():
    manifest = representative_contract_manifest()
    del manifest["tool_contracts"]["search_all"]

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == (
        "required tool(s) missing from tool_contracts: search_all",
    )


def test_validate_contract_manifest_rejects_tool_contract_only_required_tool():
    manifest = representative_contract_manifest()
    manifest["capabilities"] = [
        item for item in manifest["capabilities"] if item["name"] != "search_all"
    ]

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == (
        "required tool(s) missing from contract capabilities: search_all",
    )


def test_validate_contract_manifest_rejects_malformed_required_tool_contract():
    manifest = representative_contract_manifest()
    manifest["tool_contracts"]["search_all"] = {
        "version": "",
        "input_schema": "object",
    }

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == (
        "tool_contracts['search_all'].version is missing or empty",
        "tool_contracts['search_all'].input_schema must be a mapping",
        "tool_contracts['search_all'] must define a non-empty output_shape "
        "or output_schema mapping",
    )


def test_validate_contract_manifest_rejects_non_mapping_required_tool_contract():
    manifest = representative_contract_manifest()
    manifest["tool_contracts"]["search_all"] = []

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == ("tool_contracts['search_all'] must be a mapping",)


def test_validate_contract_manifest_reports_scope_and_contract_version_mismatch():
    manifest = representative_contract_manifest()
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
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(manifest, client_version="0.0.9")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory '0.0.9' is below required minimum '0.1.0'",
        "openbrain-memory '0.0.9' does not satisfy compatible range '>=0.1.0 <1.0.0'",
    )


def test_validate_contract_manifest_reports_compatible_range_failure():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(manifest, client_version="1.0.0")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory '1.0.0' does not satisfy compatible range '>=0.1.0 <1.0.0'",
    )


def test_validate_contract_manifest_reports_malformed_client_compatibility_fields():
    manifest = deepcopy(representative_contract_manifest())
    manifest["min_client_versions"]["openbrain-memory"] = 1
    manifest["compatible_client_ranges"]["openbrain-memory"] = []

    result = validate_contract_manifest(manifest, client_version="0.1.0")

    assert result.ok is False
    assert result.reasons == (
        "min_client_versions['openbrain-memory'] is not a string",
        "compatible_client_ranges['openbrain-memory'] is not a string",
    )


def test_validate_contract_manifest_rejects_malformed_compatible_range_text():
    manifest = representative_contract_manifest()
    manifest["compatible_client_ranges"]["openbrain-memory"] = ">=0.1.0 <1.0.0 trailing"

    result = validate_contract_manifest(manifest, client_version="0.1.0")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory '0.1.0' does not satisfy compatible range "
        "'>=0.1.0 <1.0.0 trailing'",
    )


def test_validate_contract_manifest_rejects_unsupported_range_operator():
    manifest = representative_contract_manifest()
    manifest["compatible_client_ranges"]["openbrain-memory"] = "~>0.1.0"

    result = validate_contract_manifest(manifest, client_version="0.1.0")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory '0.1.0' does not satisfy compatible range '~>0.1.0'",
    )


def test_validate_contract_manifest_rejects_prerelease_client_version():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(manifest, client_version="0.1.0-alpha")

    assert result.ok is False
    assert result.reasons == (
        "client_version '0.1.0-alpha' is not a supported semver version",
    )


def test_validate_contract_manifest_fails_closed_for_unknown_client_name():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(
        manifest,
        client_name="typoed-client",
        client_version="0.1.0",
    )

    assert result.ok is False
    assert result.reasons == (
        "min_client_versions is present but has no entry for 'typoed-client'",
        "compatible_client_ranges is present but has no entry for 'typoed-client'",
    )


def test_validate_contract_manifest_redacts_long_manifest_values_in_reasons():
    manifest = representative_contract_manifest()
    manifest["contract_scope"] = "evil-" + ("x" * 200)
    manifest["compatible_client_ranges"]["openbrain-memory"] = ">=0.1.0 " + ("x" * 200)

    result = validate_contract_manifest(manifest, client_version="0.1.0")

    assert result.ok is False
    assert len(result.reasons) == 2
    assert "evil-" in result.reasons[0]
    assert "xxx" in result.reasons[0]
    assert "..." in result.reasons[0]
    assert "x" * 100 not in result.reasons[0]
    assert "x" * 100 not in result.reasons[1]


def test_validate_contract_manifest_does_not_require_snapshot_constants():
    manifest = representative_contract_manifest()
    manifest["contract_version"] = "2026-06-20.memory-tools.v6"

    result = validate_contract_manifest(
        manifest,
        client_version="0.1.0",
        required_tools=REQUIRED_CONTRACT_TOOLS,
    )

    assert result.ok is True
    assert result.reasons == ()
