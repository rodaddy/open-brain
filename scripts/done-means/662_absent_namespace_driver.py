"""Driver for the #662 done-means check. Run it via the shell wrapper.

Drives the SHIPPED validator in-process against constructed session_start
results. The lane object is the untrusted input under test, so constructing it
by hand IS the realistic shape: the validator's job is to be correct about
whatever a server sends, and #662 is a lane shape a server sent.

The import is DYNAMIC (importlib) rather than a module-level `from ... import`.
A static import of a symbol that does not exist at the pre-fix tree kills the
driver at module resolution before a single clause prints — a false RED
indistinguishable at the shell from a real one (Tightenings round 18). Nothing
imported here is new, but the pattern is the default path, not an edge case.
"""

from __future__ import annotations

import importlib
import sys
from dataclasses import dataclass
from typing import Any


@dataclass
class Scope:
    """The exact-scope coordinates a lane must prove."""

    session_key: str = "repo/session-4"
    agent: str = "bilby"
    platform: str = "discord"
    server_id: str = "guild-1"
    channel_id: str = "channel-2"
    thread_id: str | None = "thread-3"


CONFIGURED_NAMESPACE = "bilby"
DEAD_END = "did not prove exact Open Brain scope: namespace"


def correct_lane() -> dict[str, Any]:
    """A lane that proves every coordinate, including the namespace."""
    scope = Scope()
    return {
        "namespace": CONFIGURED_NAMESPACE,
        "session_key": scope.session_key,
        "agent": scope.agent,
        "source": scope.platform,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
        "metadata": {"server_id": scope.server_id},
    }


def validate(lane: dict[str, Any]) -> str | None:
    """Return the refusal text, or None when the lane validated clean."""
    module = importlib.import_module("openbrain_memory._runtime_validation")
    validate_started_lane = module.validate_started_lane
    try:
        validate_started_lane({"lane": lane}, CONFIGURED_NAMESPACE, Scope())
    except ValueError as error:
        return str(error)
    return None


FAILURES = 0


def report(clause: str, ok: bool, detail: str) -> None:
    global FAILURES
    if ok:
        print(f"{clause:<40}: PASS - {detail}")
    else:
        print(f"{clause:<40}: FAIL - {detail}")
        FAILURES += 1


def main() -> int:
    # -- (a) RED ANCHOR: the absent case must not produce the dead-end error.
    absent = correct_lane()
    del absent["namespace"]
    absent_error = validate(absent)
    if absent_error is None:
        report(
            "(a) absent namespace not dead-ended",
            False,
            "the absent lane VALIDATED CLEAN - a lane that never proved its "
            "namespace was accepted, which is the silent mis-scope #654 exists "
            "to prevent",
        )
    elif DEAD_END in absent_error:
        report(
            "(a) absent namespace not dead-ended",
            False,
            f"RED ANCHOR PRESENT - generic dead-end error returned: [{absent_error}]",
        )
    else:
        report(
            "(a) absent namespace not dead-ended",
            True,
            "the generic scope-proof dead end is gone",
        )

    # -- (b) The absent refusal must be actionable.
    #
    # Actionable here means: it says the response OMITTED the key (so the
    # reader knows this is a server-shape problem, not something to retype),
    # and it names the configured namespace so the reader can see what was
    # asked for. Asserting on text is the point - a refusal that refuses for
    # an unsayable reason IS the defect (#646/#654 dead-end class).
    text = absent_error or ""
    lowered = text.lower()
    says_omitted = any(
        word in lowered for word in ("did not return", "omitted", "no namespace")
    )
    names_configured = CONFIGURED_NAMESPACE in text
    report(
        "(b) absent refusal is actionable",
        says_omitted and names_configured and DEAD_END not in text,
        (
            f"says-omitted={says_omitted} names-configured={names_configured} "
            f"error=[{text or '<none>'}]"
        ),
    )

    # -- (c) The absent case must STAY a refusal.
    #
    # Separate from (b) on purpose. (b) could be satisfied by a warning that
    # then returned normally; this clause is the one that says the write does
    # not happen. Splitting them is the round-17 lesson: a claim with two
    # halves asserted in one clause passes for the wrong reason.
    report(
        "(c) absent namespace still refused",
        absent_error is not None,
        (
            "refused"
            if absent_error is not None
            else "ACCEPTED - the check was satisfied by removing the guard"
        ),
    )

    # -- (d) CONTROL: #657's mismatch branch is untouched. Passes pre- and post-fix.
    mismatch = correct_lane()
    mismatch["namespace"] = "token-namespace"
    mismatch_error = validate(mismatch) or ""
    mismatch_ok = (
        "token-namespace" in mismatch_error
        and CONFIGURED_NAMESPACE in mismatch_error
        and "OPENBRAIN_DELEGATE_NAMESPACE" in mismatch_error
    )
    report(
        "(d) control, #657 mismatch intact",
        mismatch_ok,
        f"error=[{mismatch_error or '<none>'}]",
    )

    # -- (e) CONTROL: #529's request-key shapes are unchanged.
    #
    # `agent` IS a request key, so naming it is already actionable. This clause
    # pins that the namespace work did not reroute request-key mismatches into
    # a namespace-flavoured message, and that they are still reported by their
    # own names.
    wrong_agent = correct_lane()
    wrong_agent["agent"] = "someone-else"
    agent_error = validate(wrong_agent) or ""
    agent_ok = (
        "did not prove exact Open Brain scope" in agent_error
        and "agent" in agent_error
        and "namespace" not in agent_error
    )
    report(
        "(e) control, #529 request keys intact",
        agent_ok,
        f"error=[{agent_error or '<none>'}]",
    )

    # -- (f) CONTROL: the healthy path still validates clean.
    healthy_error = validate(correct_lane())
    report(
        "(f) control, correct lane validates",
        healthy_error is None,
        (
            "clean"
            if healthy_error is None
            else f"a fully-correct lane was REFUSED: [{healthy_error}]"
        ),
    )

    print()
    if FAILURES == 0:
        print(
            "=== DONE-MEANS 662: PASS - an absent namespace key is refused with an "
            "error naming what the caller can check, the #657 mismatch remedy is "
            "intact, and #529's request-key shapes are unchanged. ==="
        )
        return 0
    print(f"=== DONE-MEANS 662: FAIL ({FAILURES} failing clause(s)) ===")
    return 1


if __name__ == "__main__":
    sys.exit(main())
