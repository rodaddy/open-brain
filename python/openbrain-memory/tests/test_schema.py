from __future__ import annotations

import pytest

from openbrain_memory import (
    ContractSchemaError,
    contract_field_to_json_schema,
    contract_input_to_json_schema,
    tool_contract_to_input_schema,
    tool_contracts_to_tool_schemas,
)


def test_enum_values_convert_with_inferred_type():
    assert contract_field_to_json_schema(
        {
            "type": "enum",
            "values": ["hybrid", "vector", "keyword"],
            "description": "Search mode.",
            "default": "hybrid",
        },
        path="$.search_mode",
    ) == {
        "type": "string",
        "enum": ["hybrid", "vector", "keyword"],
        "description": "Search mode.",
        "default": "hybrid",
    }


def test_literal_value_converts_to_const():
    assert contract_field_to_json_schema(
        {
            "type": "literal",
            "value": "qmd",
            "description": "Source system.",
        },
        path="$.metadata.source_system",
    ) == {
        "const": "qmd",
        "type": "string",
        "description": "Source system.",
    }


def test_min_max_constraints_convert_to_json_schema_bounds():
    assert contract_field_to_json_schema(
        {"type": "number", "min": 0, "max": 1, "default": 1},
        path="$.confidence",
    ) == {"type": "number", "default": 1, "minimum": 0, "maximum": 1}


def test_malformed_schema_keyword_types_fail_with_path():
    invalid_nodes = [
        ("$.score.min", {"type": "number", "min": "0"}),
        ("$.name.maxLength", {"type": "string", "maxLength": "100"}),
        ("$.tags.maxItems", {"type": "array", "items": "string", "maxItems": 3.5}),
        (
            "$.metadata.additionalProperties",
            {"type": "object", "additionalProperties": "no"},
        ),
        (
            "$.tags.maxItemLength",
            {"type": "array", "items": "string", "maxItemLength": -1},
        ),
    ]

    for expected_path, node in invalid_nodes:
        path_match = expected_path.replace("$", r"\$")
        with pytest.raises(ContractSchemaError, match=path_match):
            contract_field_to_json_schema(node, path=expected_path.rsplit(".", 1)[0])


def test_nested_fields_convert_to_properties_and_required_list():
    assert contract_field_to_json_schema(
        {
            "type": "object",
            "fields": {
                "share_candidate": {"type": "boolean", "required": False},
                "reason": {"type": "string", "required": True},
            },
        },
        path="$.metadata",
    ) == {
        "type": "object",
        "properties": {
            "share_candidate": {"type": "boolean"},
            "reason": {"type": "string"},
        },
        "required": ["reason"],
    }


def test_arrays_convert_string_item_refs_and_manifest_enum_refs():
    manifest = {
        "tool_contracts": {
            "append_session_event": {
                "version": 3,
                "input_schema": {
                    "event_type": {
                        "type": "enum",
                        "required": True,
                        "values": ["fact", "decision", "blocker"],
                    },
                },
                "output_shape": "event",
            },
            "session_context": {
                "version": 2,
                "input_schema": {
                    "event_types": {
                        "type": "array",
                        "items": "session_event_type",
                    },
                    "tags": {"type": "array", "items": "string"},
                },
                "output_shape": "context",
            },
        },
    }

    [schema] = tool_contracts_to_tool_schemas(
        manifest,
        tool_names=["session_context"],
    )

    assert schema["input_schema"]["properties"]["tags"] == {
        "type": "array",
        "items": {"type": "string"},
    }
    assert schema["input_schema"]["properties"]["event_types"] == {
        "type": "array",
        "items": {
            "type": "string",
            "enum": ["fact", "decision", "blocker"],
        },
    }


