"""Bounded JSON console entry point for first-class Open Brain memory."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence

from .cli import (
    MAX_JSON_INPUT_BYTES,
    encode_json_output,
    execute_json,
    failure_output,
    parse_json_input,
)
from .runtime import ReceiptStatus


def main(argv: Sequence[str] | None = None) -> int:
    """Read one JSON object from stdin and emit one JSON object to stdout."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments:
        output = failure_output(
            "input",
            "arguments are not supported; provide bounded JSON on stdin",
        )
        sys.stdout.buffer.write(encode_json_output(output))
        return 2
    data = sys.stdin.buffer.read(MAX_JSON_INPUT_BYTES + 1)
    try:
        payload = parse_json_input(data)
        output = execute_json(payload)
        exit_code: int | None = None
    except Exception as error:
        output = failure_output("input", error)
        exit_code = 2
    encoded = encode_json_output(output)
    if exit_code is None:
        emitted = json.loads(encoded)
        status = emitted["receipt"]["status"]
        exit_code = 1 if status in {ReceiptStatus.FAILED, ReceiptStatus.LOST} else 0
    sys.stdout.buffer.write(encoded)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
