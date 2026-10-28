"""The provider consumes the memory package's vocabulary; it never keeps its own.

The assertion that matters is `test_provider_set_is_the_memory_set`: it fails
if either side adds or removes a value. Without it the two copies re-diverge
silently, which is precisely how `question` came to be valid in Python and
invalid in the TypeScript adapter -- a mismatch that produced exit 0, no
output, and no row rather than an error anyone could act on.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from openbrain_memory import EVENT_TYPES as MEMORY_EVENT_TYPES

from openbrain_provider import EVENT_TYPES, is_valid_event_type

PROVIDER_SRC = Path(__file__).resolve().parents[1] / "src" / "openbrain_provider"


def test_provider_set_is_the_memory_set() -> None:
    """The drift guard. Fails the moment either side changes independently."""
    assert set(EVENT_TYPES) == set(MEMORY_EVENT_TYPES), (
        "provider vocabulary diverged from openbrain_memory.EVENT_TYPES; "
        f"provider-only={sorted(set(EVENT_TYPES) - set(MEMORY_EVENT_TYPES))} "
        f"memory-only={sorted(set(MEMORY_EVENT_TYPES) - set(EVENT_TYPES))}"
    )


def test_question_is_accepted() -> None:
    """`question` is valid today and the TypeScript adapter rejected it.

    Named explicitly rather than covered only by the set comparison above: this
    is the value whose absence was the reported bug, so it gets an assertion
    that says so.
    """
    assert is_valid_event_type("question")


@pytest.mark.parametrize("event_type", sorted(MEMORY_EVENT_TYPES))
def test_every_memory_event_type_is_accepted(event_type: str) -> None:
    """Each value individually, so a failure names the value that broke."""
    assert is_valid_event_type(event_type)


def test_unknown_event_type_is_rejected() -> None:
    """`finding` is the value from the bug report: accepted by nothing, silently.

    The provider must return False rather than pass it through. Reporting the
    rejection loudly is #413; refusing it is this slice.
    """
    assert not is_valid_event_type("finding")
    assert not is_valid_event_type("")
    assert not is_valid_event_type("FACT")  # the set is lowercase, exactly


def test_provider_declares_no_vocabulary_of_its_own() -> None:
    """No literal event-type set is written anywhere in the provider package.

    The point of the slice is one definition. A helpful-looking local copy
    added later would satisfy every other test in this file while reintroducing
    exactly the duplication that caused the bug, so the absence of a second
    literal is asserted directly rather than assumed.
    """
    offenders: list[str] = []
    for path in PROVIDER_SRC.rglob("*.py"):
        text = path.read_text()
        # `vocabulary.py` names one value in prose; a redeclaration would need
        # several literals together, so require two distinct ones to flag.
        hits = sum(
            1 for value in ("fact", "blocker", "handoff") if f'"{value}"' in text
        )
        if hits >= 2:
            offenders.append(str(path.relative_to(PROVIDER_SRC)))
    assert not offenders, (
        f"event-type literals found in provider source: {offenders}. "
        "Import openbrain_memory.EVENT_TYPES instead of restating it."
    )
