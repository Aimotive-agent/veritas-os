"""Linux host adapter built on what a freedesktop.org desktop ships with: ``ps``, ``ss``, ``du``,
``plocate``/``fd``/``find``, ``.desktop`` entries + ``gio launch``/``gtk-launch``, ``xdg-open``,
``nmcli``, ``ip``, ``bluetoothctl``, ``wpctl``/``pactl``, ``gsettings``, ``journalctl``, ``loginctl``,
``gio trash`` and ``notify-send``.

Every ``parse_*`` function is pure (unit-tested with fixture strings on any platform); the methods
on ``LinuxHost`` call ``run(...)`` and translate a missing binary (exit 127) into ``HostNotSupported``
naming the package to install."""

from __future__ import annotations

import json
import os
import platform
import pwd
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal, Sequence

from ..crash import parse_coredumpctl_list
from ..documents import EMPTY_PAGE_CHARS, DocumentText, count_pdf_pages, document_type, page_images, split_pdftotext, text_with_python
from ..util import ExecResult, run
from .base import AppInfo, FileSearch, FoundFile, HostAdapter, HostNotSupported, PortListener, ProcessRow
from .desktop_entries import DesktopEntry, scan_desktop_entries
from .posix import parse_du, parse_ps

# File extensions per FileSearch.kind (Linux has no Spotlight content-type tree).
KIND_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "image": ("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "avif"),
    "screenshot": ("png", "jpg", "jpeg", "webp"),
    "document": ("pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub"),
    "pdf": ("pdf",),
    "video": ("mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv"),
    "audio": ("mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma"),
    "code": ("py", "js", "ts", "tsx", "jsx", "go", "rs", "c", "h", "cpp", "hpp", "java", "rb", "sh", "swift", "kt", "php", "html", "css", "json", "yaml", "yml", "toml", "sql", "lua"),
    "archive": ("zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "deb", "rpm", "appimage"),
}
_SCREENSHOT_NAME = re.compile(r"screenshot|screen shot|screencapture|captura", re.IGNORECASE)

# journalctl priorities per the level names the tool layer accepts (darwin: messageType 16 / 17).
LOG_PRIORITIES: dict[str, str | None] = {"error": "err", "fault": "crit", "any": None}

# gnome-control-center panel per pane name (same keys as the macOS adapter where a panel exists).
SETTINGS_PANES: dict[str, str] = {
    "general": "system",
    "appearance": "appearance",
    "accessibility": "universal-access",
    "desktop_and_dock": "ubuntu",
    "displays": "display",
    "wallpaper": "background",
    "screen_saver": "screen",
    "battery": "power",
    "lock_screen": "screen",
    "privacy_and_security": "privacy",
    "privacy": "privacy",
    "security": "privacy",
    "screen_recording": "privacy",
    "microphone": "privacy",
    "users_and_groups": "user-accounts",
    "internet_accounts": "online-accounts",
    "wifi": "wifi",
    "bluetooth": "bluetooth",
    "network": "network",
    "notifications": "notifications",
    "sound": "sound",
    "keyboard": "keyboard",
    "trackpad": "mouse",
    "mouse": "mouse",
    "printers": "printers",
    "software_update": "system",
    "storage": "system",
    "date_and_time": "datetime",
    "sharing": "sharing",
    "applications": "applications",
    "search": "search",
    "region": "region",
    "multitasking": "multitasking",
}

_SYSTEM_MOUNT_PREFIXES = ("/boot", "/snap", "/var/snap", "/dev", "/sys", "/proc", "/run", "/tmp", "/var/lib/docker", "/var/lib/containers")


# ---------------------------------------------------------------------------------------------
# Pure parsers
# ---------------------------------------------------------------------------------------------

def parse_os_release(text: str) -> dict[str, str]:
    """``/etc/os-release`` ``KEY=value`` pairs (values may be quoted)."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def parse_meminfo(text: str) -> dict[str, int]:
    """``/proc/meminfo`` -> field -> bytes."""
    out: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^(\w+):\s+(\d+)(?:\s+(kB))?", line)
        if match:
            out[match[1]] = int(match[2]) * (1024 if match[3] else 1)
    return out


def parse_cpuinfo_model(text: str) -> str | None:
    """The CPU marketing name from ``/proc/cpuinfo`` (x86 ``model name``; ARM ``Model``/``Hardware``)."""
    for label in ("model name", "Model", "Hardware", "cpu model", "Processor"):
        match = re.search(rf"^{re.escape(label)}\s*:\s*(.+)$", text, re.MULTILINE)
        if match and match[1].strip():
            return match[1].strip()
    return None


def parse_df(text: str) -> list[dict[str, Any]]:
    """``df -kP`` -> real volumes (root, home, media) with total/used/free bytes."""
    disks: list[dict[str, Any]] = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        mount = parts[5]
        if mount != "/" and mount.startswith(_SYSTEM_MOUNT_PREFIXES) and not mount.startswith("/run/media"):
            continue
        try:
            disks.append({"mount": mount, "total_bytes": int(parts[1]) * 1024, "used_bytes": int(parts[2]) * 1024, "free_bytes": int(parts[3]) * 1024})
        except ValueError:
            continue
    return disks


_SS_LOCAL = re.compile(r"(\S+?):(\d+)\s+\S+:(?:\d+|\*)")
_SS_PROCESS = re.compile(r'\("([^"]*)",pid=(\d+)')
_SS_NETIDS = ("tcp", "udp", "tcp6", "udp6", "raw", "sctp", "dccp")


def parse_ss(text: str, port: int) -> list[PortListener]:
    """``ss -ltnup`` (or ``ss -ltnp``) output -> one listener per (pid, port).

    ``ss`` omits the ``Netid`` column when a single protocol is requested and prints the owning process
    only for sockets the caller may inspect; rows without a visible owner get ``pid=0``. The user is
    not part of ``ss`` output; the adapter fills it in from ``/proc``."""
    lines = text.splitlines()
    if not lines:
        return []
    has_netid = lines[0].lstrip().lower().startswith("netid")
    out: list[PortListener] = []
    seen: set[tuple[int, int]] = set()
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 4:
            continue
        local = _SS_LOCAL.search(line)
        if not local or int(local[2]) != port:
            continue
        first = parts[0].lower()
        protocol = first if (has_netid or first in _SS_NETIDS) else "tcp"
        protocol = protocol.rstrip("6")
        owners = _SS_PROCESS.findall(line) or [("unknown (owned by another user; run as root to see it)", "0")]
        for command, pid_text in owners:
            pid = int(pid_text)
            key = (pid, port)
            if key in seen:
                continue
            seen.add(key)
            out.append(PortListener(pid=pid, command=command, user="", port=port, protocol=protocol))
    return out


def split_nmcli_terse(line: str) -> list[str]:
    """Split one ``nmcli -t`` line on ``:`` while honouring the ``\\:`` escape nmcli uses inside values."""
    fields: list[str] = []
    current: list[str] = []
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line):
            current.append(line[i + 1])
            i += 2
            continue
        if ch == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    fields.append("".join(current))
    return fields


def parse_nmcli_dev_status(text: str) -> list[dict[str, str]]:
    """``nmcli -t -f TYPE,STATE,CONNECTION,DEVICE dev status`` -> [{type, state, connection, device}]."""
    rows: list[dict[str, str]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = split_nmcli_terse(line.rstrip("\n"))
        if len(fields) < 4:
            continue
        rows.append({"type": fields[0], "state": fields[1], "connection": fields[2] or "", "device": fields[3]})
    return rows


def parse_nmcli_wifi(text: str) -> list[dict[str, Any]]:
    """``nmcli -t -f ACTIVE,SSID,SIGNAL[,CHAN,RATE,SECURITY] dev wifi list`` -> visible networks.

    Each row has ``active`` (bool), ``ssid`` (``None`` for hidden networks), ``signal`` (percent) and, when
    the extra columns were requested, ``channel``, ``rate`` and ``security``."""
    networks: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = split_nmcli_terse(line.rstrip("\n"))
        if len(fields) < 3:
            continue
        try:
            signal_pct: int | None = int(fields[2])
        except ValueError:
            signal_pct = None
        row: dict[str, Any] = {"active": fields[0].strip().lower() == "yes", "ssid": fields[1] or None, "signal": signal_pct}
        if len(fields) > 3:
            row["channel"] = fields[3] or None
        if len(fields) > 4:
            row["rate"] = fields[4] or None
        if len(fields) > 5:
            row["security"] = fields[5] or None
        networks.append(row)
    return networks


def parse_ip_route(json_text: str) -> tuple[str | None, str | None]:
    """``ip -j route show default`` -> (gateway, interface) of the first default route."""
    try:
        routes = json.loads(json_text or "[]")
    except ValueError:
        return None, None
    for route in routes if isinstance(routes, list) else []:
        if isinstance(route, dict) and route.get("dst") in ("default", None) and (route.get("gateway") or route.get("dev")):
            return route.get("gateway"), route.get("dev")
    return None, None


def parse_ip_addr(json_text: str) -> dict[str, dict[str, Any]]:
    """``ip -j addr show`` -> interface name -> {mac, ipv4, up}."""
    try:
        links = json.loads(json_text or "[]")
    except ValueError:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for link in links if isinstance(links, list) else []:
        if not isinstance(link, dict) or not link.get("ifname"):
            continue
        ipv4 = next((a.get("local") for a in link.get("addr_info") or [] if a.get("family") == "inet"), None)
        out[link["ifname"]] = {"mac": link.get("address"), "ipv4": ipv4, "up": "UP" in (link.get("flags") or [])}
    return out


def parse_bluetoothctl_show(text: str) -> dict[str, Any]:
    """``bluetoothctl show`` -> {powered_on, name, address}. ``powered_on`` is ``None`` without a controller."""
    address = re.search(r"^Controller\s+([0-9A-Fa-f:]{17})", text, re.MULTILINE)
    powered = re.search(r"^\s*Powered:\s*(yes|no)", text, re.MULTILINE)
    name = re.search(r"^\s*(?:Alias|Name):\s*(.+)$", text, re.MULTILINE)
    return {
        "powered_on": (powered[1] == "yes") if powered else None,
        "name": name[1].strip() if name else None,
        "address": address[1] if address else None,
    }


def parse_bluetoothctl_devices(text: str) -> list[str]:
    """``bluetoothctl devices [Connected|Paired]`` -> device names."""
    names: list[str] = []
    for line in text.splitlines():
        match = re.match(r"^Device\s+[0-9A-Fa-f:]{17}\s+(.+)$", line.strip())
        if match:
            names.append(match[1].strip())
    return names


def parse_bluetoothctl_device_rows(text: str) -> list[tuple[str, str]]:
    """``bluetoothctl devices`` -> [(address, name)]; an unnamed device is called by its address."""
    rows: list[tuple[str, str]] = []
    for line in text.splitlines():
        match = re.match(r"^Device\s+([0-9A-Fa-f:]{17})(?:\s+(.+))?$", line.strip())
        if match:
            rows.append((match[1].upper(), (match[2] or match[1]).strip()))
    return rows


def pick_device(rows: Sequence[tuple[str, str]], query: str) -> tuple[str, str] | None:
    """The one (id, name) the query means: an exact id or name, else the only name containing it."""
    needle = query.strip().lower()
    exact = [row for row in rows if row[0].lower() == needle or row[1].lower() == needle]
    if exact:
        return exact[0]
    partial = [row for row in rows if needle and needle in row[1].lower()]
    return partial[0] if len(partial) == 1 else None


def parse_pactl_json(text: str, default_name: str) -> list[dict[str, Any]]:
    """``pactl -f json list sinks|sources`` -> devices (monitor sources skipped), volume averaged."""
    try:
        nodes = json.loads(text or "[]")
    except json.JSONDecodeError:
        return []
    devices: list[dict[str, Any]] = []
    for node in nodes if isinstance(nodes, list) else []:
        name = str(node.get("name") or "")
        if not name or name.endswith(".monitor"):
            continue
        levels = [int(str(ch.get("value_percent", "")).rstrip("%")) for ch in (node.get("volume") or {}).values() if str(ch.get("value_percent", "")).rstrip("%").isdigit()]
        devices.append({
            "id": name, "name": node.get("description") or name, "default": name == default_name.strip(),
            "volume": round(sum(levels) / len(levels)) if levels else None, "muted": bool(node.get("mute")),
        })
    return devices


def parse_power_profiles(text: str) -> dict[str, Any]:
    """``powerprofilesctl list`` -> {active, profiles}; the active profile is starred."""
    profiles: list[str] = []
    active: str | None = None
    for line in text.splitlines():
        match = re.match(r"^(\*)?\s*([a-z][a-z-]*):\s*$", line)
        if match:
            profiles.append(match[2])
            if match[1]:
                active = match[2]
    return {"active": active, "profiles": profiles}


def parse_wpctl_volume(text: str) -> tuple[int | None, bool]:
    """``wpctl get-volume`` (``Volume: 0.45 [MUTED]``) -> (percent, muted)."""
    match = re.search(r"Volume:\s*([\d.]+)", text)
    percent = int(round(float(match[1]) * 100)) if match else None
    return percent, "[MUTED]" in text


def parse_pactl_volume(text: str) -> int | None:
    """``pactl get-sink-volume`` -> the first channel's percentage."""
    match = re.search(r"(\d+)%", text)
    return int(match[1]) if match else None


def parse_gsettings_value(text: str) -> str:
    """``gsettings get`` prints GVariant text: strip the ``'...'`` quoting."""
    value = text.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


def search_time_bounds(search: FileSearch) -> tuple[float | None, float | None]:
    """``since`` (inclusive, start of day) / ``until`` (exclusive end of day) -> epoch bounds."""

    def to_epoch(value: str, end_of_day: bool) -> float:
        value = value.strip()
        try:
            if len(value) == 10:
                dt = datetime.fromisoformat(value)
                if end_of_day:
                    dt = dt + timedelta(days=1)
            else:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"invalid date '{value}' (use YYYY-MM-DD or ISO 8601)") from exc
        return dt.timestamp()

    return (to_epoch(search.since, False) if search.since else None), (to_epoch(search.until, True) if search.until else None)


