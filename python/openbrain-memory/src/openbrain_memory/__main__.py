"""Bounded JSON console entry point for first-class Open Brain memory."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence

from .cli import (
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
    # Read stdin to EOF. Reading a fixed count instead handed parse_json_input a
    # payload cut mid-object, which then failed as "not valid JSON" -- an error
    # naming the wrong cause and pointing the reader away from the size. Reading
    # it all means an oversized envelope is reported as oversized, by size.
    data = sys.stdin.buffer.read()
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