def test_same_named_enums_are_scoped_to_each_tool_contract():
    manifest = {
        "tool_contracts": {
            "first": {
                "input_schema": {
                    "status": {"type": "enum", "values": ["open", "closed"]},
                },
            },
            "second": {
                "input_schema": {
                    "status": {"type": "enum", "values": ["hot", "cold"]},
                },
            },
        },
    }

    schemas = tool_contracts_to_tool_schemas(manifest)

    assert schemas[0]["name"] == "first"
    assert schemas[0]["input_schema"]["properties"]["status"] == {
        "type": "string",
        "enum": ["open", "closed"],
    }
    assert schemas[1]["name"] == "second"
    assert schemas[1]["input_schema"]["properties"]["status"] == {
        "type": "string",
        "enum": ["hot", "cold"],
    }


def test_selected_tool_conversion_ignores_unrelated_enum_name_collisions():
    manifest = {
        "tool_contracts": {
            "first": {
                "input_schema": {
                    "status": {"type": "enum", "values": ["open", "closed"]},
                },
            },
            "second": {
                "input_schema": {
                    "status": {"type": "enum", "values": ["hot", "cold"]},
                },
            },
        },
    }

    [schema] = tool_contracts_to_tool_schemas(manifest, tool_names=["second"])

    assert schema["name"] == "second"
    assert schema["input_schema"]["properties"]["status"] == {
        "type": "string",
        "enum": ["hot", "cold"],
    }


def test_selected_tool_local_session_event_type_enum_shadows_shared_alias():
    manifest = {
        "tool_contracts": {
            "append_session_event": {
                "input_schema": {
                    "event_type": {"type": "enum", "values": ["fact", "decision"]},
                },
            },
            "selected": {
                "input_schema": {
                    "session_event_type": {
                        "type": "enum",
                        "values": ["local", "only"],
                    },
                },
            },
        },
    }

    [schema] = tool_contracts_to_tool_schemas(manifest, tool_names=["selected"])

    assert schema["input_schema"]["properties"]["session_event_type"] == {
        "type": "string",
        "enum": ["local", "only"],
    }


def test_selected_tool_without_shared_ref_does_not_validate_unrelated_alias_source():
    manifest = {
        "tool_contracts": {
            "append_session_event": {
                "input_schema": {
                    "event_type": {
                        "type": "enum",
                        "values": "malformed",
                    },
                },
            },
            "selected": {
                "input_schema": {
                    "query": {"type": "string"},
                },
            },
        },
    }

    [schema] = tool_contracts_to_tool_schemas(manifest, tool_names=["selected"])

    assert schema["input_schema"]["properties"]["query"] == {"type": "string"}


def test_session_event_type_alias_is_scoped_to_append_session_event():
    manifest = {
        "tool_contracts": {
            "other_tool": {
                "input_schema": {
                    "event_type": {"type": "enum", "values": ["unrelated"]},
                },
            },
            "session_context": {
                "input_schema": {
                    "event_types": {"type": "array", "items": "session_event_type"},
                },
            },
        },
    }

    with pytest.raises(
        ContractSchemaError,
        match=r"\$\.tool_contracts\.session_context\.input_schema\.event_types\.items",
    ):
        tool_contracts_to_tool_schemas(manifest, tool_names=["session_context"])


def test_typeless_contract_field_maps_convert_to_object_properties():
    assert contract_field_to_json_schema(
        {
            "source_system": {"type": "literal", "value": "qmd", "required": True},
            "repo": {"type": "string", "required": True, "maxLength": 300},
            "confidence": {"type": "number", "min": 0, "max": 1, "default": 1},
        },
        path="$.metadata",
    ) == {
        "type": "object",
        "properties": {
            "source_system": {"const": "qmd", "type": "string"},
            "repo": {"type": "string", "maxLength": 300},
            "confidence": {
                "type": "number",
                "default": 1,
                "minimum": 0,
                "maximum": 1,
            },
        },
        "additionalProperties": False,
        "required": ["source_system", "repo"],
    }


def test_typeless_object_markers_convert_property_names_and_additional_properties():
    assert contract_field_to_json_schema(
        {
            "propertyNames": {"type": "string", "maxLength": 100},
            "additionalProperties": {"type": "string"},
            "description": "Metadata.",
        },
        path="$.metadata",
    ) == {
        "type": "object",
        "propertyNames": {"type": "string", "maxLength": 100},
        "additionalProperties": {"type": "string"},
        "description": "Metadata.",
    }


