"""Shared pytest fixtures.

Loguru installs a default stderr sink at import time. Under pytest that stream
is `capsys`-replaced per test and closed when the test ends, so a sink held
across tests writes to a closed file and loguru prints "Logging error in Loguru
Handler". The tests still pass, which is the problem: a logging error that
appears in every run gets read as normal and stops being informative.

Removing every sink around each test makes sink state per-test rather than
per-session.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from loguru import logger


@pytest.fixture(autouse=True)
def _isolate_loguru_sinks() -> Iterator[None]:
    """Give each test a clean, empty loguru sink set.

    Yields:
        None. Sinks are cleared before and after every test.
    """
    logger.remove()
    yield
    logger.remove()