def search_extensions(search: FileSearch) -> set[str]:
    """Lower-case extensions (no dot) the search accepts; empty means any."""
    exts = {e.lstrip(".").lower() for e in search.extensions if e}
    kind = search.kind or "any"
    if kind in KIND_EXTENSIONS:
        kind_exts = set(KIND_EXTENSIONS[kind])
        exts = exts & kind_exts if exts else kind_exts
    return exts


def matches_search(path: str, search: FileSearch, *, is_dir: bool, mtime: float | None, bounds: tuple[float | None, float | None] | None = None) -> bool:
    """Decide whether a candidate path satisfies every FileSearch constraint (pure; unit-tested).

    ``text`` matches the file name only: Linux has no content index comparable to Spotlight.
    ``since``/``until`` apply to the modification time (birth time is not portable)."""
    name = Path(path).name
    lower = name.lower()
    kind = search.kind or "any"
    if kind == "folder":
        if not is_dir:
            return False
    elif kind != "any" and is_dir:
        return False
    if search.name and search.name.lower() not in lower:
        return False
    if search.text and search.text.lower() not in lower:
        return False
    exts = search_extensions(search)
    if exts:
        ext = lower.rsplit(".", 1)[1] if "." in lower else ""
        if is_dir or ext not in exts:
            return False
    if kind == "screenshot" and not _SCREENSHOT_NAME.search(name):
        return False
    if search.scope:
        scope = os.path.abspath(os.path.expanduser(search.scope)).rstrip("/") + "/"
        if not (path + "/").startswith(scope):
            return False
    since, until = bounds if bounds is not None else search_time_bounds(search)
    if (since is not None or until is not None) and mtime is None:
        return False
    if since is not None and mtime is not None and mtime < since:
        return False
    if until is not None and mtime is not None and mtime >= until:
        return False
    return True


