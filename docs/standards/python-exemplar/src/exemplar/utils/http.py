"""Async HTTP with bounded retry and exponential backoff. Shared by monitor and hook.

WHY THIS IS IN utils/ AND NOT IN EITHER APP
    Two apps make outbound HTTP calls: monitor checks targets, hook forwards
    events downstream. Both need timeouts, both need bounded retry, both need
    the attempt logged. Written twice, the two implementations drift -- one gets
    a jitter fix the other does not, one logs the attempt number and the other
    does not, and the difference is invisible until an incident.

    This is the concrete case the shared-floor rule exists for. It is also why
    the exemplar has four apps: with one caller, "put it in utils" is a
    stylistic assertion; with several callers doing genuinely different work, it
    is demonstrable.

WHY tenacity, AND WHY THIS FILE IS THE LESSON
    This module first shipped with a hand-written retry loop: an attempt
    counter, exponential backoff arithmetic, a jitter algorithm, an injected
    random seam so the jitter could be tested, and a paragraph of comments
    explaining why the maths was correct. It worked. It was still wrong to
    write, and it is worth naming exactly why, because "I tested it and it
    passes" is the argument that keeps that kind of code alive everywhere.

    Retry-with-backoff is a solved problem with a mature, maintained library.
    Writing it by hand means re-deciding, from scratch, things tenacity settled
    years ago:

      - whether the delay before attempt N uses N or N-1 (an off-by-one that
        only shows up under sustained failure, i.e. during an incident)
      - whether jitter is additive or subtractive (they differ in whether the
        configured maximum is a real bound -- see ``jitter_seconds``)
      - how the sleep interacts with cancellation during shutdown
      - what to raise when attempts are exhausted, without losing the cause

    Each is a bug that appears only in production, only under failure, and only
    when the retry path is finally exercised. And the hand-written version had
    to grow a ``random_units`` parameter purely so its own jitter could be
    tested -- production API surface existing only to serve a test, which is a
    reliable signal that the mechanism should not have been local code at all.

    STANDARDS-python.md states the order: an existing repo helper, then a
    well-known maintained library, then the standard library, then custom code.
    Custom code is the last resort, not the default, and "but I documented why
    mine is correct" does not promote it.

    What stays hand-written here is the part that is genuinely ours: WHICH
    failures deserve a retry. That is domain knowledge about this system, not
    mechanism, and no library can supply it.

WHAT IS RETRIED, AND WHAT IS NOT
    Retrying the wrong thing is worse than not retrying. Two classes:

    - **Transport failures** (connection refused, DNS failure, timeout, reset):
      retried. The request may never have reached the server, so repeating it is
      safe and often succeeds.
    - **HTTP responses** (any status code): NOT retried here. A 500 is a real
      answer from a reachable service, and whether it should be retried is a
      caller's decision -- the monitor wants to record it as a failed check, not
      hammer a struggling service. 4xx must never be retried; the request is
      wrong and repeating it will stay wrong.

    A retry loop that treats "server said no" the same as "server never heard
    us" turns a partial outage into a self-inflicted denial of service.

WHY JITTER
    Plain exponential backoff synchronises every client. Ten monitors that all
    fail at once all retry at exactly 2s, then 4s, then 8s -- so the service
    trying to recover is hit by ten simultaneous bursts. Jitter spreads them.
    ``wait_exponential_jitter`` supplies both halves as one wait strategy, which
    is the whole argument for using the library.

Key Components:
    - RetryPolicy: attempts and delays, validated. Translates to tenacity.
    - request_with_retry: the single sanctioned outbound call.
    - TransportError: transport-level failure after all attempts.

Pattern/Convention:
    Callers own the httpx.AsyncClient and pass it in, rather than this module
    creating one per call. Creating a client per request throws away connection
    pooling and, at any volume, exhausts local ports.

Example:
    >>> import httpx
    >>> from exemplar.utils.http import RetryPolicy, request_with_retry
    >>> async def check(client: httpx.AsyncClient) -> int:      # doctest: +SKIP
    ...     resp = await request_with_retry(
    ...         client, "GET", "https://example.test/health",
    ...         policy=RetryPolicy(max_attempts=3), label="CHECK",
    ...     )
    ...     return resp.status_code

See Also:
    - _DOCS/STANDARDS-python.md ## Error handling (pattern 2: retry with backoff)
    - _DOCS/STANDARDS-python.md ## Dependencies (do not hand-roll a solved problem)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import httpx
from loguru import logger
from pydantic import BaseModel, Field
from tenacity import (
    AsyncRetrying,
    RetryError,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from tenacity import RetryCallState

#: Transport-level exceptions worth retrying: the request may not have arrived.
#: Explicitly NOT httpx.HTTPStatusError -- that is a real response, and the
#: caller decides what it means.
#:
#: This tuple is the part of retrying that is genuinely ours. tenacity supplies
#: the loop, the backoff, and the jitter; only this list encodes what our system
#: considers worth repeating.
RETRYABLE_EXCEPTIONS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.PoolTimeout,
    httpx.RemoteProtocolError,
)


class TransportError(Exception):
    """Every attempt failed at the transport level.

    A dedicated type rather than leaking ``tenacity.RetryError`` or the raw
    httpx error, so a caller can distinguish "we never got an answer" from "we
    got an answer we did not like" with an ``except`` clause instead of by
    inspecting a message.

    Keeping tenacity's type out of the signature also means the retry library
    stays an implementation detail: swapping it would not break callers.

    The final underlying exception is kept as ``__cause__`` via ``raise ... from``
    so no diagnostic detail is lost.
    """

    def __init__(self, url: str, attempts: int, last_error: BaseException) -> None:
        """Record what was tried and what finally failed."""
        self.url = url
        self.attempts = attempts
        self.last_error = last_error
        super().__init__(
            f"{url} unreachable after {attempts} attempt(s): "
            f"{type(last_error).__name__}: {last_error}"
        )


class RetryPolicy(BaseModel):
    """How many times to retry, and how long to wait between attempts.

    A model rather than loose arguments so the values are validated once, at
    construction, instead of producing an infinite loop when someone passes a
    negative attempt count.

    Deliberately thin: it validates, and it translates into tenacity's
    primitives. It owns no retry logic of its own, which is the point -- the
    earlier version of this class computed its own delays, and that is what this
    file now exists to argue against.
    """

    #: Total attempts, not retries-after-the-first. 1 means "try once, no
    #: retry" -- naming it max_attempts avoids the perennial off-by-one where
    #: max_retries=3 silently means four requests. Maps to
    #: ``stop_after_attempt``, which counts the same way.
    max_attempts: int = Field(default=3, ge=1, le=10)

    #: The first wait, doubling thereafter. Maps to ``wait_exponential_jitter``'s
    #: ``initial``.
    initial_delay_seconds: float = Field(default=1.0, gt=0, le=60)

    #: Ceiling on the exponential term. Without it, attempt 8 of an exponential
    #: sequence waits over two minutes and the caller looks hung.
    max_delay_seconds: float = Field(default=30.0, gt=0, le=300)

    #: Maximum random seconds added to each delay, spreading a fleet's retries
    #: so a recovering service is not hit by synchronised bursts.
    #:
    #: SECONDS, not the ratio the hand-written version used, and ADDITIVE rather
    #: than subtractive. tenacity adds jitter on top of the capped exponential
    #: term, so a wait can exceed ``max_delay_seconds`` by up to this much. That
    #: is a real behavioural difference from the code this replaced, which
    #: subtracted and treated the cap as absolute.
    #:
    #: It is recorded here rather than smoothed over because the alternative --
    #: reimplementing subtractive jitter to preserve the old semantics -- would
    #: mean hand-rolling the exact thing this change exists to remove, to defend
    #: a bound nothing actually depends on. Naming the unit in the field is what
    #: keeps the overshoot visible at the call site.
    jitter_seconds: float = Field(default=1.0, ge=0.0, le=30)


def _log_before_sleep(
    label: str, method: str, url: str
) -> Callable[[RetryCallState], None]:
    """Build tenacity's before-sleep callback, bound to this call's log context.

    Every retry is logged at WARNING with the attempt number, the wait, and the
    failure that caused it. A silent retry hides a flapping target: the request
    eventually succeeds so nothing looks wrong, while the service is in fact
    failing most of the time.

    A factory rather than a plain function because tenacity's callback signature
    takes only the retry state, so the label, method, and URL must be closed
    over.

    Args:
        label: Log prefix identifying the calling component, e.g. ``CHECK``.
        method: The HTTP method, for the log line.
        url: The URL being retried, for the log line.

    Returns:
        A callback tenacity invokes before each sleep.
    """

    def log_retry(state: RetryCallState) -> None:
        """Emit one WARNING per retry."""
        exc = state.outcome.exception() if state.outcome else None
        delay = state.next_action.sleep if state.next_action else 0.0
        # attempt_number is the attempt that just FAILED, so the one about to be
        # made is one higher. Reporting the upcoming attempt matches what the
        # reader of the log is waiting for.
        logger.warning(
            f"{label}: retrying {method} {url} "
            f"attempt={state.attempt_number + 1} after {delay:.2f}s "
            f"(previous: {type(exc).__name__ if exc else 'unknown'})"
        )

    return log_retry


async def request_with_retry(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    policy: RetryPolicy | None = None,
    label: str = "HTTP",
    # Named `request_timeout`, not `timeout`, and the rename is not cosmetic.
    # ruff's ASYNC109 flags a bare `timeout` on an async function because a
    # caller reasonably reads it as a deadline for the whole call -- and here
    # that reading would be WRONG by a large factor. This bounds ONE request;
    # the function may make `policy.max_attempts` of them with backoff between,
    # so total wall time is several times this value. An ambiguous name would
    # have callers setting 10 and waiting 40.
    #
    # A true overall deadline is the caller's job, with `asyncio.timeout()`
    # around this call. That is deliberately not done here: cancelling mid-retry
    # is a policy decision, and swallowing it inside a utility hides it.
    request_timeout: float | None = None,
    **kwargs: Any,  # ruff: ignore[any-type]
) -> httpx.Response:
    """Make an HTTP request, retrying transport failures with backoff.

    Returns the response for ANY status code. Status handling is the caller's
    decision -- see the module docstring for why a 500 is not retried here.

    Args:
        client: Caller-owned client, so connections are pooled.
        method: HTTP method.
        url: Absolute URL.
        policy: Retry configuration. Defaults to ``RetryPolicy()``.
        label: Log prefix identifying the calling component, e.g. ``CHECK``.
        request_timeout: Timeout for ONE request, not for the whole call.
            Total wall time is up to max_attempts times this, plus backoff.
        **kwargs: Forwarded to httpx (``json=``, ``headers=``, ...). Typed Any
            because httpx's own signature is, and narrowing it here would mean
            re-declaring that interface and breaking whenever it changes.

    Returns:
        The HTTP response, whatever its status.

    Raises:
        TransportError: Every attempt failed at the transport level.

    Example:
        >>> resp = await request_with_retry(client, "GET", url)   # doctest: +SKIP
        >>> resp.status_code
        200
    """
    active = policy or RetryPolicy()

    try:
        # AsyncRetrying as an explicit async-for loop rather than the @retry
        # decorator: the decorator would need a closure to capture these
        # arguments, and the loop keeps the control flow readable in place.
        #
        # Everything the hand-written version computed is now three declarative
        # arguments, and that is the diff worth studying:
        #
        #   stop  -- when to give up          (was: a range() and a counter)
        #   wait  -- grow, jitter, cap        (was: delay_for + injected random)
        #   retry -- what is worth repeating  (ours: RETRYABLE_EXCEPTIONS)
        #
        # Only the third is domain knowledge. The first two were mechanism this
        # repo had no business owning.
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(active.max_attempts),
            wait=wait_exponential_jitter(
                initial=active.initial_delay_seconds,
                max=active.max_delay_seconds,
                jitter=active.jitter_seconds,
            ),
            retry=retry_if_exception_type(RETRYABLE_EXCEPTIONS),
            before_sleep=_log_before_sleep(label, method, url),
            # reraise=False so exhaustion surfaces as RetryError, which is
            # translated to TransportError below. Callers should not have to
            # know tenacity is involved in order to catch a failure.
            reraise=False,
        ):
            with attempt:
                number = attempt.retry_state.attempt_number
                logger.debug(f"{label}: {method} {url} attempt={number}")
                response = await client.request(
                    method, url, timeout=request_timeout, **kwargs
                )
                logger.debug(
                    f"{label}: {method} {url} -> {response.status_code} "
                    f"attempt={number}"
                )
                return response
    except RetryError as exc:
        # Every attempt failed at the transport level. Translate tenacity's
        # wrapper into our own type, keeping the underlying error as the cause
        # so nothing diagnostic is lost.
        last_error: BaseException = exc.last_attempt.exception() or exc
        logger.error(
            f"{label}: {method} {url} unreachable after "
            f"{active.max_attempts} attempt(s): "
            f"{type(last_error).__name__}: {last_error}"
        )
        raise TransportError(url, active.max_attempts, last_error) from last_error

    # Unreachable: the loop either returns a response or raises RetryError.
    # mypy cannot prove that, and an honest raise is better than a `# type:
    # ignore` asserting something the checker cannot see.
    msg = f"{label}: retry loop for {url} ended without a result"
    raise RuntimeError(msg)
