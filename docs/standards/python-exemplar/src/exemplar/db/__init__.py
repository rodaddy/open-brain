"""Database layer - SQLAlchemy 2.x typed ORM over async SQLite.

WHY A DATABASE WHEN THE MONITOR ALREADY HAS A JSON STORE
    Both exist on purpose, and the exemplar keeps both because the interesting
    lesson is knowing which to reach for:

    - ``apps/monitor/store.py`` holds CURRENT state: one row per target,
      rewritten every round, read whole. A JSON file is genuinely the right tool
      -- bounded size, single writer, human-readable during an incident, no
      operational dependency.
    - This layer holds HISTORY: every observation ever made, appended forever,
      queried by time range and aggregated. A JSON file is the wrong tool the
      moment you want "p95 latency for this target over the last day", because
      answering it means loading and scanning everything.

    The rule is not "always use a database". It is: match the store to the
    access pattern. A JSON file that has to be scanned to answer a question is a
    database with none of the features.

WHY SQLALCHEMY AND NOT sqlite3 DIRECTLY
    Hand-built SQL strings are exactly the homebrewing this standard warns
    against. Concatenating a WHERE clause is how injection happens, and a schema
    change becomes a search-and-replace through string literals that no type
    checker can verify.

    SQLAlchemy 2.x's typed API means ``select(CheckRecord).where(...)`` is
    checked by mypy: a misspelled column is an error before the program runs,
    not a SQL error at 3am. And the same code runs against Postgres by changing
    one URL, which is the actual argument for the dependency.

WHY SQLITE
    The exemplar must run from a clean clone with nothing installed. SQLite is
    a file. For a real deployment the engine changes and nothing else does --
    which is the point being demonstrated.

WHY ASYNC
    The rest of the application is async. A synchronous database call inside an
    async handler blocks the entire event loop, so one slow query stalls every
    concurrent check. ``aiosqlite`` keeps the style consistent and the loop
    free. Note that SQLite itself is not meaningfully concurrent for writes --
    async here buys correctness of style and non-blocking reads, not write
    parallelism, and pretending otherwise would be the kind of claim this
    standard exists to prevent.

Key Components:
    - Base: declarative base all models inherit.
    - CheckRecord: one historical observation. Append-only.
    - Database: engine and session factory, injected like every other dependency.

Pattern/Convention:
    A ``Database`` instance is built once at startup by the entry point and
    passed down, exactly like settings. Nothing constructs its own engine, and
    nothing imports a module-level session -- a global session is shared mutable
    state across coroutines, which is the classic async-ORM defect.

    Sessions are per-unit-of-work, acquired with ``async with db.session() as s``
    and committed or rolled back by that block.

Example:
    >>> db = Database(settings.database)                    # doctest: +SKIP
    >>> await db.create_schema()
    >>> async with db.session() as session:
    ...     session.add(CheckRecord(target_name="api", status_code=200))

See Also:
    - exemplar.apps.stats: reads this history and aggregates it
    - exemplar.apps.monitor.store: the deliberate simple case, kept for contrast
"""

from __future__ import annotations

from exemplar.db.engine import Database
from exemplar.db.models import Base, CheckRecord

__all__ = ["Base", "CheckRecord", "Database"]