def _ere_escape(text: str) -> str:
    """Escape for a POSIX extended regular expression (``plocate --regex``)."""
    return re.sub(r"([.^$*+?()\[\]{}|\\])", r"\\\1", text)


def _missing(result: ExecResult, package: str) -> None:
    """Translate exit 127 (binary not found) into a HostNotSupported that names the package."""
    if result.code == 127:
        tool = result.stderr.split(":", 1)[0].strip() or "tool"
        raise HostNotSupported(f"{tool} is not installed on this system (install {package}).")


def _read_text(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _detach(argv: Sequence[str]) -> None:
    """Start a desktop program without waiting for it (and without tying it to our session)."""
    subprocess.Popen(list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def _launcher(argv: Sequence[str], timeout: float = 5.0) -> int:
    """Run a launcher (``gio launch``, ``xdg-open``) that hands off to a GUI app.

    The launched app inherits the launcher's stdio, so capturing output would block until the app
    quits (Firefox held ``system_open`` for its full 20 s timeout). Discard stdio, wait only for the
    launcher process itself, and treat a launcher that is still alive after ``timeout`` as success.
    Returns the exit code, 127 when the launcher binary is missing.
    """
    try:
        proc = subprocess.Popen(list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    except FileNotFoundError:
        return 127
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return 0


class LinuxHost(HostAdapter):
    platform = "linux"

    def available(self) -> bool:
        return sys.platform.startswith("linux")

    # --- read -------------------------------------------------------------------------------
    def system_info(self) -> dict[str, Any]:
        release = parse_os_release(_read_text("/etc/os-release"))
        os_name = release.get("PRETTY_NAME") or " ".join(p for p in (release.get("NAME"), release.get("VERSION_ID")) if p) or "Linux"
        kernel = platform.release() or run(["uname", "-r"]).stdout.strip()
        mem = parse_meminfo(_read_text("/proc/meminfo"))
        total = mem.get("MemTotal", 0)
        available = mem.get("MemAvailable")
        used = total - available if available is not None else total - mem.get("MemFree", 0)
        try:
            load: list[float] | None = [round(x, 2) for x in os.getloadavg()]
        except OSError:
            load = None
        uptime_text = _read_text("/proc/uptime").split()
        try:
            uptime_s: int | None = int(float(uptime_text[0])) if uptime_text else None
        except ValueError:
            uptime_s = None
        df = run(["df", "-kP", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "efivarfs", "-x", "overlay"], timeout=10)
        if not df.ok:
            df = run(["df", "-kP"], timeout=10)
        uname = os.uname()
        return {
            "os": os_name, "build": kernel, "hostname": uname.nodename, "arch": uname.machine,
            "chip": parse_cpuinfo_model(_read_text("/proc/cpuinfo")) or platform.processor() or None, "cpu_cores": os.cpu_count() or 0,
            "memory_total_bytes": total, "memory_used_bytes": max(0, used),
            "load_average": load, "uptime_seconds": uptime_s, "disks": parse_df(df.stdout), "battery": self._battery(),
            "user": os.environ.get("USER") or self._username(os.getuid()), "home": str(Path.home()),
        }

    @staticmethod
    def _battery() -> dict[str, Any] | None:
        supplies = Path("/sys/class/power_supply")
        if not supplies.is_dir():
            return None
        for supply in sorted(supplies.glob("BAT*")):
            capacity = _read_text(str(supply / "capacity")).strip()
            state = _read_text(str(supply / "status")).strip()
            if capacity.isdigit():
                return {"percent": int(capacity), "state": state or "unknown"}
        return None

    @staticmethod
    def _username(uid: int) -> str | None:
        try:
            return pwd.getpwuid(uid).pw_name
        except KeyError:
            return None

    def _ps(self) -> list[ProcessRow]:
        result = run(["ps", "-eo", "pid=,ppid=,user=,%cpu=,%mem=,rss=,comm="])
        _missing(result, "procps")
        return parse_ps(result.stdout)

    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]:
        rows = self._ps()
        rows.sort(key=(lambda r: r.cpu_percent) if sort == "cpu" else (lambda r: r.rss_bytes), reverse=True)
        return rows[:limit]

    def find_processes(self, name: str, limit: int) -> list[ProcessRow]:
        needle = name.lower()
        rows = [r for r in self._ps() if needle in r.command.lower()]
        rows.sort(key=lambda r: r.cpu_percent, reverse=True)
        return rows[:limit]

    def listeners_on_port(self, port: int) -> list[PortListener]:
        result = run(["ss", "-ltnup"], timeout=10)
        if result.code == 127:
            _missing(result, "iproute2")
        if not result.ok:
            result = run(["ss", "-ltnp"], timeout=10)
        listeners = parse_ss(result.stdout, port)
        for listener in listeners:
            if listener.pid:
                listener.user = self._process_owner(listener.pid) or ""
        return listeners

    def _process_owner(self, pid: int) -> str | None:
        try:
            return self._username(os.stat(f"/proc/{pid}").st_uid)
        except OSError:
            return None

    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]:
        result = run(["du", "-x", "-k", f"--max-depth={depth}", str(path)], timeout=timeout)
        _missing(result, "coreutils")
        rows = parse_du(result.stdout)
        total = next((b for b, p in rows if p.rstrip("/") == str(path).rstrip("/")), None)
        children = sorted((r for r in rows if r[1].rstrip("/") != str(path).rstrip("/")), key=lambda r: r[0], reverse=True)
        return {
            "path": str(path), "total_bytes": total, "timed_out": result.code == 124,
            "entries": [{"path": p, "bytes": b} for b, p in children[:limit]],
            "note": "Sizes exclude items du could not read (permission denied)." if "Permission denied" in result.stderr else None,
        }

    # --- file search ------------------------------------------------------------------------
    def find_files(self, query: FileSearch) -> list[FoundFile]:
        kind = query.kind or "any"
        if not any((query.text, query.name, kind != "any", query.since, query.until, query.extensions)):
            raise ValueError("search needs at least one of: text, name, kind, since/until, extensions")
        bounds = search_time_bounds(query)  # Validates the dates before spending time on the listing.
        root = os.path.abspath(os.path.expanduser(query.scope)) if query.scope else str(Path.home())
        candidates = self._candidate_paths(query, root)
        found: list[FoundFile] = []
        for line in candidates:
            path = line.strip()
            if not path:
                continue
            try:
                st = os.stat(path)
            except OSError:
                continue
            is_dir = os.path.isdir(path)
            if not matches_search(path, query, is_dir=is_dir, mtime=st.st_mtime, bounds=bounds):
                continue
            found.append(FoundFile(path=path, size=st.st_size, modified=datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"), kind="folder" if is_dir else "file"))
        found.sort(key=lambda f: f.modified or "", reverse=True)
        return found[: max(1, query.limit)]

    def _candidate_paths(self, query: FileSearch, root: str) -> list[str]:
        """List candidates with the fastest available backend; precise filtering happens in Python."""
        needle = query.name or query.text
        exts = sorted(search_extensions(query))
        cap = str(max(2000, query.limit * 40))
        if Path("/var/lib/plocate/plocate.db").exists() and shutil.which("plocate"):
            # Regex mode so every pattern (root prefix, name, extensions) must match the same path.
            patterns = ["^" + _ere_escape(root.rstrip("/") + "/")]
            if needle:
                patterns.append(_ere_escape(needle))
            if exts:
                patterns.append(r"\.(" + "|".join(_ere_escape(e) for e in exts) + ")$")
            result = run(["plocate", "-i", "--regex", "-l", cap, "--", *patterns], timeout=30)
            if result.code in (0, 1):  # 1: no matches.
                return result.stdout.splitlines()
        fd = shutil.which("fd") or shutil.which("fdfind")
        if fd:
            argv = [fd, "--absolute-path", "--color", "never", "--ignore-case", "--no-ignore", "--max-results", cap]
            if (query.kind or "any") == "folder":
                argv += ["--type", "d"]
            for ext in exts:
                argv += ["--extension", ext]
            if query.since and len(query.since.strip()) == 10:
                argv += ["--changed-after", query.since.strip()]
            argv.append(re.escape(needle) if needle else ".")
            argv.append(root)
            result = run(argv, timeout=30)
            if result.code in (0, 1, 124):
                return result.stdout.splitlines()
        argv = ["find", root, "-xdev"]
        if (query.kind or "any") == "folder":
            argv += ["-type", "d"]
        if needle:
            argv += ["-iname", f"*{needle}*"]
        elif len(exts) == 1:
            argv += ["-iname", f"*.{exts[0]}"]
        result = run(argv, timeout=30)
        _missing(result, "findutils")
        return result.stdout.splitlines()

    # --- apps -------------------------------------------------------------------------------
    def _entries(self) -> list[DesktopEntry]:
        return scan_desktop_entries()

    def installed_apps(self) -> list[AppInfo]:
        return [AppInfo(name=e.name, path=e.path, bundle_id=e.desktop_id) for e in self._entries()]

    def _running(self, entries: Sequence[DesktopEntry] | None = None) -> list[tuple[DesktopEntry, list[int]]]:
        """Desktop entries that have a live process (``comm`` matches the Exec program or WM class)."""
        by_name: dict[str, list[int]] = {}
        for row in self._ps():
            by_name.setdefault(row.name.lower(), []).append(row.pid)
        matches: list[tuple[DesktopEntry, list[int]]] = []
        for entry in entries if entries is not None else self._entries():
            pids: list[int] = []
            for candidate in entry.process_names():
                # The kernel truncates comm to 15 bytes.
                pids += by_name.get(candidate, []) or by_name.get(candidate[:15], [])
            if pids:
                matches.append((entry, sorted(set(pids))))
        return matches

    def running_apps(self) -> list[AppInfo]:
        return [AppInfo(name=e.name, path=e.path, bundle_id=e.desktop_id, running=True, pid=pids[0]) for e, pids in self._running()]

    def _resolve_entry(self, name: str) -> DesktopEntry | None:
        needle = name.strip().lower().removesuffix(".desktop")
        entries = self._entries()
        for entry in entries:
            if entry.name.lower() == needle or entry.desktop_id.lower() == needle:
                return entry
        for entry in entries:
            if (entry.exec_basename or "").lower() == needle or needle in entry.process_names():
                return entry
        for entry in entries:
            if needle in entry.name.lower() or needle in entry.desktop_id.lower():
                return entry
        return None

    def resolve_app(self, name: str) -> AppInfo | None:
        entry = self._resolve_entry(name)
        return AppInfo(name=entry.name, path=entry.path, bundle_id=entry.desktop_id) if entry else None

    def _launch(self, entry: DesktopEntry, args: Sequence[str]) -> None:
        """``gio launch`` -> ``gtk-launch`` -> exec the entry's program directly."""
        code = _launcher(["gio", "launch", entry.path, *args])
        if code == 0:
            return
        if code != 127:
            raise RuntimeError(f"could not launch {entry.name} (gio launch exited {code})")
        code = _launcher(["gtk-launch", entry.desktop_id, *args])
        if code == 0:
            return
        if code != 127:
            raise RuntimeError(f"could not launch {entry.name} (gtk-launch exited {code})")
        argv = entry.exec_argv
        if not argv or not shutil.which(argv[0]):
            raise HostNotSupported(f"Neither gio nor gtk-launch is available and {entry.exec_cmd!r} is not on PATH (install glib2 / libglib2.0-bin).")
        _detach([*argv, *args])

    def open_app(self, name: str, args: Sequence[str] = ()) -> None:
        entry = self._resolve_entry(name)
        if entry is not None:
            self._launch(entry, args)
            return
        program = shutil.which(name)
        if not program:
            raise RuntimeError(f"no application named {name!r} (no .desktop entry and not on PATH)")
        _detach([program, *args])

    def _open_with(self, target: str, app: str | None) -> None:
        if app:
            entry = self._resolve_entry(app)
            if entry is not None:
                self._launch(entry, [target])
                return
            program = shutil.which(app)
            if not program:
                raise RuntimeError(f"no application named {app!r}")
            _detach([program, target])
            return
        code = _launcher(["xdg-open", target])
        if code == 127:
            code = _launcher(["gio", "open", target])
            if code == 127:
                raise HostNotSupported("Opening files and URLs requires xdg-utils (xdg-open) or glib2 (gio).")
        if code != 0:
            raise RuntimeError(f"could not open {target} (launcher exited {code})")

    def open_url(self, url: str, app: str | None = None) -> None:
        self._open_with(url, app)

    def open_path(self, path: Path, app: str | None = None) -> None:
        self._open_with(str(path), app)

    def reveal(self, path: Path) -> None:
        uri = Path(path).absolute().as_uri()
        result = run([
            "dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems",
            f"array:string:{uri}", "string:",
        ], timeout=10)
        if result.ok:
            return
        parent = path if path.is_dir() else path.parent
        code = _launcher(["xdg-open", str(parent)])
        if code == 127:
            raise HostNotSupported("Revealing files requires a FileManager1 file manager or xdg-utils (xdg-open).")
        if code != 0:
            raise RuntimeError(result.stderr.strip() or f"could not reveal {path} (xdg-open exited {code})")

    def _app_pids(self, name: str) -> tuple[str, list[int]]:
        entry = self._resolve_entry(name)
        if entry is not None:
            for match, pids in self._running([entry]):
                return match.name, pids
            return entry.name, []
        needle = name.strip().lower()
        return name, sorted({r.pid for r in self._ps() if r.name.lower() == needle})

    def quit_app(self, name: str, force: bool) -> None:
        label, pids = self._app_pids(name)
        pids = [p for p in pids if p not in (0, 1, os.getpid(), os.getppid())]
        if not pids:
            raise RuntimeError(f"{label} is not running")
        sig = signal.SIGKILL if force else signal.SIGTERM
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                continue

    # --- system state (read) -----------------------------------------------------------------
    def network_status(self) -> dict[str, Any]:
        route = run(["ip", "-j", "route", "show", "default"], timeout=5)
        _missing(route, "iproute2")
        gateway, iface = parse_ip_route(route.stdout)
        addrs = parse_ip_addr(run(["ip", "-j", "addr", "show"], timeout=5).stdout)
        status = run(["nmcli", "-t", "-f", "TYPE,STATE,CONNECTION,DEVICE", "dev", "status"], timeout=10)
        note: str | None = None
        devices = parse_nmcli_dev_status(status.stdout) if status.ok else []
        if status.code == 127:
            note = "NetworkManager (nmcli) is not installed; Wi-Fi details are unavailable."
        interfaces: list[dict[str, Any]] = []
        if devices:
            for dev in devices:
                if dev["type"] in ("loopback", "bridge", "tun", "wireguard") and dev["device"] != iface:
                    continue
                info = addrs.get(dev["device"], {})
                if info.get("ipv4") or dev["device"] == iface:
                    interfaces.append({"name": dev["connection"] or dev["type"], "device": dev["device"], "mac": info.get("mac"), "ipv4": info.get("ipv4"), "default_route": dev["device"] == iface, "type": dev["type"], "state": dev["state"]})
        else:
            for device, info in addrs.items():
                if device == "lo":
                    continue
                if info.get("ipv4") or device == iface:
                    interfaces.append({"name": device, "device": device, "mac": info.get("mac"), "ipv4": info.get("ipv4"), "default_route": device == iface})
        wifi: dict[str, Any] | None = None
        wifi_dev = next((d for d in devices if d["type"] == "wifi"), None)
        if wifi_dev:
            listing = run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL,CHAN,RATE,SECURITY", "dev", "wifi", "list", "--rescan", "no"], timeout=15)
            active = next((n for n in parse_nmcli_wifi(listing.stdout) if n["active"]), None)
            connected = wifi_dev["state"].startswith("connected")
            wifi = {
                "interface": wifi_dev["device"], "connected": connected,
                "ssid": (active or {}).get("ssid") or (wifi_dev["connection"] if connected else None),
                "phy_mode": None, "channel": (active or {}).get("channel"), "rate_mbps": self._rate_mbps((active or {}).get("rate")),
                "signal_noise": None, "signal_percent": (active or {}).get("signal"), "security": (active or {}).get("security"),
            }
        dns: list[str] = []
        if iface and status.code != 127:
            dns = re.findall(r"IP4\.DNS\[\d+\]:(\S+)", run(["nmcli", "-t", "-f", "IP4.DNS", "dev", "show", iface], timeout=5).stdout)
        if not dns:
            dns = re.findall(r"^nameserver\s+(\S+)", _read_text("/etc/resolv.conf"), re.MULTILINE)
        return {
            "online": bool(iface), "default_interface": iface, "gateway": gateway, "dns": sorted(set(dns))[:6],
            "interfaces": interfaces, "wifi": wifi, "note": note,
        }

    @staticmethod
    def _rate_mbps(rate: str | None) -> int | None:
        match = re.match(r"\s*(\d+)", rate or "")
        return int(match[1]) if match else None

    def bluetooth_status(self) -> dict[str, Any]:
        show = run(["bluetoothctl", "show"], timeout=10)
        _missing(show, "bluez")
        controller = parse_bluetoothctl_show(show.stdout)
        connected = parse_bluetoothctl_devices(run(["bluetoothctl", "devices", "Connected"], timeout=10).stdout)
        paired = parse_bluetoothctl_devices(run(["bluetoothctl", "devices", "Paired"], timeout=10).stdout)
        return {"powered_on": controller["powered_on"], "connected": connected, "paired": [p for p in paired if p not in connected]}

    def audio_status(self) -> dict[str, Any]:
        sink = run(["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"], timeout=5)
        if sink.code != 127:
            output, muted = parse_wpctl_volume(sink.stdout)
            source = run(["wpctl", "get-volume", "@DEFAULT_AUDIO_SOURCE@"], timeout=5)
            input_volume, _ = parse_wpctl_volume(source.stdout)
            return {"output_volume": output, "input_volume": input_volume, "alert_volume": None, "muted": muted if sink.ok else None}
        volume = run(["pactl", "get-sink-volume", "@DEFAULT_SINK@"], timeout=5)
        _missing(volume, "wireplumber for wpctl, or pulseaudio-utils for pactl")
        mute = run(["pactl", "get-sink-mute", "@DEFAULT_SINK@"], timeout=5).stdout
        source = run(["pactl", "get-source-volume", "@DEFAULT_SOURCE@"], timeout=5).stdout
        return {
            "output_volume": parse_pactl_volume(volume.stdout), "input_volume": parse_pactl_volume(source), "alert_volume": None,
            "muted": ("Mute: yes" in mute) if "Mute:" in mute else None,
        }

    def _drm_displays(self) -> list[dict[str, Any]]:
        displays: list[dict[str, Any]] = []
        drm = Path("/sys/class/drm")
        if not drm.is_dir():
            return displays
        for connector in sorted(drm.glob("card*-*")):
            if _read_text(str(connector / "status")).strip() != "connected":
                continue
            name = connector.name.split("-", 1)[1]
            modes = _read_text(str(connector / "modes")).split()
            displays.append({"name": name, "resolution": modes[0] if modes else None, "main": not displays, "connection": re.sub(r"-?\d+$", "", name) or None})
        return displays

    def appearance_status(self) -> dict[str, Any]:
        scheme = run(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"], timeout=5)
        dark: bool | None
        if scheme.ok:
            dark = parse_gsettings_value(scheme.stdout) == "prefer-dark"
        elif scheme.code != 127:
            theme = run(["gsettings", "get", "org.gnome.desktop.interface", "gtk-theme"], timeout=5)
            dark = "dark" in parse_gsettings_value(theme.stdout).lower() if theme.ok else None
        else:
            dark = None
        return {"dark_mode": dark, "displays": self._drm_displays()}

    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]:
        argv = ["journalctl", "--since", f"-{minutes}min", "--no-pager", "-o", "short-iso", "-n", str(limit)]
        priority = LOG_PRIORITIES.get(level, "err")
        if priority:
            argv += ["-p", priority]
        if process:
            argv.append(f"_COMM={process}")
        result = run(argv, timeout=60)
        _missing(result, "systemd for journalctl")
        return [ln for ln in result.stdout.splitlines() if ln.strip() and not ln.startswith("-- ")][-limit:]

    def crash_reports(self, limit: int) -> list[dict[str, Any]]:
        result = run(["coredumpctl", "list", "--json=short", "--no-pager", "--since=-7d"], timeout=30)
        _missing(result, "systemd-coredump for coredumpctl")
        # "No coredumps found." is exit 1 with nothing on stdout.
        return parse_coredumpctl_list(result.stdout)[:limit] if result.stdout.strip() else []

    def crash_report(self, ref: str) -> dict[str, Any]:
        pid = ref.strip()
        if not pid.isdigit():
            raise ValueError("on Linux, report is the crashed process id (see action=crashes)")
        result = run(["coredumpctl", "info", "--no-pager", pid], timeout=60)
        _missing(result, "systemd-coredump for coredumpctl")
        text = result.stdout.strip() or result.stderr.strip()
        if not result.ok and not result.stdout.strip():
            raise RuntimeError(text or f"no core dump for pid {pid}")
        return {"pid": int(pid), "info": text[:12000], "truncated": len(text) > 12000}

    # --- documents (read) ----------------------------------------------------------------------
    def read_document(self, path: Path, max_pages: int, ocr: bool) -> DocumentText:
        if document_type(path) == "image":
            if not ocr:
                return DocumentText(pages=[""], page_count=1, engine="none", notes=["OCR is off and an image has no text layer."])
            return DocumentText(pages=[self._tesseract(path)], page_count=1, ocr_pages=[1], engine="tesseract")
        doc = self._pdf_text(path, max_pages)
        if ocr:
            self._ocr_scanned_pages(path, doc)
        return doc

    def _pdf_text(self, path: Path, max_pages: int) -> DocumentText:
        """Text page by page with pdftotext (poppler-utils) when installed, else the Python readers."""
        result = run(["pdftotext", "-layout", "-enc", "UTF-8", "-f", "1", "-l", str(max_pages), str(path), "-"], timeout=60, encoding="utf-8")
        if result.code == 127:
            return text_with_python(path, max_pages)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"pdftotext could not read {path.name}")
        pages = split_pdftotext(result.stdout)
        info = run(["pdfinfo", str(path)], timeout=20, encoding="utf-8")
        match = re.search(r"^Pages:\s+(\d+)", info.stdout, re.MULTILINE)
        count = int(match[1]) if match else (count_pdf_pages(path.read_bytes()) or len(pages))
        return DocumentText(pages=pages, page_count=max(count, len(pages)), engine="pdftotext")

    def _tesseract(self, image: Path) -> str:
        result = run(["tesseract", str(image), "stdout", "--psm", "3"], timeout=90, encoding="utf-8")
        _missing(result, "tesseract")
        if not result.ok:
            lines = result.stderr.strip().splitlines()
            raise RuntimeError(lines[-1] if lines else f"tesseract could not read {image.name}")
        return result.stdout.strip()

    def _ocr_scanned_pages(self, path: Path, doc: DocumentText) -> None:
        """Fill the pages that have no text layer (scans) with OCR. pdftoppm renders those pages when
        poppler-utils is installed; otherwise tesseract reads the pictures the scan is made of."""
        empty = [n for n, text in enumerate(doc.pages, start=1) if len(re.sub(r"\s", "", text)) < EMPTY_PAGE_CHARS]
        if not empty:
            return
        listed = ", ".join(str(n) for n in empty)
        if not shutil.which("tesseract"):
            doc.notes.append(f"Page {listed} has no text layer (a scan); install tesseract to read it.")
            return
        with tempfile.TemporaryDirectory(prefix="herald-os-ocr-") as tmp:
            images: dict[int, Path] = {}
            if shutil.which("pdftoppm"):
                for number in empty:
                    target = Path(tmp, f"page-{number}")
                    rendered = run(["pdftoppm", "-r", "200", "-gray", "-png", "-f", str(number), "-l", str(number), "-singlefile", str(path), str(target)], timeout=60)
                    if rendered.ok and target.with_suffix(".png").exists():
                        images[number] = target.with_suffix(".png")
            else:
                pictures = page_images(path.read_bytes(), limit=max(len(doc.pages), 1))
                if not pictures:
                    doc.notes.append(f"Page {listed} has no text layer and its pictures are in a format this OCR cannot unpack; install poppler-utils (pdftoppm).")
                # Scanners write one picture per page in page order; when the counts differ the pairing is a guess.
                pairs = zip(empty, [pictures[n - 1] for n in empty]) if len(pictures) >= len(doc.pages) else zip(empty, pictures)
                if pictures and len(pictures) < len(doc.pages) and len(pictures) != len(empty):
                    doc.notes.append("Matched the scan's pictures to pages by order; check the page numbers.")
                for number, picture in pairs:
                    target = Path(tmp, f"page-{number}{picture.extension}")
                    target.write_bytes(picture.data)
                    images[number] = target
            for number, image in sorted(images.items()):
                try:
                    doc.pages[number - 1] = self._tesseract(image)
                    doc.ocr_pages.append(number)
                except (RuntimeError, HostNotSupported) as exc:
                    doc.notes.append(f"Page {number} could not be read with OCR: {exc}")
        if doc.ocr_pages:
            doc.engine = f"{doc.engine} + tesseract"

    # --- system control ----------------------------------------------------------------------
    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]:
        level = max(0, min(100, int(percent))) if percent is not None else None
        probe = run(["wpctl", "status"], timeout=5)
        if probe.code != 127:
            # wpctl exits 0 even when there is no default sink ("Translate ID error"), so judge by output.
            def _check(result: ExecResult) -> None:
                text = (result.stdout + result.stderr).lower()
                if not result.ok or "error" in text or "not found" in text:
                    raise RuntimeError("No audio output device is available (PipeWire reports no default sink).")

            if level is not None:
                _check(run(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{level}%"], timeout=5))
            if muted is not None:
                _check(run(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "1" if muted else "0"], timeout=5))
        else:
            if level is not None:
                result = run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{level}%"], timeout=5)
                _missing(result, "wireplumber for wpctl, or pulseaudio-utils for pactl")
            if muted is not None:
                result = run(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "1" if muted else "0"], timeout=5)
                _missing(result, "wireplumber for wpctl, or pulseaudio-utils for pactl")
        return self.audio_status()

    def set_dark_mode(self, enabled: bool) -> None:
        result = run(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", "prefer-dark" if enabled else "default"], timeout=5)
        _missing(result, "glib2 / libglib2.0-bin for gsettings")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not change the colour scheme")

    def open_settings(self, pane: str) -> str:
        key = pane.strip().lower().replace(" ", "_").replace("&", "and")
        target = SETTINGS_PANES.get(key)
        if target is None:
            for name, value in SETTINGS_PANES.items():
                if key in name:
                    target = value
                    break
        if target is None:
            raise ValueError(f"unknown settings pane '{pane}'. Known: {', '.join(sorted(SETTINGS_PANES))}")
        # Only GNOME takes a panel argument; other desktops open their settings hub.
        for argv in (["gnome-control-center", target], ["systemsettings"], ["xfce4-settings-manager"], ["cinnamon-settings"]):
            if shutil.which(argv[0]):
                _detach(argv)
                return target
        raise HostNotSupported("No settings application found (install gnome-control-center or systemsettings).")

    def lock_screen(self) -> None:
        result = run(["loginctl", "lock-session"], timeout=10)
        if result.ok:
            return
        fallback = run(["xdg-screensaver", "lock"], timeout=10)
        if fallback.ok:
            return
        if result.code == 127 and fallback.code == 127:
            raise HostNotSupported("Neither loginctl nor xdg-screensaver is available (install systemd or xdg-utils).")
        raise RuntimeError(result.stderr.strip() or fallback.stderr.strip() or "could not lock the screen")

    def sleep_display(self) -> None:
        # niri, Herald OS Linux's compositor, turns the screens back on at the next key press or mouse move.
        result = run(["niri", "msg", "action", "power-off-monitors"], timeout=10)
        _missing(result, "niri (the Herald OS Linux session)")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not put the display to sleep")

    def set_wifi_power(self, enabled: bool) -> None:
        result = run(["nmcli", "radio", "wifi", "on" if enabled else "off"], timeout=15)
        _missing(result, "network-manager")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not change Wi-Fi power")

    # --- the menu bar's quick panels ------------------------------------------------------------
    def wifi_networks(self) -> list[dict[str, Any]]:
        result = run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL,CHAN,RATE,SECURITY", "dev", "wifi", "list"], timeout=25)
        _missing(result, "network-manager")
        best: dict[str, dict[str, Any]] = {}
        for network in parse_nmcli_wifi(result.stdout):
            ssid = network.get("ssid")
            if ssid and (ssid not in best or (network.get("signal") or 0) > (best[ssid].get("signal") or 0) or network["active"]):
                best[ssid] = {**network, "active": network["active"] or best.get(ssid, {}).get("active", False)}
        return sorted(best.values(), key=lambda n: (not n["active"], -(n.get("signal") or 0)))

    def wifi_connect(self, ssid: str, password: str | None) -> None:
        result = run(["nmcli", "device", "wifi", "connect", ssid, *(["password", password] if password else [])], timeout=60)
        _missing(result, "network-manager")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"could not join {ssid}")

    def bluetooth_set_power(self, enabled: bool) -> None:
        result = run(["bluetoothctl", "power", "on" if enabled else "off"], timeout=15)
        _missing(result, "bluez")
        if not result.ok or "fail" in result.stdout.lower():
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "could not switch Bluetooth")

    def bluetooth_connect(self, device: str, connect: bool) -> dict[str, Any]:
        listed = run(["bluetoothctl", "devices"], timeout=10)
        _missing(listed, "bluez")
        rows = parse_bluetoothctl_device_rows(listed.stdout)
        match = pick_device(rows, device)
        if match is None:
            raise ValueError(f"no Bluetooth device matches {device!r}; known: {', '.join(name for _, name in rows) or 'none'}")
        address, name = match
        result = run(["bluetoothctl", "connect" if connect else "disconnect", address], timeout=40)
        if not result.ok or "failed" in result.stdout.lower():
            raise RuntimeError(result.stdout.strip() or result.stderr.strip() or f"could not reach {name}")
        return {"device": name, "address": address, "connected": connect}

    def audio_devices(self) -> dict[str, Any]:
        sinks = run(["pactl", "-f", "json", "list", "sinks"], timeout=10)
        _missing(sinks, "pulseaudio-utils for pactl")
        sources = run(["pactl", "-f", "json", "list", "sources"], timeout=10)
        default_sink = run(["pactl", "get-default-sink"], timeout=5).stdout
        default_source = run(["pactl", "get-default-source"], timeout=5).stdout
        return {"outputs": parse_pactl_json(sinks.stdout, default_sink), "inputs": parse_pactl_json(sources.stdout, default_source)}

    def set_audio_output(self, device: str) -> dict[str, Any]:
        outputs = self.audio_devices()["outputs"]
        match = pick_device([(o["id"], o["name"]) for o in outputs], device)
        if match is None:
            raise ValueError(f"no sound output matches {device!r}; outputs: {', '.join(o['name'] for o in outputs) or 'none'}")
        result = run(["pactl", "set-default-sink", match[0]], timeout=10)
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not switch the output")
        return {"output": match[1]}

    def set_brightness(self, percent: int) -> None:
        result = run(["brightnessctl", "--class=backlight", "set", f"{max(1, min(100, int(percent)))}%"], timeout=10)
        _missing(result, "brightnessctl")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "this screen has no adjustable backlight")

    def power_profiles(self) -> dict[str, Any]:
        result = run(["powerprofilesctl", "list"], timeout=10)
        _missing(result, "power-profiles-daemon")
        return parse_power_profiles(result.stdout)

    def set_power_profile(self, profile: str) -> None:
        result = run(["powerprofilesctl", "set", profile], timeout=10)
        _missing(result, "power-profiles-daemon")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or f"could not switch to {profile}")

    # --- destructive ------------------------------------------------------------------------
    def kill(self, pid: int, force: bool) -> None:
        os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)

    def trash(self, paths: Sequence[Path]) -> None:
        # The freedesktop trash keeps the operation reversible; never `rm`.
        result = run(["gio", "trash", "--", *(str(p) for p in paths)], timeout=30)
        _missing(result, "glib2 / libglib2.0-bin for gio")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not move items to the trash")

    def notify(self, title: str, body: str) -> None:
        result = run(["notify-send", "--app-name=Herald OS", "--", title, body], timeout=10)
        _missing(result, "libnotify for notify-send")
        if not result.ok:
            raise RuntimeError(result.stderr.strip() or "could not send the notification")


__all__ = [
    "KIND_EXTENSIONS", "LOG_PRIORITIES", "LinuxHost", "SETTINGS_PANES", "matches_search",
    "parse_bluetoothctl_devices", "parse_bluetoothctl_show", "parse_cpuinfo_model", "parse_df", "parse_gsettings_value",
    "parse_ip_addr", "parse_ip_route", "parse_meminfo", "parse_nmcli_dev_status", "parse_nmcli_wifi",
    "parse_os_release", "parse_pactl_volume", "parse_ss", "parse_wpctl_volume", "search_extensions",
    "search_time_bounds", "split_nmcli_terse",
]
