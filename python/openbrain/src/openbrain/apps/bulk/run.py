"""The console-script entrypoint: build the real client and drive a bulk ingest.

Purpose:
    An operator runs this over a giant session file. It parses the arguments,
    resolves the endpoint and token, builds the real ``openbrain_memory``
    client, stages the file, and yields every turn to the raw lane -- then
    reports what landed, what resumed, and what was quarantined.

Architecture:
    A parse-and-drive shell, the bulk mirror of ``hooks.stop``. The business is
    in the capabilities: ``ingest.stage_file`` rejiggers the file into the
    staging store, ``ingest.ingest`` yields each turn to the lane. This module
    only builds the client and orders those two calls.

    The client is built HERE, the same place ``session._started_memory`` builds
    the live one -- but WITHOUT the live path's 5-second deadline pins. The bulk
    app has no deadline (`_plans/python-port-sequence.md` §TWO APPLICATIONS), so
    it does not cap the per-request timeout to fit one, and it does not pin retry
    to a single attempt: an operator run MAY retry, which is the sibling client's
    default. Writes still route through ``AgentMemory.ingest_raw_turns`` alone --
    no second DB or HTTP path.

Pattern/Convention:
    LOUD, NOT SWALLOWED. This is the inverse of the live entrypoint's exit-0
    contract. A missing endpoint, an unbuilt format, an unreadable file, a
    quarantined turn -- each is reported to the operator and the process exits
    NON-ZERO when the run did not fully land, because a person is watching and
    can act. Silence is the one thing a bulk run must never do.

    The reporting is content-free: it prints counts and an error CLASS name,
    never a turn's text or a token, so a redirected log carries no secret.

See Also:
    - `openbrain.apps.bulk.ingest` - the stage/yield capabilities this drives
    - `openbrain.apps.hooks.stop` - the live entrypoint whose shape this mirrors
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.bulk.formats import InputFormat
from openbrain.apps.bulk.ingest import ingest, stage_file
from openbrain.apps.bulk.staging import StagingStore
from openbrain.apps.hooks.session import CaptureNotConfiguredError
from openbrain.config import load_capture_settings

if TYPE_CHECKING:
    from collections.abc import Sequence

    from openbrain.apps.bulk.ingest import BulkLane
    from openbrain.config import CaptureSettings

#: The default staging database, beside the file being ingested. Deriving it
#: from the input path makes a re-run over the same file RESUMABLE by default --
#: point the command at the file again and it continues from the unsent rows --
#: while ``--staging-path`` lets an operator place it elsewhere.
STAGING_SUFFIX = ".bulk-stage.sqlite"


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the bulk-ingest command line.

    Args:
        argv: The arguments, or ``None`` to read ``sys.argv``.

    Returns:
        The parsed namespace: the input ``file``, its ``format``, and an optional
        ``staging_path`` override.
    """
    parser = argparse.ArgumentParser(
        prog="openbrain-bulk-ingest",
        description=(
            "Ingest a whole giant session file into Open Brain's raw lane. "
            "Operator-run: it stages the file into SQLite, yields every turn to "
            "the server, resumes an interrupted run, and quarantines a rejected "
            "turn rather than dropping it."
        ),
    )
    parser.add_argument(
        "file", type=Path, help="the session file to ingest, read whole"
    )
    parser.add_argument(
        "--format",
        type=InputFormat,
        choices=tuple(InputFormat),
        default=InputFormat.CLAUDE,
        help="the input format to key on (default: claude)",
    )
    parser.add_argument(
        "--staging-path",
        type=Path,
        default=None,
        help=(
            "where to stage parsed turns; defaults to the input file plus "
            f"{STAGING_SUFFIX}, so a re-run resumes"
        ),
    )
    return parser.parse_args(argv)


def _lane(settings: CaptureSettings, session_key: str) -> BulkLane:
    """Build the real ``openbrain_memory`` client for a bulk run, session started.

    NO deadline pins: bulk has no 5-second budget, so the per-request timeout is
    the sibling's default and retry is the sibling's default -- an operator run
    may retry. Writes go through ``AgentMemory.ingest_raw_turns`` only.

    Raises:
        CaptureNotConfiguredError: When no endpoint or token is set -- raised
            LOUDLY here, not swallowed, because an operator must know the run
            reached nothing.
    """
    if settings.base_url is None or settings.token is None:
        missing = ", ".join(
            name
            for name, value in (
                ("base_url", settings.base_url),
                ("token", settings.token),
            )
            if value is None
        )
        raise CaptureNotConfiguredError(missing)

    from openbrain_memory.agent import AgentMemory
    from openbrain_memory.client import OpenBrainClient

    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        namespace=settings.agent_id,
        agent_id=settings.agent_id,
        # The LAN opt-in (#525), same environment the hook lanes read.
        allow_insecure_http=settings.allow_insecure_http,
    )
    memory = AgentMemory(client, agent=settings.agent_id)
    memory.start_session(session_key)
    return memory


def _staging_path(args: argparse.Namespace) -> Path:
    """Resolve where parsed turns are staged, defaulting beside the input file."""
    override: Path | None = args.staging_path
    if override is not None:
        return override
    source: Path = args.file
    return source.with_name(source.name + STAGING_SUFFIX)


def run(argv: Sequence[str] | None = None) -> int:
    """Stage the named file and yield every turn to the raw lane. Loudly.

    Args:
        argv: The command line, or ``None`` to read ``sys.argv``. Injectable so a
            test drives the whole entrypoint without a subprocess.

    Returns:
        ``0`` when every staged turn landed and nothing is quarantined; ``1``
        when the run quarantined a turn, so a watching operator sees a non-zero
        exit rather than a clean one over a partial ingest.
    """
    args = _parse_args(argv)
    settings = load_capture_settings()
    store = StagingStore(_staging_path(args))

    staged = stage_file(args.file, args.format, store)
    logger.info(
        "bulk staged {} turns from {} as {}",
        staged.staged,
        args.file.name,
        staged.input_format.value,
    )

    session_key = f"bulk:{args.file.name}"
    result = ingest(store, _lane(settings, session_key))
    logger.info(
        "bulk ingest sent {} turns, quarantined {}",
        result.sent,
        result.quarantined,
    )

    if result.quarantined:
        logger.warning(
            "bulk ingest quarantined {} turns -- inspect the staging store at {}",
            result.quarantined,
            _staging_path(args),
        )
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Console-script entry: run a bulk ingest and return its exit code."""
    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