def test_real_repo_fact_metadata_typeless_contract_converts_to_object_schema():
    schema = contract_field_to_json_schema(
        {
            "source_system": {
                "type": "literal",
                "value": "qmd",
                "required": True,
            },
            "repo": {"type": "string", "required": True, "maxLength": 300},
            "collection": {"type": "string", "required": True, "maxLength": 300},
            "path": {"type": "string", "required": True, "maxLength": 1000},
            "symbol": {
                "type": "string",
                "required": "symbol_or_subject",
                "maxLength": 300,
            },
            "subject": {
                "type": "string",
                "required": "symbol_or_subject",
                "maxLength": 500,
            },
            "fact_type": {
                "type": "enum",
                "required": True,
                "values": ["ownership", "gotcha", "api_contract"],
            },
            "fact": {"type": "string", "required": True, "maxLength": 2000},
            "source_commit": {"type": "git_sha", "required": True},
            "source_url": {"type": "https_github_url", "required": True},
            "verified_at": {"type": "datetime_not_future", "required": True},
            "confidence": {"type": "number", "min": 0, "max": 1, "default": 1},
            "staleness_policy": {
                "type": "enum",
                "required": True,
                "values": ["stable_fact_verify_source", "commit_pinned"],
            },
            "refresh_hint": {"type": "string", "required": False, "maxLength": 1000},
        },
        path="$.tool_contracts.upsert_repo_fact.input_schema.metadata",
    )

    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert schema["required"] == [
        "source_system",
        "repo",
        "collection",
        "path",
        "fact_type",
        "fact",
        "source_commit",
        "source_url",
        "verified_at",
        "staleness_policy",
    ]
    assert schema["properties"]["source_system"] == {
        "const": "qmd",
        "type": "string",
    }
    assert schema["properties"]["source_commit"] == {"type": "string"}
    assert schema["properties"]["verified_at"] == {
        "type": "string",
        "format": "date-time",
    }
    assert schema["properties"]["fact_type"] == {
        "type": "string",
        "enum": ["ownership", "gotcha", "api_contract"],
    }
    assert schema["properties"]["confidence"] == {
        "type": "number",
        "default": 1,
        "minimum": 0,
        "maximum": 1,
    }
    assert schema["anyOf"] == [{"required": ["symbol"]}, {"required": ["subject"]}]


def test_required_string_groups_convert_to_anyof_required_alternatives():
    assert contract_input_to_json_schema(
        {
            "session_key": {"type": "string", "required": "session_key_or_channel_id"},
            "channel_id": {"type": "string", "required": "session_key_or_channel_id"},
        },
    ) == {
        "type": "object",
        "properties": {
            "session_key": {"type": "string"},
            "channel_id": {"type": "string"},
        },
        "additionalProperties": False,
        "anyOf": [{"required": ["session_key"]}, {"required": ["channel_id"]}],
    }


def test_multiple_required_string_groups_require_each_group():
    assert contract_input_to_json_schema(
        {
            "session_key": {"type": "string", "required": "session_key_or_channel_id"},
            "channel_id": {"type": "string", "required": "session_key_or_channel_id"},
            "symbol": {"type": "string", "required": "symbol_or_subject"},
            "subject": {"type": "string", "required": "symbol_or_subject"},
        },
    ) == {
        "type": "object",
        "properties": {
            "session_key": {"type": "string"},
            "channel_id": {"type": "string"},
            "symbol": {"type": "string"},
            "subject": {"type": "string"},
        },
        "additionalProperties": False,
        "allOf": [
            {
                "anyOf": [
                    {"required": ["session_key"]},
                    {"required": ["channel_id"]},
                ],
            },
            {
                "anyOf": [
                    {"required": ["symbol"]},
                    {"required": ["subject"]},
                ],
            },
        ],
    }


