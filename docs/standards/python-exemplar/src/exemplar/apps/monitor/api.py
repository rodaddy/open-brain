"""HTTP surface for the monitor: health, status, targets.

WHY AN APP HAS A HEALTH ENDPOINT SEPARATE FROM ITS SUBJECT
    ``/health`` reports whether THIS PROCESS is alive. ``/status`` reports what
    it observed about its targets. Conflating them is a classic operational
    mistake: an orchestrator restarting the monitor because a monitored target
    is down means one bad target takes down the thing watching it, and every
    other target goes unwatched.

    So ``/health`` returns 200 whenever the process can answer, and it says
    nothing about target health.

WHY THE ROUTES ARE THIN
    Every handler reads already-computed state and returns it. No handler
    checks a target, evaluates health, or writes a file. A route that does work
    can only be tested by driving it through HTTP, whereas the logic behind
    these routes is tested directly -- and the routes themselves need only a
    shape assertion.

Key Components:
    - build_app: construct the FastAPI app bound to a running service.

Pattern/Convention:
    The service is injected via closure rather than a module-level global, so a
    test can build an app around a fake service without patching anything.

Example:
    >>> app = build_app(service)                     # doctest: +SKIP
    >>> # GET /health  -> {"status": "ok"}
    >>> # GET /status  -> per-target health
    >>> # GET /targets -> what is configured

See Also:
    - exemplar.apps.monitor.service: owns the state these routes expose
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import FastAPI

from exemplar.models import HealthState
from exemplar.utils.datetime_helpers import iso, utc_now

if TYPE_CHECKING:
    from exemplar.apps.monitor.service import MonitorService


def build_app(service: MonitorService) -> FastAPI:
    """Build the HTTP surface around a running monitor service.

    Args:
        service: The service whose state the routes expose.

    Returns:
        A configured FastAPI application.
    """
    app = FastAPI(
        title="exemplar-monitor",
        description="URL health monitor. Worked example for STANDARDS-python.md.",
        version="0.1.0",
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        """Liveness of this process. Deliberately says nothing about targets.

        Returns 200 whenever the process can answer at all. See the module
        docstring for why this must not reflect target health.
        """
        return {"status": "ok", "checked_at": iso(utc_now())}

    @app.get("/status")
    def status() -> dict[str, Any]:
        """Health of every target, as most recently observed.

        ``healthy`` counts only targets in the HEALTHY state -- UNKNOWN is not
        counted as healthy, for the reason in ``evaluator.initial_status``.
        """
        statuses = service.statuses
        return {
            "targets": [
                {
                    "name": s.target_name,
                    "state": s.state.value,
                    "consecutive_failures": s.consecutive_failures,
                    "last_checked_at": iso(s.last_checked_at)
                    if s.last_checked_at
                    else None,
                    "last_ok_at": iso(s.last_ok_at) if s.last_ok_at else None,
                    "last_error": s.last_error,
                    "failure_rate": round(s.failure_rate, 4),
                }
                for s in statuses.values()
            ],
            "healthy": sum(
                1 for s in statuses.values() if s.state is HealthState.HEALTHY
            ),
            "unhealthy": sum(
                1 for s in statuses.values() if s.state is HealthState.UNHEALTHY
            ),
            "total": len(statuses),
        }

    return app
