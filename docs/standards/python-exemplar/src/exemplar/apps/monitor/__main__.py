"""Entry point for the monitor app. Parses arguments, builds objects, runs.

WHY THIS FILE CONTAINS NO LOGIC
    It parses a command line, loads settings, constructs three objects, wires
    signals, and starts a loop. Every decision the application makes lives
    somewhere else.

    That is what makes the rest testable. A test can construct ``MonitorService``
    directly with a fake store and a mock transport; it never has to fabricate a
    command line, install a signal handler, or start a process. Logic that
    creeps into ``__main__`` can only be tested by running the program.

THE SHUTDOWN CONTRACT
    SIGINT and SIGTERM cancel the scheduler task, the task re-raises
    ``CancelledError``, and the process exits after the in-flight round is
    abandoned. State from the last COMPLETED round is already on disk, because
    the service saves after every round rather than at exit -- so a SIGKILL, an
    OOM kill, or a node failure loses at most one round.

    Handlers are installed with ``loop.add_signal_handler`` rather than
    ``signal.signal``. The latter runs the handler on an arbitrary stack frame
    between bytecodes, which is not safe for touching asyncio state; the former
    schedules it on the event loop, where cancelling a task is legal.

Example:
    uv run python -m exemplar.apps.monitor --env test
    uv run python -m exemplar.apps.monitor --env test --once

See Also:
    - exemplar.apps.monitor.service: the loop this starts
    - exemplar.config.load_settings: the one place configuration is read
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal
import sys

import httpx
import uvicorn
from loguru import logger

from exemplar.apps.monitor.api import build_app
from exemplar.apps.monitor.service import MonitorService
from exemplar.apps.monitor.store import StatusStore
from exemplar.config import Environment, load_settings

#: Connection pool ceiling. Slightly above the service's concurrency limit so
#: the pool is never the bottleneck, but bounded so a large target list cannot
#: open unlimited sockets.
MAX_CONNECTIONS = 20


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments.

    Args:
        argv: Argument list. None means ``sys.argv[1:]``; passing an explicit
            list is what lets this be tested without touching global state.

    Returns:
        Parsed arguments.
    """
    parser = argparse.ArgumentParser(
        prog="exemplar-monitor",
        description="Poll URLs, track their health, expose it over HTTP.",
    )
    parser.add_argument(
        "--env",
        choices=("test", "dev", "prod"),
        default="test",
        help="Which configuration layer to load (default: test).",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single round and exit. Useful for cron and for smoke tests.",
    )
    parser.add_argument(
        "--no-server",
        action="store_true",
        help="Skip the HTTP surface and only run the check loop.",
    )
    return parser.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    """Build everything and run until shutdown.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Process exit code. 0 for a clean run or a clean shutdown.
    """
    # The ONE place settings are loaded. This also configures logging, so every
    # log line after this point goes to the configured sinks.
    settings = load_settings(env=cast_env(args.env))

    logger.info(
        f"START: exemplar-monitor env={settings.env} "
        f"targets={len(settings.monitor.targets)} "
        f"interval={settings.monitor.interval_seconds}s"
    )

    store = StatusStore(settings.monitor.state_file)

    # The client is created HERE, at the top, so its lifetime is visible at the
    # place the app starts and stops. A client created inside the service would
    # be closed by whichever code path happened to remember to.
    limits = httpx.Limits(max_connections=MAX_CONNECTIONS)
    async with httpx.AsyncClient(limits=limits, follow_redirects=True) as client:
        service = MonitorService(settings.monitor, store, client)

        if args.once:
            await service.run_once()
            logger.info("START: --once complete, exiting")
            return 0

        tasks = [asyncio.create_task(service.run_forever(), name="scheduler")]

        if not args.no_server:
            app = build_app(service)
            config = uvicorn.Config(
                app,
                host="127.0.0.1",
                port=settings.ports.monitor,
                log_config=None,  # loguru owns logging; do not let uvicorn reconfigure it
                access_log=False,
            )
            tasks.append(
                asyncio.create_task(uvicorn.Server(config).serve(), name="http")
            )
            logger.info(f"START: http surface on 127.0.0.1:{settings.ports.monitor}")

        await _run_until_signalled(tasks)

    logger.info("START: shutdown complete")
    return 0


async def _run_until_signalled(tasks: list[asyncio.Task[None]]) -> None:
    """Run tasks until SIGINT/SIGTERM, then cancel them and wait.

    Args:
        tasks: Long-running tasks to supervise.
    """
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()

    def request_stop(signal_name: str) -> None:
        """Record that shutdown was requested. Runs on the event loop."""
        logger.info(f"SIGNAL: {signal_name} received, shutting down")
        stopping.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        # add_signal_handler, not signal.signal -- see the module docstring.
        loop.add_signal_handler(sig, request_stop, sig.name)

    await stopping.wait()

    for task in tasks:
        task.cancel()

    # Wait for cancellation to actually finish. Without this the process can
    # exit while a task is mid-write, which is how a state file gets truncated
    # despite every atomic-write precaution in the store.
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError):
            await task


def cast_env(value: str) -> Environment:
    """Narrow a parsed string to the Environment literal type.

    argparse returns ``str``; ``choices`` guarantees the value is one of the
    three, but the type system cannot see that. This is the boundary where an
    untyped input becomes a typed one, made explicit rather than hidden behind
    a cast.

    Args:
        value: One of "test", "dev", "prod".

    Returns:
        The same value, typed.

    Raises:
        ValueError: The value was not a known environment.
    """
    if value in ("test", "dev", "prod"):
        # A returned literal, not typing.cast: cast() asserts without checking,
        # so it would silently launder a bad value. This checks.
        return value  # type: ignore[return-value]  # narrowed by the check above
    msg = f"unknown environment {value!r}, expected test, dev, or prod"
    raise ValueError(msg)


def main() -> int:
    """Console-script entry point.

    Returns:
        Process exit code.
    """
    args = parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        # Ctrl-C before the signal handlers are installed, i.e. during startup.
        # Not an error; exit quietly rather than dumping a traceback.
        logger.info("START: interrupted during startup")
        return 130  # conventional exit code for SIGINT


if __name__ == "__main__":
    sys.exit(main())
