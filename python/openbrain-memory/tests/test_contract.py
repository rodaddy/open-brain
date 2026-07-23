from __future__ import annotations

from copy import deepcopy
from hashlib import sha256

import pytest

from openbrain_memory import (
    COMPATIBLE_CONTRACT_VERSIONS,
    CURRENT_CONTRACT_SCHEMA_HASH,
    CURRENT_CONTRACT_SCHEMA_VERSION,
    CURRENT_CONTRACT_VERSION,
    PACKAGE_VERSION,
    REQUIRED_CONTRACT_TOOLS,
    validate_contract_manifest,
    validate_required_memory_contract,
)

CURRENT_CLIENT_VERSION = PACKAGE_VERSION
PREVIOUS_CLIENT_VERSION = "0.1.7"
PREVIOUS_CONTRACT_VERSION = "2026-07-13.memory-tools.v21"
CURRENT_REQUIRED_TOOL_VERSIONS = {
    "session_start": 2,
    "session_wrap": 2,
    "agent_context_pack": 2,
    "append_session_event": 8,
}


def safe_string_display(value: str) -> str:
    digest = sha256(value.encode("utf-8")).hexdigest()[:12]
    return f"str(len={len(value)}, sha256={digest})"


def representative_contract_manifest() -> dict:
    return {
        "service": "open-brain",
        "contract_version": CURRENT_CONTRACT_VERSION,
        "contract_scope": "required_openbrain_memory_contract",
        "schema_version": CURRENT_CONTRACT_SCHEMA_VERSION,
        "schema_hash": CURRENT_CONTRACT_SCHEMA_HASH,
        "generated_at": "2026-06-19T00:00:00.000Z",
        "min_client_versions": {
            "openbrain-memory": CURRENT_CLIENT_VERSION,
            "rtech-hermes-runtime": "0.1.0",
        },
        "compatible_client_ranges": {
            "openbrain-memory": ">=0.1.8 <1.0.0",
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
                "version": CURRENT_REQUIRED_TOOL_VERSIONS.get(tool_name, 1),
                "kind": "tool",
                "description": f"{tool_name} helper",
            }
            for tool_name in REQUIRED_CONTRACT_TOOLS
        ],
        "tool_contracts": {
            tool_name: {
                "version": CURRENT_REQUIRED_TOOL_VERSIONS.get(tool_name, 1),
                "input_schema": {"type": "object"},
                "output_shape": "object",
            }
            for tool_name in REQUIRED_CONTRACT_TOOLS
        },
    }


