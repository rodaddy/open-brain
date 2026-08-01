"""Engine and session lifecycle.

One ``Database`` instance is built at startup and passed down, exactly like
settings. Nothing here is module-level state: a global session is shared mutable
state across coroutines, which is the classic async-ORM defect -- two tasks
interleave on one connection and produce errors that are impossible to
reproduce.

See Also:
    - exemplar.db.models: the schema this connects to
    - exemplar.config: where the URL comes from
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from loguru import logger
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from exemplar.db.models import Base


class Database:
    """Owns the engine and hands out sessions.

    Args:
        url: SQLAlchemy async URL, e.g. ``sqlite+aiosqlite:///data/history.db``
            or ``postgresql+asyncpg://user@host/db``. Changing this string is
            the only change required to move stores.
        echo: Log every statement. Debugging only -- it is enormous in
            production and can print parameter values.
    """

    def __init__(self, url: str, *, echo: bool = False) -> None:
        """Create the engine and session factory."""
        self._url = url
        self._engine: AsyncEngine = create_async_engine(url, echo=echo)

        # expire_on_commit=False so attributes stay readable after the session
        # closes. The default True means touching any attribute post-commit
        # triggers a lazy refresh against a closed session -- which in async
        # code raises MissingGreenlet, an error whose message points nowhere
        # near the actual cause.
        self._session_factory: async_sessionmaker[AsyncSession] = async_sessionmaker(
            bind=self._engine,
            expire_on_commit=False,
        )

    @property
    def url(self) -> str:
        """The configured database URL."""
        return self._url

    async def create_schema(self) -> None:
        """Create any tables that do not exist yet.

        For the exemplar and for tests. A real deployment uses Alembic: this
        creates what the models currently declare and has no notion of
        migrating existing data, so on a schema change it silently does nothing
        to already-created tables.
        """
        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.debug(f"DB: schema ensured for {self._url}")

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        """Yield a session that commits on success and rolls back on error.

        The unit of work is the ``async with`` block. Committing inside it, then
        continuing to use the session, leaves half a unit of work durable if the
        second half raises.

        Yields:
            An active session.

        Example:
            >>> async with db.session() as s:            # doctest: +SKIP
            ...     s.add(CheckRecord(target_name="api", status_code=200))
        """
        session = self._session_factory()
        try:
            yield session
            await session.commit()
        except Exception:
            # Roll back and RE-RAISE. Swallowing here is the bare-except defect
            # the standard bans: the caller would see a clean return and assume
            # the write landed.
            await session.rollback()
            raise
        finally:
            await session.close()

    async def dispose(self) -> None:
        """Close every pooled connection. Call once at shutdown."""
        await self._engine.dispose()
        logger.debug("DB: engine disposed")
