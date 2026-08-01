"""SQLAlchemy models -- schema only, no behaviour.

Same rule as ``exemplar.models``: these classes declare shape, they do not
contain logic. A model that knows how to fetch itself couples the schema to the
transport and makes both untestable without a database.

The Pydantic models in ``exemplar.models`` and the SQLAlchemy models here are
deliberately separate types. Collapsing them saves a few lines and costs the
ability to change storage without changing the API contract -- and one of them
has to carry ORM state, which is exactly what you do not want crossing a
serialization boundary.

See Also:
    - exemplar.db.engine: connection and session lifecycle
    - exemplar.models.check: the API-facing shape of the same data
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from exemplar.utils.datetime_helpers import utc_now


class Base(DeclarativeBase):
    """Declarative base for every model in this package."""


class CheckRecord(Base):
    """One recorded result of one check against one target.

    Append-only: a check that runs every minute writes a row every minute and
    never updates a previous one. History is the point -- an UPDATE would
    destroy the series that ``exemplar.apps.stats`` exists to aggregate.
    """

    __tablename__ = "check_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    target_name: Mapped[str] = mapped_column(String(128), nullable=False)

    #: NULL when the request never completed (timeout, DNS failure, refused
    #: connection). Distinguishing "no response" from "a 500" matters: they have
    #: different causes and different fixes, and folding them into one sentinel
    #: value loses that.
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: Milliseconds. Integer rather than float: sub-millisecond precision is
    #: noise over a network, and float milliseconds invite meaningless averages.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: Populated only on failure. Text, not String: an exception message or a
    #: truncated response body has no sensible length limit.
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Timezone-aware, always. The column is DateTime(timezone=True) so the
    #: database stores the offset rather than assuming one; the default comes
    #: from utc_now(), never datetime.now().
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
    )

    __table_args__ = (
        # The query this table exists to serve is "recent results for target X",
        # which is target_name plus a time range. A composite index in that
        # order serves it; two single-column indexes do not.
        Index("ix_check_records_target_time", "target_name", "recorded_at"),
    )

    def __repr__(self) -> str:
        """Return a debugging representation."""
        return (
            f"CheckRecord(id={self.id!r}, target_name={self.target_name!r}, "
            f"status_code={self.status_code!r}, recorded_at={self.recorded_at!r})"
        )