def test_validate_contract_manifest_accepts_representative_contract_shape():
    result = validate_contract_manifest(
        representative_contract_manifest(),
        client_version=CURRENT_CLIENT_VERSION,
        required_tools=REQUIRED_CONTRACT_TOOLS,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is True
    assert result.reasons == ()


def test_package_pins_reviewed_v22_schema_snapshot() -> None:
    assert CURRENT_CONTRACT_VERSION == "2026-07-17.memory-tools.v22"
    assert CURRENT_CONTRACT_SCHEMA_VERSION == 1
    assert CURRENT_CONTRACT_SCHEMA_HASH == (
        "51bd6bd9901b88d1f7ae71b95c34a374cbfa4488f706134334aa839bb7cb7c66"
    )


def test_validate_required_memory_contract_pins_package_contract_defaults():
    result = validate_required_memory_contract(
        representative_contract_manifest(),
        client_version=CURRENT_CLIENT_VERSION,
    )

    assert result.ok is True
    assert result.reasons == ()


@pytest.mark.parametrize(
    ("field", "value", "expected_reason"),
    [
        ("schema_version", None, "schema_version is missing or not an integer"),
        ("schema_version", "1", "schema_version is missing or not an integer"),
        ("schema_version", 2, "schema_version mismatch"),
        (
            "schema_hash",
            None,
            "schema_hash is missing or not a non-empty string",
        ),
        (
            "schema_hash",
            51,
            "schema_hash is missing or not a non-empty string",
        ),
        ("schema_hash", "0" * 64, "schema_hash mismatch"),
    ],
)
def test_required_contract_rejects_unreviewed_schema_snapshot(
    field: str,
    value: object,
    expected_reason: str,
) -> None:
    manifest = representative_contract_manifest()
    if value is None:
        del manifest[field]
    else:
        manifest[field] = value

    result = validate_required_memory_contract(
        manifest,
        client_version=CURRENT_CLIENT_VERSION,
    )

    assert result.ok is False
    assert any(expected_reason in reason for reason in result.reasons)
    assert manifest["contract_version"] == CURRENT_CONTRACT_VERSION
    assert all(
        capability["name"] in REQUIRED_CONTRACT_TOOLS
        for capability in manifest["capabilities"]
    )


def test_manifest_requires_current_package_without_overstating_legacy_compatibility():
    manifest = representative_contract_manifest()

    current = validate_required_memory_contract(
        manifest,
        client_version=CURRENT_CLIENT_VERSION,
    )
    previous_client = validate_required_memory_contract(
        manifest,
        client_version=PREVIOUS_CLIENT_VERSION,
    )

    assert CURRENT_CLIENT_VERSION == "0.1.13"
    assert manifest["min_client_versions"]["openbrain-memory"] == "0.1.13"
    assert manifest["compatible_client_ranges"]["openbrain-memory"] == (
        ">=0.1.8 <1.0.0"
    )
    assert current.ok is True
    assert previous_client.ok is False


def test_current_package_rejects_realistic_v21_first_class_contract():
    manifest = representative_contract_manifest()
    manifest["contract_version"] = PREVIOUS_CONTRACT_VERSION
    for capability in manifest["capabilities"]:
        if capability["name"] == "agent_context_pack":
            capability["version"] = 1
        if capability["name"] == "append_session_event":
            capability["version"] = 7
    manifest["tool_contracts"]["agent_context_pack"]["version"] = 1
    manifest["tool_contracts"]["append_session_event"]["version"] = 7

    result = validate_required_memory_contract(
        manifest,
        client_version=CURRENT_CLIENT_VERSION,
    )

    assert result.ok is False
    assert COMPATIBLE_CONTRACT_VERSIONS == (CURRENT_CONTRACT_VERSION,)
    assert any("contract_version" in reason for reason in result.reasons)
    assert "capability 'agent_context_pack'.version must be >= 2" in result.reasons
    assert "capability 'append_session_event'.version must be >= 8" in result.reasons
    assert "tool_contracts['agent_context_pack'].version must be >= 2" in result.reasons
    assert (
        "tool_contracts['append_session_event'].version must be >= 8" in result.reasons
    )


def test_validate_required_memory_contract_accepts_planned_realtime_advisory_metadata():
    manifest = representative_contract_manifest()
    manifest["realtime_transport"] = {
        "nats_jetstream": {
            "status": "planned-transport-foundation",
            "availability": "not_runtime_available",
            "fallback_transport": "http_mcp",
        },
    }

    result = validate_required_memory_contract(
        manifest,
        client_version=CURRENT_CLIENT_VERSION,
    )

    assert result.ok is True
    assert result.reasons == ()
    assert COMPATIBLE_CONTRACT_VERSIONS == (CURRENT_CONTRACT_VERSION,)


def test_validate_required_memory_contract_reports_package_required_tool_gap():
    manifest = representative_contract_manifest()
    manifest["capabilities"] = [
        item for item in manifest["capabilities"] if item["name"] != "lane_upsert"
    ]

    result = validate_required_memory_contract(manifest)

    assert result.ok is False
    assert result.reasons == (
        "required tool(s) missing from contract capabilities: lane_upsert",
    )


def test_validate_contract_manifest_reports_missing_required_tool():
    manifest = representative_contract_manifest()
    manifest["capabilities"] = [
        item for item in manifest["capabilities"] if item["name"] != "search_all"
    ]
    del manifest["tool_contracts"]["search_all"]

    result = validate_contract_manifest(
        manifest,
        client_version=CURRENT_CLIENT_VERSION,
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
        client_version=CURRENT_CLIENT_VERSION,
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
        client_version=CURRENT_CLIENT_VERSION,
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
        client_version=CURRENT_CLIENT_VERSION,
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
        client_version=CURRENT_CLIENT_VERSION,
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
        client_version=CURRENT_CLIENT_VERSION,
        compatible_contract_versions=(CURRENT_CONTRACT_VERSION,),
    )

    assert result.ok is False
    assert result.reasons == (
        "contract_scope mismatch: expected "
        "'required_openbrain_memory_contract', got "
        f"{safe_string_display('optional_tool_listing')}",
        "contract_version "
        f"{safe_string_display('2026-01-01.memory-tools.v1')} is not compatible; "
        f"expected one of: {safe_string_display(CURRENT_CONTRACT_VERSION)}",
    )


def test_validate_contract_manifest_reports_min_client_version_failure():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(manifest, client_version="0.0.9")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory "
        f"{safe_string_display('0.0.9')} is below required minimum "
        f"{safe_string_display(CURRENT_CLIENT_VERSION)}",
        "openbrain-memory "
        f"{safe_string_display('0.0.9')} does not satisfy compatible range "
        f"{safe_string_display('>=0.1.8 <1.0.0')}",
    )


