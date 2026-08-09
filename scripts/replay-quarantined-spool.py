#!/usr/bin/env python3
"""Inspect, and OPTIONALLY restore, units the spool abandoned into its sidecar.

    # what is in there (default; touches nothing)
    python3 scripts/replay-quarantined-spool.py

    # restore every abandoned unit to the live spool for normal replay
    python3 scripts/replay-quarantined-spool.py --restore

WHY THIS EXISTS (#680, cutover blocker B2). After
``DEFAULT_QUARANTINE_THRESHOLD`` consecutive replay failures the provider moves
a unit to ``<spool>.quarantine.jsonl`` and never retries it automatically —
triage is operator-managed by design. Nothing in the tree could triage it,
because ``quarantined_count`` had no consumer anywhere. This is the triage
tool; the loudness that makes an operator KNOW to run it is the rest of #680.

WHAT IT WILL NOT DO, ON PURPOSE:

  - It never deletes. ``--restore`` REWRITES the sidecar without the units it
    moved, after those units are safely appended to the live spool, and it
    always writes a timestamped backup of the original sidecar first. A unit
    that fails again re-quarantines through the normal path.
  - It never decides. Replaying versus accepting the loss is the operator's
    call. The default run reports and exits.
  - It never dials the server. Restoring puts units back in the LIVE spool;
    the provider's ordinary drain delivers them on the next healthy operation.
    Delivery is the existing path's job, not this script's.

CONTENT-FREE OUTPUT. Operations, counts, keys, and unix times only — never
payload bodies. The sidecar holds already-redacted records, and this script
does not widen that exposure by printing them.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python" / "openbrain-memory" / "src"))
sys.path.insert(0, str(REPO_ROOT / "python" / "openbrain" / "src"))

from openbrain_memory.spool import (  # noqa: E402
    QUARANTINE_ENVELOPE_SCHEMA,
    JsonlSpool,
)


def default_spool() -> Path:
    """The provider spool this machine uses, resolved as the readers resolve it."""
    from openbrain.apps.capture.outage import default_spool_path  # noqa: PLC0415

    return default_spool_path()


def summarize(sidecar: Path) -> tuple[list[dict], Counter, Counter, int]:
    """Read the sidecar into envelopes plus content-free tallies."""
    envelopes: list[dict] = []
    operations: Counter = Counter()
    records: Counter = Counter()
    raw_turns = 0

    for line in sidecar.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        if parsed.get("schema") == QUARANTINE_ENVELOPE_SCHEMA:
            envelopes.append(parsed)
            operations[str(parsed.get("operation", "unknown"))] += 1
            continue
        operation = str(parsed.get("operation", "unknown"))
        records[operation] += 1
        if operation == "ingest_raw_turn":
            turns = parsed.get("payload", {}).get("turns")
            if isinstance(turns, list):
                raw_turns += len(turns)

    return envelopes, operations, records, raw_turns


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--spool",
        type=Path,
        default=None,
        help="live spool path (default: this machine's resolved spool)",
    )
    parser.add_argument(
        "--restore",
        action="store_true",
        help="move abandoned units back into the live spool (default: report only)",
    )
    args = parser.parse_args()

    spool_path = args.spool if args.spool is not None else default_spool()
    spool = JsonlSpool(spool_path)
    sidecar = spool.quarantine_path

    print(f"live spool : {spool_path}")
    print(f"sidecar    : {sidecar}")

    if not sidecar.exists() or sidecar.stat().st_size == 0:
        print("\nNothing quarantined. No action needed.")
        return 0

    envelopes, operations, records, raw_turns = summarize(sidecar)
    failures = [
        int(e["consecutive_failures"])
        for e in envelopes
        if isinstance(e.get("consecutive_failures"), (int, float))
    ]
    times = [
        float(e[key])
        for e in envelopes
        for key in ("first_failure_at", "last_failure_at", "quarantined_at")
        if isinstance(e.get(key), (int, float))
    ]

    print(f"\nABANDONED UNITS: {len(envelopes)}")
    for operation, count in sorted(records.items()):
        print(f"  {operation:24s} {count:5d} record line(s)")
    if raw_turns:
        print(f"\n  raw turns inside those records: {raw_turns}")
    if failures:
        print(f"  consecutive failures per unit : {sorted(set(failures))}")
    if times:
        fmt = "%Y-%m-%d %H:%M:%S"
        print(f"  failure window                : {time.strftime(fmt, time.localtime(min(times)))}"
              f" .. {time.strftime(fmt, time.localtime(max(times)))}")

    if not args.restore:
        print(
            "\nREPORT ONLY — nothing was changed.\n"
            "These records are NOT in the database and will never be retried on\n"
            "their own. Two options, and the choice is the operator's:\n"
            "  1. Replay:  re-run with --restore, then let the provider drain.\n"
            "  2. Accept:  leave them. Say so explicitly, so the loss is a\n"
            "              decision on the record rather than an oversight."
        )
        return 0

    backup = sidecar.with_name(
        f"{sidecar.name}.backup-{time.strftime('%Y%m%dT%H%M%S')}"
    )
    shutil.copy2(sidecar, backup)
    print(f"\nbackup written: {backup}")

    lines = sidecar.read_text(encoding="utf-8").splitlines()
    restored = 0
    pending_records: list[tuple[str, dict, str | None]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        if parsed.get("schema") == QUARANTINE_ENVELOPE_SCHEMA:
            restored += 1
            continue
        pending_records.append(
            (
                str(parsed.get("operation", "unknown")),
                parsed.get("payload", {}),
                parsed.get("idempotency_key"),
            )
        )

    for operation, payload, key in pending_records:
        spool.append(operation=operation, payload=payload, key=key)

    # Sidecar emptied only AFTER the live spool holds the records. Ordered this
    # way on purpose: a crash between the two re-delivers (the spool is
    # at-least-once and consumers dedupe on idempotency_key), where the reverse
    # order would lose them outright.
    sidecar.write_text("", encoding="utf-8")

    status = spool.status()
    print(
        f"\nRESTORED {restored} unit(s) / {len(pending_records)} record(s) to the live spool.\n"
        f"  spool pending now   : {status.pending_count}\n"
        f"  quarantined now     : {status.quarantined_count}\n"
        f"  original sidecar    : {backup}\n"
        "\nThe provider drains on its next healthy operation. Verify the turns\n"
        "landed by querying ob_raw_turns for their turn_uuids; a unit that fails\n"
        "again will re-quarantine through the normal path and be reported by\n"
        "/health, which is the whole point of #680."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
