"""Where the bridge's tools are offered and where they run: Herald OS's own sessions.

Hermes turns a plugin toolset on for every platform that has not saved a list without it, and the
Herald OS backend shares the ``cli`` platform's list with the ``hermes`` CLI, so configuration cannot
keep these tools out of a person's Telegram, Discord, cron or terminal sessions. The bridge asks the
session instead: Hermes binds each turn's source for the tools it runs (``HERMES_SESSION_SOURCE``),
and Herald OS creates its sessions with ``source: "herald_os"`` (ADR-003).
"""

from __future__ import annotations

import functools
import os
from typing import Any, Callable

from . import audit
from .util import fail

# Sessions saved before the rename keep their old source (ADR-016).
HERALD_SOURCES = frozenset({"herald_os", "hermes_os"})


def _session_env(name: str) -> str:
    """A session variable as Hermes binds it for the current task, else the process environment (a
    process that a session started inherits that session's variables)."""
    try:
        from gateway.session_context import get_session_env
    except ImportError:  # Outside a Hermes runtime.
        return os.environ.get(name, "")
    return str(get_session_env(name, "") or "")


def session_source() -> str:
    return _session_env("HERMES_SESSION_SOURCE").strip().lower()


def _hermes_binds_sessions() -> bool:
    """Whether Hermes binds sessions in this process, as the gateway Herald OS talks to, a messaging
    gateway and cron do for every turn. The ``hermes`` CLI never does: its HERMES_SESSION_* come from
    its environment, which holds whatever its parent had, since Hermes passes a turn's variables on to
    every command the turn runs. A Hermes without this latch counts as binding."""
    try:
        from gateway.session_context import session_context_engaged
    except ImportError:
        return True
    return bool(session_context_engaged())


def in_herald_session() -> bool:
    """A Herald OS turn: Hermes bound the source for it, or the process descends from the backend
    Herald OS started (HERALD_OS=1), as a command run by a Herald OS turn does. A source in the
    environment of anything else, such as ``hermes chat --source herald_os``, does not count."""
    return session_source() in HERALD_SOURCES and (_hermes_binds_sessions() or herald_backend())


def herald_backend() -> bool:
    """This process is the ``hermes serve`` Herald OS started, or a process it started."""
    return os.environ.get("HERALD_OS") == "1"


def other_surface() -> str | None:
    """What the current turn belongs to when that is plainly not Herald OS, else ``None``."""
    if _session_env("HERMES_CRON_SESSION") == "1":
        return "a scheduled job"
    if os.environ.get("HERMES_KANBAN_TASK"):
        return "a kanban worker"
    platform = _session_env("HERMES_SESSION_PLATFORM").strip()
    if platform:
        return platform
    source = session_source()
    return source if source and source not in HERALD_SOURCES else None


def offered() -> bool:
    """Whether the model is shown the tools here. Calls are checked again in ``herald_only``."""
    if in_herald_session():
        return True
    # The backend also builds and refreshes agents outside a turn: an eager resume binds the source
    # Hermes derives from HERMES_DESKTOP=1 (``desktop``) and a late MCP refresh binds none. Only a
    # turn of another surface (a messaging platform, the API server, cron) is left out there.
    return herald_backend() and other_surface() in (None, "desktop")


def herald_only(tool: str, handler: Callable[..., str], enabled: Callable[[], bool]) -> Callable[..., str]:
    """``handler``, refusing every call outside a Herald OS session and while the bridge is off.

    Hermes uses a tool's ``check_fn`` only to decide what the model sees, never to gate a call, so
    this check is the one that holds."""

    @functools.wraps(handler)
    def gated(args: dict[str, Any], **kwargs: Any) -> str:
        if not enabled():
            decision, message = "disabled", "The Herald OS system bridge is switched off (herald_os.bridge.enabled: false, or HERALD_OS_BRIDGE_DISABLED=1)."
        elif not in_herald_session():
            where = other_surface() or "a session Herald OS did not start"
            decision, message = "outside_herald", f"{tool} is a Herald OS system tool and runs only in sessions Herald OS starts; this call came from {where}."
            if herald_backend() and not session_source():
                message += " If it came from Herald OS, update Hermes (hermes update): this version does not tell tools which session they run in."
        else:
            return handler(args, **kwargs)
        audit.record(tool=tool, tier="none", action=None, args=args if isinstance(args, dict) else {}, decision=decision, ok=False, error=message)
        return fail(message, decision=decision)

    return gated
