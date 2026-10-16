"""Crash reports for the ``diagnose-crash`` skill: macOS ``.ips`` files and Linux core dumps.

Everything here is pure (tested with fixture strings on any platform). The host adapters find the
reports; this module turns them into the few facts a diagnosis needs instead of the thousands of
lines of thread state a raw report carries."""

from __future__ import annotations

import json
import signal
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

# Crash report folders a report path must sit in (``system_logs`` is not a general file reader).
MAC_REPORT_DIRS: tuple[Path, ...] = (Path.home() / "Library" / "Logs" / "DiagnosticReports", Path("/Library/Logs/DiagnosticReports"))
# macOS bug types that mean "a process crashed" (309: current format, 109: older releases).
CRASH_BUG_TYPES = frozenset({"309", "109"})
_FRAMES = 15
_MESSAGES = 10


def parse_ips(text: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Split an ``.ips`` report into its one-line JSON header and its JSON body."""
    head, _, rest = text.partition("\n")
    try:
        header = json.loads(head)
    except json.JSONDecodeError as exc:
        raise ValueError("not a crash report (its first line is not JSON)") from exc
    try:
        body = json.loads(rest) if rest.strip() else {}
    except json.JSONDecodeError:
        body = {}
    return (header if isinstance(header, dict) else {}), (body if isinstance(body, dict) else {})


def is_crash_header(header: dict[str, Any]) -> bool:
    return str(header.get("bug_type") or "") in CRASH_BUG_TYPES


def summarise_ips(text: str) -> dict[str, Any]:
    """The facts of a macOS crash: what crashed, how, and the crashed thread's top frames."""
    header, body = parse_ips(text)
    images = body.get("usedImages") if isinstance(body.get("usedImages"), list) else []

    def image_name(index: Any) -> str:
        if isinstance(index, int) and 0 <= index < len(images) and isinstance(images[index], dict):
            image = images[index]
            return str(image.get("name") or Path(str(image.get("path") or "?")).name)
        return "?"

    threads = body.get("threads") if isinstance(body.get("threads"), list) else []
    faulting = body.get("faultingThread")
    crashed: dict[str, Any] | None = None
    if isinstance(faulting, int) and 0 <= faulting < len(threads) and isinstance(threads[faulting], dict):
        crashed = threads[faulting]
    else:
        crashed = next((t for t in threads if isinstance(t, dict) and t.get("triggered")), None)
    frames: list[str] = []
    for frame in (crashed or {}).get("frames") or []:
        if not isinstance(frame, dict):
            continue
        symbol = frame.get("symbol")
        where = f"{symbol} + {frame.get('symbolLocation', 0)}" if symbol else f"offset {frame.get('imageOffset', '?')}"
        frames.append(f"{image_name(frame.get('imageIndex'))}  {where}")
        if len(frames) >= _FRAMES:
            break

    exception = body.get("exception") if isinstance(body.get("exception"), dict) else {}
    termination = body.get("termination") if isinstance(body.get("termination"), dict) else {}
    asi = body.get("asi") if isinstance(body.get("asi"), dict) else {}
    # "Application specific information": abort() messages, Swift fatal errors, assertion text.
    messages = [str(line) for values in asi.values() if isinstance(values, list) for line in values][:_MESSAGES]
    bundle = body.get("bundleInfo") if isinstance(body.get("bundleInfo"), dict) else {}
    return {
        "app": header.get("app_name") or header.get("name") or body.get("procName"),
        "version": header.get("app_version") or bundle.get("CFBundleShortVersionString"),
        "bundle_id": header.get("bundleID") or bundle.get("CFBundleIdentifier"),
        "os": header.get("os_version"),
        "time": header.get("timestamp") or body.get("captureTime"),
        "is_crash": is_crash_header(header),
        "pid": body.get("pid"),
        "path": body.get("procPath"),
        "parent": body.get("parentProc"),
        "exception": {k: exception[k] for k in ("type", "signal", "subtype", "codes") if exception.get(k)},
        "termination": {k: termination[k] for k in ("namespace", "code", "indicator", "reasons") if termination.get(k) not in (None, "", [])},
        "app_messages": messages,
        "crashed_thread": {"index": faulting, "queue": (crashed or {}).get("queue"), "frames": frames},
    }


def resolve_mac_report(ref: str, dirs: Sequence[Path] = MAC_REPORT_DIRS) -> Path:
    """The report ``ref`` names (a path, or a bare file name), refusing anything outside ``dirs``."""
    raw = ref.strip()
    if not raw:
        raise ValueError("report is required: a crash report path or file name (see action=crashes)")
    candidates = [Path(raw).expanduser()] if "/" in raw else [base / raw for base in dirs]
    for candidate in candidates:
        resolved = candidate.resolve()
        if not any(resolved.is_relative_to(base.resolve()) for base in dirs):
            raise ValueError(f"{candidate} is not a crash report (reports live in {', '.join(str(d) for d in dirs)})")
        if resolved.is_file():
            return resolved
    raise ValueError(f"no crash report called {raw}")


def signal_name(number: Any) -> str | None:
    try:
        return signal.Signals(int(number)).name
    except (TypeError, ValueError):
        return None


def parse_coredumpctl_list(stdout: str) -> list[dict[str, Any]]:
    """``coredumpctl list --json=short`` rows, newest first."""
    try:
        rows = json.loads(stdout or "[]")
    except json.JSONDecodeError:
        return []
    out: list[dict[str, Any]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        exe = str(row.get("exe") or "")
        micros = row.get("time")
        out.append({
            "pid": row.get("pid"),
            "app": Path(exe).name or "?",
            "exe": exe or None,
            "signal": signal_name(row.get("sig")) or row.get("sig"),
            "time": datetime.fromtimestamp(int(micros) / 1_000_000).isoformat(timespec="seconds") if isinstance(micros, (int, float)) and micros > 0 else None,
            "core": row.get("corefile"),
        })
    out.sort(key=lambda r: r["time"] or "", reverse=True)
    return out


__all__ = ["CRASH_BUG_TYPES", "MAC_REPORT_DIRS", "is_crash_header", "parse_coredumpctl_list", "parse_ips", "resolve_mac_report", "signal_name", "summarise_ips"]
