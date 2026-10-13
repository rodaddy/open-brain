"""The live-test ``Secret`` wrapper never prints its value (#1485)."""

from __future__ import annotations

from conftest import Secret

VALUE = "postgres://u:p@h/db"


def test_repr_and_str_hide_every_part_of_the_value() -> None:
    wrapped = Secret(VALUE)
    for shown in (repr(wrapped), str(wrapped), f"{wrapped}", repr({"k": wrapped})):
        assert "***" in shown
        for part in ("postgres", "u:p", "@h", "/db"):
            assert part not in shown


def test_get_returns_the_value() -> None:
    assert Secret(VALUE).get() == VALUE
