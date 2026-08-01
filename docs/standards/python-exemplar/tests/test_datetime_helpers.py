"""Tests for exemplar.utils.datetime_helpers.

Every input and every output of every public function, per
_DOCS/STANDARDS-python.md ## Testing -- not a coverage percentage. Coverage
counts lines executed; these count behaviours asserted, which is the thing that
actually breaks.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

from exemplar.utils.datetime_helpers import ensure_aware, iso, utc_now


class TestUtcNow:
    """utc_now() -- the sanctioned replacement for datetime.now()."""

    def test_returns_aware_datetime(self) -> None:
        """The whole point: tzinfo is never None."""
        assert utc_now().tzinfo is not None

    def test_timezone_is_utc(self) -> None:
        """Aware is not enough -- it must be UTC specifically."""
        assert utc_now().utcoffset() == timedelta(0)

    def test_advances(self) -> None:
        """Two calls are ordered, so it reads a clock rather than a constant."""
        first = utc_now()
        second = utc_now()
        assert second >= first

    def test_comparable_with_other_aware_datetimes(self) -> None:
        """The failure naive datetimes cause: TypeError on comparison."""
        reference = datetime(2000, 1, 1, tzinfo=UTC)
        assert utc_now() > reference


class TestEnsureAware:
    """ensure_aware() -- naive in, aware out; aware in, unchanged."""

    def test_naive_gains_utc(self) -> None:
        """A naive input is assumed UTC, as documented."""
        result = ensure_aware(datetime(2026, 1, 1, 12, 0))
        assert result.tzinfo is not None
        assert result.utcoffset() == timedelta(0)

    def test_naive_keeps_its_wall_clock_values(self) -> None:
        """Attaching a zone must not shift the numbers."""
        result = ensure_aware(datetime(2026, 1, 1, 12, 30, 45))
        assert (result.year, result.month, result.day) == (2026, 1, 1)
        assert (result.hour, result.minute, result.second) == (12, 30, 45)

    def test_aware_utc_passes_through_unchanged(self) -> None:
        """An already-correct value is returned as-is."""
        value = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
        assert ensure_aware(value) == value

    def test_non_utc_offset_is_preserved_not_rewritten(self) -> None:
        """It guarantees awareness, it does not convert zones.

        Rewriting a +05:00 value to UTC would silently change the instant a
        caller passed in. The contract is 'guaranteed aware', nothing more.
        """
        plus_five = timezone(timedelta(hours=5))
        value = datetime(2026, 1, 1, 12, 0, tzinfo=plus_five)
        result = ensure_aware(value)
        assert result.utcoffset() == timedelta(hours=5)
        assert result == value

    def test_is_idempotent(self) -> None:
        """Applying it twice equals applying it once."""
        once = ensure_aware(datetime(2026, 6, 15, 8, 0))
        assert ensure_aware(once) == once


class TestIso:
    """iso() -- canonical serialization, always with an offset."""

    def test_aware_utc_includes_offset(self) -> None:
        """An offset-less string is the defect this prevents."""
        result = iso(datetime(2026, 1, 1, 12, 0, tzinfo=UTC))
        assert result.endswith("+00:00")

    def test_naive_input_still_gets_an_offset(self) -> None:
        """Naive input is made aware first, so output is never ambiguous."""
        result = iso(datetime(2026, 1, 1, 12, 0))
        assert result.endswith("+00:00")

    def test_non_utc_offset_appears_in_the_string(self) -> None:
        """The real offset is emitted, not a normalized one."""
        plus_five = timezone(timedelta(hours=5))
        result = iso(datetime(2026, 1, 1, 12, 0, tzinfo=plus_five))
        assert result.endswith("+05:00")

    def test_round_trips_through_fromisoformat(self) -> None:
        """Serialize then parse must yield the same instant."""
        original = datetime(2026, 3, 14, 15, 9, 26, tzinfo=UTC)
        assert datetime.fromisoformat(iso(original)) == original

    def test_utc_now_round_trips(self) -> None:
        """The two helpers compose: the common real usage."""
        stamp = utc_now()
        assert datetime.fromisoformat(iso(stamp)) == stamp
