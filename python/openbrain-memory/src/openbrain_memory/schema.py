"""Convert Open Brain contract DSL nodes into JSON Schema.

The server publishes a small human-authored contract dialect through
``get_contract``. This module translates that dialect into JSON Schema shapes
that downstream clients can feed into tool-schema validators.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

JSONSchema = dict[str, Any]

_PRIMITIVE_TYPES = frozenset(
    {"string", "integer", "number", "boolean", "array", "object"},
)
_SEMANTIC_STRING_TYPES = frozenset(
    {"datetime_not_future", "git_sha", "https_github_url"},
)
_PRESERVED_KEYS = frozenset(
    {
        "additionalProperties",
        "default",
        "description",
        "maxItems",
        "maxLength",
        "minLength",
        "propertyNames",
    },
)


class ContractSchemaError(ValueError):
    """Raised when a contract DSL node cannot be converted safely."""


def contract_field_to_json_schema(node: Any, *, path: str = "$") -> JSONSchema:
    return _contract_field_to_json_schema(node, path=path, enum_refs={})


def contract_input_to_json_schema(
    input_schema: Mapping[str, Any],
    *,
    title: str | None = None,
) -> JSONSchema:
    if not isinstance(input_schema, Mapping):
        raise ContractSchemaError("$: input_schema must be a mapping")

    enum_refs = _collect_enum_refs(input_schema)
    schema = _fields_to_object_schema(input_schema, path="$", enum_refs=enum_refs)
    if title is not None:
        schema["title"] = title
    return schema


def tool_contract_to_input_schema(
    tool_name: str,
    tool_contract: Mapping[str, Any],
) -> JSONSchema:
    if not isinstance(tool_contract, Mapping):
        raise ContractSchemaError(
            f"$.tool_contracts.{tool_name}: tool contract must be a mapping",
        )
    input_schema = tool_contract.get("input_schema")
    if not isinstance(input_schema, Mapping):
        raise ContractSchemaError(
            f"$.tool_contracts.{tool_name}.input_schema: input_schema "
            "must be a mapping",
        )
    return contract_input_to_json_schema(input_schema, title=tool_name)


def tool_contracts_to_tool_schemas(
    manifest: Mapping[str, Any],
    *,
    tool_names: Iterable[str] | None = None,
) -> list[JSONSchema]:
    if not isinstance(manifest, Mapping):
        raise ContractSchemaError("$: manifest must be a mapping")
    tool_contracts = manifest.get("tool_contracts")
    if not isinstance(tool_contracts, Mapping):
        raise ContractSchemaError("$.tool_contracts: tool_contracts must be a mapping")

    selected_names = (
        list(tool_names) if tool_names is not None else sorted(tool_contracts)
    )
    enum_refs = _collect_manifest_enum_refs(tool_contracts)
    schemas: list[JSONSchema] = []
    for tool_name in selected_names:
        if tool_name not in tool_contracts:
            raise ContractSchemaError(
                f"$.tool_contracts.{tool_name}: tool contract is missing",
            )
        tool_contract = tool_contracts[tool_name]
        if not isinstance(tool_contract, Mapping):
            raise ContractSchemaError(
                f"$.tool_contracts.{tool_name}: tool contract must be a mapping",
            )
        input_schema = tool_contract.get("input_schema")
        if not isinstance(input_schema, Mapping):
            raise ContractSchemaError(
                f"$.tool_contracts.{tool_name}.input_schema: input_schema "
                "must be a mapping",
            )
        schemas.append(
            {
                "name": tool_name,
                "input_schema": _fields_to_object_schema(
                    input_schema,
                    path=f"$.tool_contracts.{tool_name}.input_schema",
                    enum_refs=enum_refs,
                ),
            },
        )
    return schemas


def _contract_field_to_json_schema(
    node: Any,
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> JSONSchema:
    if isinstance(node, str):
        return _resolve_string_ref(node, path=path, enum_refs=enum_refs)
    if not isinstance(node, Mapping):
        raise ContractSchemaError(f"{path}: contract node must be a mapping")

    if "type" not in node:
        return _typeless_node_to_json_schema(node, path=path, enum_refs=enum_refs)

    raw_type = node.get("type")
    if not isinstance(raw_type, str):
        raise ContractSchemaError(f"{path}.type: type must be a string")

    if raw_type == "enum":
        return _enum_node_to_json_schema(node, path=path)
    if raw_type == "literal":
        return _literal_node_to_json_schema(node, path=path)
    if raw_type in _SEMANTIC_STRING_TYPES:
        schema: JSONSchema = {"type": "string"}
        if raw_type == "datetime_not_future":
            schema["format"] = "date-time"
        _preserve_metadata(node, schema, path=path, enum_refs=enum_refs)
        return schema
    if raw_type not in _PRIMITIVE_TYPES:
        raise ContractSchemaError(
            f"{path}.type: unsupported contract type {raw_type!r}",
        )

    schema = {"type": raw_type}
    if raw_type == "array":
        schema["items"] = _array_items_schema(node, path=path, enum_refs=enum_refs)
    elif raw_type == "object":
        _apply_object_fields(node, schema, path=path, enum_refs=enum_refs)

    _preserve_metadata(node, schema, path=path, enum_refs=enum_refs)
    _preserve_numeric_bounds(node, schema, path=path)
    _preserve_nonstandard_bounds(node, schema, path=path)
    return schema


def _typeless_node_to_json_schema(
    node: Mapping[str, Any],
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> JSONSchema:
    if _has_explicit_object_marker(node):
        schema: JSONSchema = {"type": "object"}
        _apply_object_fields(node, schema, path=path, enum_refs=enum_refs)
        _preserve_metadata(node, schema, path=path, enum_refs=enum_refs)
        return schema

    if node and all(_is_contract_field_node(value) for value in node.values()):
        return _fields_to_object_schema(node, path=path, enum_refs=enum_refs)

    if any(_is_contract_field_node(value) for value in node.values()):
        raise ContractSchemaError(
            f"{path}: typeless contract node mixes contract fields with "
            "unsupported metadata",
        )

    if _is_json_metadata_value(node):
        return _metadata_value_to_json_schema(node)

    raise ContractSchemaError(
        f"{path}: typeless contract node is ambiguous; add type:'object', "
        "fields, propertyNames, or additionalProperties",
    )


def _enum_node_to_json_schema(node: Mapping[str, Any], *, path: str) -> JSONSchema:
    values = node.get("values")
    if not isinstance(values, list) or not values:
        raise ContractSchemaError(
            f"{path}.values: enum values must be a non-empty list",
        )
    inferred_type = _infer_enum_type(values)
    if inferred_type is None:
        raise ContractSchemaError(
            f"{path}.values: enum values must share one primitive type",
        )
    schema: JSONSchema = {"type": inferred_type, "enum": list(values)}
    _preserve_metadata(node, schema, path=path, enum_refs={})
    return schema


def _literal_node_to_json_schema(node: Mapping[str, Any], *, path: str) -> JSONSchema:
    if "value" not in node:
        raise ContractSchemaError(f"{path}.value: literal node must define value")
    schema: JSONSchema = {"const": node["value"]}
    inferred_type = _json_primitive_type(node["value"])
    if inferred_type is not None:
        schema["type"] = inferred_type
    _preserve_metadata(node, schema, path=path, enum_refs={})
    return schema


def _apply_object_fields(
    node: Mapping[str, Any],
    schema: JSONSchema,
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> None:
    fields = node.get("fields")
    if fields is None:
        return
    if not isinstance(fields, Mapping):
        raise ContractSchemaError(f"{path}.fields: fields must be a mapping")
    child_schema = _fields_to_object_schema(
        fields,
        path=f"{path}.fields",
        enum_refs={**enum_refs, **_collect_enum_refs(fields)},
    )
    schema["properties"] = child_schema["properties"]
    if "required" in child_schema:
        schema["required"] = child_schema["required"]


def _fields_to_object_schema(
    fields: Mapping[str, Any],
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> JSONSchema:
    properties: dict[str, Any] = {}
    required: list[str] = []
    required_groups: dict[str, list[str]] = {}
    for name, field in fields.items():
        if not isinstance(name, str):
            raise ContractSchemaError(f"{path}: field names must be strings")
        field_path = f"{path}.{name}"
        properties[name] = _contract_field_to_json_schema(
            field,
            path=field_path,
            enum_refs=enum_refs,
        )
        if isinstance(field, Mapping) and "required" in field:
            required_value = field["required"]
            if required_value is True:
                required.append(name)
            elif required_value is False:
                continue
            elif isinstance(required_value, str):
                required_groups.setdefault(required_value, []).append(name)
            else:
                raise ContractSchemaError(
                    f"{field_path}.required: required must be a boolean or string",
                )

    schema: JSONSchema = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    if required_groups:
        group_constraints = [
            {"anyOf": [{"required": [name]} for name in group_names]}
            for group_names in required_groups.values()
        ]
        if len(group_constraints) == 1:
            schema.update(group_constraints[0])
        else:
            schema["allOf"] = group_constraints
    return schema


def _array_items_schema(
    node: Mapping[str, Any],
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> JSONSchema:
    if "items" not in node:
        raise ContractSchemaError(f"{path}.items: array node must define items")
    return _contract_field_to_json_schema(
        node["items"],
        path=f"{path}.items",
        enum_refs=enum_refs,
    )


def _preserve_metadata(
    node: Mapping[str, Any],
    schema: JSONSchema,
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> None:
    for key in _PRESERVED_KEYS:
        if key not in node:
            continue
        value = node[key]
        if key == "propertyNames":
            schema[key] = _contract_field_to_json_schema(
                value,
                path=f"{path}.{key}",
                enum_refs=enum_refs,
            )
        elif key == "additionalProperties" and isinstance(value, Mapping):
            schema[key] = _contract_field_to_json_schema(
                value,
                path=f"{path}.{key}",
                enum_refs=enum_refs,
            )
        elif key == "additionalProperties":
            if not isinstance(value, bool):
                raise ContractSchemaError(
                    f"{path}.{key}: additionalProperties must be a boolean "
                    "or mapping",
                )
            schema[key] = value
        elif key in {"minLength", "maxLength", "maxItems"}:
            schema[key] = _nonnegative_integer(value, path=f"{path}.{key}")
        elif key == "description":
            if not isinstance(value, str):
                raise ContractSchemaError(f"{path}.{key}: description must be a string")
            schema[key] = value
        else:
            schema[key] = value


def _preserve_numeric_bounds(
    node: Mapping[str, Any],
    schema: JSONSchema,
    *,
    path: str,
) -> None:
    if "min" in node:
        schema["minimum"] = _number(node["min"], path=f"{path}.min")
    if "max" in node:
        schema["maximum"] = _number(node["max"], path=f"{path}.max")


def _preserve_nonstandard_bounds(
    node: Mapping[str, Any],
    schema: JSONSchema,
    *,
    path: str,
) -> None:
    if "maxItemLength" in node:
        value = _nonnegative_integer(
            node["maxItemLength"],
            path=f"{path}.maxItemLength",
        )
        items = schema.get("items")
        if (
            schema.get("type") != "array"
            or not isinstance(items, dict)
            or items.get("type") != "string"
        ):
            raise ContractSchemaError(
                f"{path}.maxItemLength: maxItemLength only maps to string "
                "array items",
            )
        items["maxLength"] = value
    if "maxKeys" in node:
        schema["x-openbrain-maxKeys"] = _nonnegative_integer(
            node["maxKeys"],
            path=f"{path}.maxKeys",
        )
    if "maxJsonBytes" in node:
        schema["x-openbrain-maxJsonBytes"] = _nonnegative_integer(
            node["maxJsonBytes"],
            path=f"{path}.maxJsonBytes",
        )


def _resolve_string_ref(
    ref: str,
    *,
    path: str,
    enum_refs: Mapping[str, JSONSchema],
) -> JSONSchema:
    if ref in _PRIMITIVE_TYPES:
        return {"type": ref}
    if ref in _SEMANTIC_STRING_TYPES:
        schema: JSONSchema = {"type": "string"}
        if ref == "datetime_not_future":
            schema["format"] = "date-time"
        return schema
    if ref in enum_refs:
        return dict(enum_refs[ref])
    raise ContractSchemaError(f"{path}: unresolved contract schema reference {ref!r}")


def _collect_manifest_enum_refs(
    tool_contracts: Mapping[str, Any],
) -> dict[str, JSONSchema]:
    refs: dict[str, JSONSchema] = {}
    for tool_name, tool_contract in tool_contracts.items():
        if not isinstance(tool_contract, Mapping):
            continue
        input_schema = tool_contract.get("input_schema")
        if isinstance(input_schema, Mapping):
            _merge_enum_refs(
                refs,
                _collect_enum_refs(
                    input_schema,
                    path=f"$.tool_contracts.{tool_name}.input_schema",
                    scoped_session_aliases=tool_name == "append_session_event",
                ),
            )
    return refs


def _collect_enum_refs(
    fields: Mapping[str, Any],
    *,
    path: str = "$",
    scoped_session_aliases: bool = False,
) -> dict[str, JSONSchema]:
    refs: dict[str, JSONSchema] = {}
    for name, field in fields.items():
        if not isinstance(name, str) or not isinstance(field, Mapping):
            continue
        field_path = f"{path}.{name}"
        if field.get("type") == "enum":
            schema = _enum_node_to_json_schema(field, path=field_path)
            _merge_enum_refs(refs, {name: schema}, path=field_path)
            if scoped_session_aliases and name == "event_type":
                _merge_enum_refs(refs, {"session_event_type": schema}, path=field_path)
        nested_fields = field.get("fields")
        if isinstance(nested_fields, Mapping):
            _merge_enum_refs(
                refs,
                _collect_enum_refs(
                    nested_fields,
                    path=f"{field_path}.fields",
                    scoped_session_aliases=scoped_session_aliases,
                ),
            )
    return refs


def _merge_enum_refs(
    refs: dict[str, JSONSchema],
    candidates: Mapping[str, JSONSchema],
    *,
    path: str = "$",
) -> None:
    for name, schema in candidates.items():
        if name in refs and refs[name] != schema:
            raise ContractSchemaError(f"{path}: conflicting enum reference {name!r}")
        refs[name] = dict(schema)


def _has_explicit_object_marker(node: Mapping[str, Any]) -> bool:
    return any(
        key in node for key in ("fields", "propertyNames", "additionalProperties")
    )


def _is_contract_field_node(value: Any) -> bool:
    if isinstance(value, str):
        return True
    if not isinstance(value, Mapping):
        return False
    raw_type = value.get("type")
    return isinstance(raw_type, str) or _has_explicit_object_marker(value)


def _is_json_metadata_value(value: Any) -> bool:
    if value is None or isinstance(value, str | int | float | bool):
        return True
    if isinstance(value, list):
        return all(_is_json_metadata_value(item) for item in value)
    if isinstance(value, Mapping):
        return all(
            isinstance(key, str) and _is_json_metadata_value(child)
            for key, child in value.items()
        )
    return False


def _metadata_value_to_json_schema(value: Any) -> JSONSchema:
    if isinstance(value, Mapping):
        properties = {
            key: _metadata_value_to_json_schema(child) for key, child in value.items()
        }
        schema: JSONSchema = {
            "type": "object",
            "properties": properties,
            "additionalProperties": False,
        }
        if properties:
            schema["required"] = list(properties)
        return schema
    if isinstance(value, list):
        item_schemas = [_metadata_value_to_json_schema(item) for item in value]
        schema = {"type": "array"}
        if item_schemas:
            schema["prefixItems"] = item_schemas
            schema["minItems"] = len(item_schemas)
            schema["maxItems"] = len(item_schemas)
        return schema
    inferred_type = _json_primitive_type(value)
    if inferred_type is None:
        return {"type": "null", "const": None}
    return {"type": inferred_type, "const": value}


def _infer_enum_type(values: list[Any]) -> str | None:
    inferred = {_json_primitive_type(value) for value in values}
    if len(inferred) != 1:
        return None
    value = inferred.pop()
    return value if value in {"string", "integer", "number", "boolean"} else None


def _json_primitive_type(value: Any) -> str | None:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int) and not isinstance(value, bool):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    return None


def _number(value: Any, *, path: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ContractSchemaError(f"{path}: bound must be a number")
    return value


def _nonnegative_integer(value: Any, *, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ContractSchemaError(f"{path}: bound must be a non-negative integer")
    return value
