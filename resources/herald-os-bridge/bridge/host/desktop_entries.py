"""freedesktop.org ``.desktop`` entries: the Linux equivalent of an ``.app`` bundle.

Pure parsing (``parse_desktop_entry``, ``strip_exec_codes``) is separated from the filesystem scan
(``scan_desktop_entries``) so the parsers can be unit-tested with fixture strings on any platform.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

DEFAULT_DESKTOP_DIRS: tuple[str, ...] = (
    # User-level entries take precedence over system ones (XDG basedir order).
    "~/.local/share/applications",
    "~/.local/share/flatpak/exports/share/applications",
    "/usr/local/share/applications",
    "/usr/share/applications",
    "/var/lib/flatpak/exports/share/applications",
)

# Field codes from the Desktop Entry Specification that stand for launch-time arguments.
_EXEC_CODE = re.compile(r"%[fFuUdDnNickvm]")
_LOCALISED_KEY = re.compile(r"^([A-Za-z0-9-]+)(\[[^\]]+\])?$")


@dataclass
class DesktopEntry:
    name: str
    exec_cmd: str
    path: str
    icon: str | None = None
    categories: list[str] = field(default_factory=list)
    no_display: bool = False
    hidden: bool = False
    terminal: bool = False
    startup_wm_class: str | None = None
    only_show_in: list[str] = field(default_factory=list)
    not_show_in: list[str] = field(default_factory=list)
    generic_name: str | None = None
    comment: str | None = None

    @property
    def desktop_id(self) -> str:
        """The file basename without ``.desktop`` (``org.mozilla.firefox``, ``code``)."""
        return Path(self.path).name.removesuffix(".desktop")

    @property
    def exec_argv(self) -> list[str]:
        try:
            return shlex.split(self.exec_cmd)
        except ValueError:
            return self.exec_cmd.split()

    @property
    def exec_basename(self) -> str | None:
        argv = self.exec_argv
        return Path(argv[0]).name if argv else None

    def process_names(self) -> set[str]:
        """Lower-case process names a running instance of this entry is likely to have (``comm``)."""
        names: set[str] = set()
        argv = self.exec_argv
        if argv:
            program = Path(argv[0]).name
            # Wrappers do not tell us what really runs: look for the wrapped program instead.
            if program in ("env", "sh", "bash", "nohup", "exec"):
                for token in argv[1:]:
                    if token.startswith("-") or "=" in token:
                        continue
                    program = Path(token).name
                    break
            elif program == "flatpak":
                command = next((t.split("=", 1)[1] for t in argv if t.startswith("--command=")), None)
                program = Path(command).name if command else ""
            if program:
                names.add(program.lower())
        if self.startup_wm_class:
            names.add(self.startup_wm_class.lower())
        return names


def strip_exec_codes(exec_cmd: str) -> str:
    """Remove ``%f``/``%u``/... field codes and unescape ``%%``; collapse the leftover whitespace."""
    cleaned = _EXEC_CODE.sub("", exec_cmd).replace("%%", "%")
    return " ".join(cleaned.split())


def _as_bool(value: str | None) -> bool:
    return (value or "").strip().lower() == "true"


def _as_list(value: str | None) -> list[str]:
    return [item for item in (value or "").split(";") if item]


def parse_desktop_entry(text: str, path: str) -> DesktopEntry | None:
    """Parse the ``[Desktop Entry]`` group of a ``.desktop`` file. Returns ``None`` for anything that is
    not a launchable application (``Type`` other than ``Application``, missing ``Name``/``Exec``)."""
    values: dict[str, str] = {}
    in_group = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            if in_group:
                break  # Only the main group matters; actions follow it.
            in_group = line == "[Desktop Entry]"
            continue
        if not in_group or "=" not in line:
            continue
        key, value = line.split("=", 1)
        match = _LOCALISED_KEY.match(key.strip())
        if not match:
            continue
        base, locale = match[1], match[2]
        if locale:
            # Prefer the unlocalised value; keep a localised Name only if no plain one appears.
            values.setdefault(f"{base}[]", value.strip())
            continue
        values[base] = value.strip()
    if values.get("Type", "Application") != "Application":
        return None
    name = values.get("Name") or values.get("Name[]")
    exec_cmd = values.get("Exec")
    if not name or not exec_cmd:
        return None
    return DesktopEntry(
        name=name,
        exec_cmd=strip_exec_codes(exec_cmd),
        path=path,
        icon=values.get("Icon") or None,
        categories=_as_list(values.get("Categories")),
        no_display=_as_bool(values.get("NoDisplay")),
        hidden=_as_bool(values.get("Hidden")),
        terminal=_as_bool(values.get("Terminal")),
        startup_wm_class=values.get("StartupWMClass") or None,
        only_show_in=_as_list(values.get("OnlyShowIn")),
        not_show_in=_as_list(values.get("NotShowIn")),
        generic_name=values.get("GenericName") or values.get("GenericName[]"),
        comment=values.get("Comment") or values.get("Comment[]"),
    )


def current_desktops() -> set[str]:
    """``$XDG_CURRENT_DESKTOP`` is a colon-separated list (``ubuntu:GNOME``)."""
    return {d.strip().lower() for d in os.environ.get("XDG_CURRENT_DESKTOP", "").split(":") if d.strip()}


def entry_is_visible(entry: DesktopEntry, desktops: Iterable[str] | None = None) -> bool:
    """Loose visibility rule: drop ``NoDisplay``/``Hidden`` entries and ``OnlyShowIn``/``NotShowIn``
    mismatches, but only when we actually know the current desktop."""
    if entry.no_display or entry.hidden:
        return False
    known = {d.lower() for d in (desktops if desktops is not None else current_desktops())}
    if not known:
        return True
    if entry.only_show_in and not known.intersection(d.lower() for d in entry.only_show_in):
        return False
    if entry.not_show_in and known.intersection(d.lower() for d in entry.not_show_in):
        return False
    return True


def scan_desktop_entries(dirs: Sequence[str] = DEFAULT_DESKTOP_DIRS, *, include_hidden: bool = False, desktops: Iterable[str] | None = None) -> list[DesktopEntry]:
    """Walk the application directories; the first directory that defines a desktop id wins."""
    entries: dict[str, DesktopEntry] = {}
    for directory in dirs:
        root = Path(os.path.expanduser(directory))
        if not root.is_dir():
            continue
        try:
            files = sorted(p for p in root.rglob("*.desktop") if p.is_file())
        except OSError:
            continue
        for file in files:
            try:
                text = file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            entry = parse_desktop_entry(text, str(file))
            if entry is None:
                continue
            if not include_hidden and not entry_is_visible(entry, desktops):
                continue
            entries.setdefault(entry.desktop_id, entry)
    return sorted(entries.values(), key=lambda e: e.name.lower())


__all__ = [
    "DEFAULT_DESKTOP_DIRS", "DesktopEntry", "current_desktops", "entry_is_visible",
    "parse_desktop_entry", "scan_desktop_entries", "strip_exec_codes",
]
