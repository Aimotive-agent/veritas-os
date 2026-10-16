"""Append-only audit trail: one JSON line per bridge invocation."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any

from .util import data_dir, truncate

_lock = threading.Lock()
_MAX_ARG_CHARS = 400
_MAX_FILE_BYTES = 5 * 1024 * 1024
# Arguments that carry a secret (a Wi-Fi password) are logged as present, never by value.
_SECRET_KEYS = ("password", "passphrase", "secret", "token", "psk")


def _compact_args(args: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in args.items():
        if any(word in key.lower() for word in _SECRET_KEYS) and value not in (None, ""):
            out[key] = "[redacted]"
        elif isinstance(value, str):
            out[key] = truncate(value, _MAX_ARG_CHARS)
        elif isinstance(value, (int, float, bool)) or value is None:
            out[key] = value
        else:
            out[key] = truncate(json.dumps(value, ensure_ascii=False, default=str), _MAX_ARG_CHARS)
    return out


def record(*, tool: str, tier: str, action: str | None, args: dict[str, Any], decision: str, ok: bool, summary: str | None = None, error: str | None = None) -> None:
    """Never raises: a failed audit write is logged to stderr, not surfaced to the agent."""
    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "tool": tool,
        "tier": tier,
        "action": action,
        "decision": decision,
        "ok": ok,
        "summary": truncate(summary, 300) if summary else None,
        "error": truncate(error, 300) if error else None,
        "args": _compact_args(args),
    }
    try:
        path = data_dir() / "audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            # Simple rotation: keep the file bounded so a chatty session cannot grow it forever.
            if path.exists() and path.stat().st_size > _MAX_FILE_BYTES:
                path.rename(path.with_suffix(".jsonl.1"))
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as exc:  # noqa: BLE001
        import sys

        print(f"herald-os-bridge: audit write failed: {exc}", file=sys.stderr)