def test_typed_object_fields_preserve_required_string_groups():
    assert contract_field_to_json_schema(
        {
            "type": "object",
            "fields": {
                "symbol": {"type": "string", "required": "symbol_or_subject"},
                "subject": {"type": "string", "required": "symbol_or_subject"},
            },
        },
        path="$.metadata",
    ) == {
        "type": "object",
        "properties": {
            "symbol": {"type": "string"},
            "subject": {"type": "string"},
        },
        "anyOf": [{"required": ["symbol"]}, {"required": ["subject"]}],
    }


def test_current_dsl_bounds_convert_or_use_vendor_extensions():
    assert contract_field_to_json_schema(
        {
            "type": "array",
            "items": "string",
            "maxItems": 4,
            "maxItemLength": 20,
        },
        path="$.tags",
    ) == {
        "type": "array",
        "items": {"type": "string", "maxLength": 20},
        "maxItems": 4,
    }

    assert contract_field_to_json_schema(
        {"type": "object", "maxKeys": 8, "maxJsonBytes": 4096},
        path="$.metadata",
    ) == {
        "type": "object",
        "x-openbrain-maxKeys": 8,
        "x-openbrain-maxJsonBytes": 4096,
    }


def test_max_item_length_on_non_string_array_fails_with_path():
    with pytest.raises(ContractSchemaError, match=r"\$\.ids\.maxItemLength"):
        contract_field_to_json_schema(
            {"type": "array", "items": "integer", "maxItemLength": 20},
            path="$.ids",
        )


def test_real_repo_fact_validation_metadata_converts_to_conservative_schema():
    schema = contract_field_to_json_schema(
        {
            "source_url": {
                "allowed_hosts": ["github.com", "raw.githubusercontent.com"],
                "protocol": "https",
                "credentials_allowed": False,
                "local_private_hosts_allowed": False,
                "github_url_shapes": [
                    "/<owner>/<repo>/blob/<source_commit>/<repo_relative_path>",
                    "/<owner>/<repo>/<source_commit>/<repo_relative_path>",
                ],
                "repo_match": "url repo segment must match metadata.repo slug",
                "commit_match": "source_commit must be a path segment",
                "path_match": "exact repo-relative path match",
            },
            "fact_body": {
                "raw_code_chunks_allowed": False,
                "credential_like_material_allowed": False,
                "max_lines": 6,
                "rejected_secret_shapes": [
                    "labelled token/password/secret/api_key/authorization values",
                    "AWS access key IDs",
                ],
            },
        },
        path="$.tool_contracts.upsert_repo_fact.input_schema.validation",
    )

    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["source_url", "fact_body"]
    assert schema["properties"]["source_url"]["properties"]["protocol"] == {
        "type": "string",
        "const": "https",
    }
    assert schema["properties"]["source_url"]["properties"]["allowed_hosts"] == {
        "type": "array",
        "prefixItems": [
            {"type": "string", "const": "github.com"},
            {"type": "string", "const": "raw.githubusercontent.com"},
        ],
        "minItems": 2,
        "maxItems": 2,
    }
    assert schema["properties"]["fact_body"]["properties"]["max_lines"] == {
        "type": "integer",
        "const": 6,
    }


def test_mixed_typeless_contract_and_metadata_nodes_fail_with_path():
    with pytest.raises(
        ContractSchemaError,
        match=r"\$\.metadata: typeless contract node mixes contract fields",
    ):
        contract_field_to_json_schema(
            {
                "repo": {"type": "string"},
                "validation_notes": {"allowed_hosts": ["github.com"]},
            },
            path="$.metadata",
        )


def test_contract_input_to_json_schema_wraps_field_mapping():
    assert contract_input_to_json_schema(
        {
            "query": {"type": "string", "required": True, "minLength": 1},
            "limit": {"type": "integer", "required": False, "min": 1, "max": 20},
        },
        title="search_all",
    ) == {
        "type": "object",
        "properties": {
            "query": {"type": "string", "minLength": 1},
            "limit": {"type": "integer", "minimum": 1, "maximum": 20},
        },
        "additionalProperties": False,
        "required": ["query"],
        "title": "search_all",
    }