def test_validate_contract_manifest_reports_compatible_range_failure():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(manifest, client_version="1.0.0")

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory "
        f"{safe_string_display('1.0.0')} does not satisfy compatible range "
        f"{safe_string_display('>=0.1.8 <1.0.0')}",
    )


def test_validate_contract_manifest_reports_malformed_client_compatibility_fields():
    manifest = deepcopy(representative_contract_manifest())
    manifest["min_client_versions"]["openbrain-memory"] = 1
    manifest["compatible_client_ranges"]["openbrain-memory"] = []

    result = validate_contract_manifest(manifest, client_version=CURRENT_CLIENT_VERSION)

    assert result.ok is False
    assert result.reasons == (
        "min_client_versions['openbrain-memory'] is not a string",
        "compatible_client_ranges['openbrain-memory'] is not a string",
    )


def test_validate_contract_manifest_rejects_malformed_compatible_range_text():
    manifest = representative_contract_manifest()
    manifest["compatible_client_ranges"]["openbrain-memory"] = ">=0.1.0 <1.0.0 trailing"

    result = validate_contract_manifest(manifest, client_version=CURRENT_CLIENT_VERSION)

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory "
        f"{safe_string_display(CURRENT_CLIENT_VERSION)} does not satisfy "
        "compatible range "
        f"{safe_string_display('>=0.1.0 <1.0.0 trailing')}",
    )


def test_validate_contract_manifest_rejects_unsupported_range_operator():
    manifest = representative_contract_manifest()
    manifest["compatible_client_ranges"]["openbrain-memory"] = "~>0.1.0"

    result = validate_contract_manifest(manifest, client_version=CURRENT_CLIENT_VERSION)

    assert result.ok is False
    assert result.reasons == (
        "openbrain-memory "
        f"{safe_string_display(CURRENT_CLIENT_VERSION)} does not satisfy "
        "compatible range "
        f"{safe_string_display('~>0.1.0')}",
    )


def test_validate_contract_manifest_rejects_prerelease_client_version():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(manifest, client_version="0.1.4-alpha")

    assert result.ok is False
    assert result.reasons == (
        "client_version '0.1.4-alpha' is not a supported semver version",
    )


def test_validate_contract_manifest_fails_closed_for_unknown_client_name():
    manifest = representative_contract_manifest()

    result = validate_contract_manifest(
        manifest,
        client_name="typoed-client",
        client_version=CURRENT_CLIENT_VERSION,
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

    result = validate_contract_manifest(manifest, client_version=CURRENT_CLIENT_VERSION)

    assert result.ok is False
    assert len(result.reasons) == 2
    assert safe_string_display(manifest["contract_scope"]) in result.reasons[0]
    assert (
        safe_string_display(
            manifest["compatible_client_ranges"]["openbrain-memory"],
        )
        in result.reasons[1]
    )
    assert "evil-" not in result.reasons[0]
    assert "xxx" not in result.reasons[0]
    assert "x" * 100 not in result.reasons[0]
    assert "x" * 100 not in result.reasons[1]


def test_validate_contract_manifest_redacts_token_like_manifest_values_in_reasons():
    manifest = representative_contract_manifest()
    token_body = "sk_live_sensitive_body_" + ("A" * 120)
    jwt_header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    jwt_payload = "eyJzdWIiOiJzZW5zaXRpdmUtcGF5bG9hZCIsInJvbGUiOiJhZG1pbiJ9"
    jwt_signature = "sensitive_signature_" + ("B" * 80)
    jwt_value = f"{jwt_header}.{jwt_payload}.{jwt_signature}"
    manifest["contract_scope"] = token_body
    manifest["compatible_client_ranges"]["openbrain-memory"] = jwt_value

    result = validate_contract_manifest(manifest, client_version=CURRENT_CLIENT_VERSION)
    reason_text = "\n".join(result.reasons)

    assert result.ok is False
    assert safe_string_display(token_body) in reason_text
    assert safe_string_display(jwt_value) in reason_text
    assert "sk_live_sensitive_body" not in reason_text
    assert "eyJhbGci" not in reason_text
    assert "eyJzdWIi" not in reason_text
    assert "sensitive_signature" not in reason_text


def test_validate_contract_manifest_does_not_require_snapshot_constants():
    manifest = representative_contract_manifest()
    manifest["contract_version"] = "2026-06-20.memory-tools.v6"

    result = validate_contract_manifest(
        manifest,
        client_version=CURRENT_CLIENT_VERSION,
        required_tools=REQUIRED_CONTRACT_TOOLS,
    )

    assert result.ok is True
    assert result.reasons == ()