def test_tool_contract_to_input_schema_converts_input_schema():
    assert tool_contract_to_input_schema(
        "search_all",
        {
            "version": 2,
            "input_schema": {"query": {"type": "string", "required": True}},
            "output_shape": "results",
        },
    ) == {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "additionalProperties": False,
        "required": ["query"],
        "title": "search_all",
    }


def test_tool_contracts_to_tool_schemas_filters_selected_tools():
    manifest = {
        "tool_contracts": {
            "search_all": {
                "version": 2,
                "input_schema": {"query": {"type": "string", "required": True}},
                "output_shape": "results",
            },
            "get_contract": {
                "version": 1,
                "input_schema": {},
                "output_shape": "contract",
            },
        },
    }

    assert tool_contracts_to_tool_schemas(
        manifest,
        tool_names=["get_contract"],
    ) == [
        {
            "name": "get_contract",
            "input_schema": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    ]


def test_unresolved_array_ref_fails_with_path():
    with pytest.raises(ContractSchemaError, match=r"\$\.event_types\.items"):
        contract_input_to_json_schema(
            {"event_types": {"type": "array", "items": "session_event_type"}},
        )


def test_representative_get_contract_manifest_converts_current_shapes():
    manifest = {
        "tool_contracts": {
            "append_session_event": {
                "version": 3,
                "input_schema": {
                    "session_key": {
                        "type": "string",
                        "required": "session_key_or_channel_id",
                    },
                    "channel_id": {
                        "type": "string",
                        "required": "session_key_or_channel_id",
                    },
                    "event_type": {
                        "type": "enum",
                        "required": True,
                        "values": ["fact", "decision", "blocker"],
                    },
                },
                "output_shape": "event",
            },
            "session_context": {
                "version": 2,
                "input_schema": {
                    "event_types": {
                        "type": "array",
                        "items": "session_event_type",
                        "maxItems": 12,
                    },
                },
                "output_shape": "context",
            },
            "upsert_repo_fact": {
                "version": 1,
                "input_schema": {
                    "metadata": {
                        "source_system": {
                            "type": "literal",
                            "value": "qmd",
                            "required": True,
                        },
                        "symbol": {
                            "type": "string",
                            "required": "symbol_or_subject",
                            "maxLength": 300,
                        },
                        "subject": {
                            "type": "string",
                            "required": "symbol_or_subject",
                            "maxLength": 500,
                        },
                        "tags": {
                            "type": "array",
                            "items": "string",
                            "maxItems": 5,
                            "maxItemLength": 40,
                        },
                    },
                    "validation": {
                        "fact_body": {
                            "type": "object",
                            "maxJsonBytes": 4096,
                            "maxKeys": 8,
                        },
                    },
                },
                "output_shape": "repo_fact",
            },
        },
    }

    schemas = {
        schema["name"]: schema["input_schema"]
        for schema in tool_contracts_to_tool_schemas(manifest)
    }

    assert schemas["session_context"]["properties"]["event_types"] == {
        "type": "array",
        "items": {"type": "string", "enum": ["fact", "decision", "blocker"]},
        "maxItems": 12,
    }
    assert schemas["append_session_event"]["anyOf"] == [
        {"required": ["session_key"]},
        {"required": ["channel_id"]},
    ]
    metadata = schemas["upsert_repo_fact"]["properties"]["metadata"]
    assert metadata["anyOf"] == [{"required": ["symbol"]}, {"required": ["subject"]}]
    assert metadata["properties"]["tags"]["items"] == {
        "type": "string",
        "maxLength": 40,
    }
    validation = schemas["upsert_repo_fact"]["properties"]["validation"]
    assert validation["properties"]["fact_body"] == {
        "type": "object",
        "x-openbrain-maxKeys": 8,
        "x-openbrain-maxJsonBytes": 4096,
    }
