"""The capability contract every platform adapter implements."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Sequence

from ..documents import DocumentText


class HostNotSupported(RuntimeError):
    """Raised by adapters for platforms Herald OS does not implement yet."""


@dataclass
class ProcessRow:
    pid: int
    ppid: int
    user: str
    cpu_percent: float
    mem_percent: float
    rss_bytes: int
    command: str

    @property
    def name(self) -> str:
        return self.command.rsplit("/", 1)[-1]

    def to_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid, "ppid": self.ppid, "user": self.user, "name": self.name,
            "cpu_percent": self.cpu_percent, "mem_percent": self.mem_percent,
            "rss_bytes": self.rss_bytes, "command": self.command,
        }


@dataclass
class PortListener:
    pid: int
    command: str
    user: str
    port: int
    protocol: str

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class FoundFile:
    path: str
    size: int | None = None
    modified: str | None = None
    kind: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class FileSearch:
    """Structured search request; adapters translate it to the platform indexer."""

    text: str | None = None
    name: str | None = None
    kind: Literal["any", "image", "screenshot", "document", "pdf", "video", "audio", "folder", "code", "archive"] = "any"
    since: str | None = None     # ISO date / datetime, inclusive.
    until: str | None = None
    scope: str | None = None     # Directory to search under.
    extensions: Sequence[str] = field(default_factory=tuple)
    limit: int = 50


@dataclass
class AppInfo:
    name: str
    path: str
    bundle_id: str | None = None
    running: bool | None = None
    pid: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


class HostAdapter(ABC):
    platform: str = "unknown"

    def available(self) -> bool:
        return True

    # --- read -------------------------------------------------------------------------------
    @abstractmethod
    def system_info(self) -> dict[str, Any]: ...

    @abstractmethod
    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]: ...

    @abstractmethod
    def find_processes(self, name: str, limit: int) -> list[ProcessRow]: ...

    @abstractmethod
    def listeners_on_port(self, port: int) -> list[PortListener]: ...

    @abstractmethod
    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]: ...

    @abstractmethod
    def find_files(self, query: FileSearch) -> list[FoundFile]: ...

    @abstractmethod
    def installed_apps(self) -> list[AppInfo]: ...

    @abstractmethod
    def running_apps(self) -> list[AppInfo]: ...

    def resolve_app(self, name: str) -> AppInfo | None:
        """The installed app ``name`` refers to, or None. Hosts may also match bundle ids or executables."""
        needle = name.strip().lower()
        return next((app for app in self.installed_apps() if app.name.lower() == needle), None)

    # --- act --------------------------------------------------------------------------------
    @abstractmethod
    def open_app(self, name: str, args: Sequence[str] = ()) -> None: ...

    @abstractmethod
    def open_url(self, url: str, app: str | None = None) -> None: ...

    @abstractmethod
    def open_path(self, path: Path, app: str | None = None) -> None: ...

    @abstractmethod
    def reveal(self, path: Path) -> None: ...

    @abstractmethod
    def quit_app(self, name: str, force: bool) -> None: ...

    # --- system state (read) -----------------------------------------------------------------
    @abstractmethod
    def network_status(self) -> dict[str, Any]: ...

    @abstractmethod
    def bluetooth_status(self) -> dict[str, Any]: ...

    @abstractmethod
    def audio_status(self) -> dict[str, Any]: ...

    @abstractmethod
    def appearance_status(self) -> dict[str, Any]: ...

    @abstractmethod
    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]: ...

    def crash_reports(self, limit: int) -> list[dict[str, Any]]:
        """Recent crashes of the user's programs, newest first."""
        raise HostNotSupported(f"crash reports are not available on {self.platform}")

    def crash_report(self, ref: str) -> dict[str, Any]:
        """The facts of one crash: ``ref`` is a report path (macOS) or the crashed pid (Linux)."""
        raise HostNotSupported(f"crash reports are not available on {self.platform}")

    def read_document(self, path: Path, max_pages: int, ocr: bool) -> DocumentText:
        """The text of a PDF, page by page (pages that are pictures of text through OCR when ``ocr``),
        or of an image of a document (OCR). Reads at most ``max_pages`` pages and counts them all."""
        raise HostNotSupported(f"reading documents is not available on {self.platform}")

    # --- system control (act / mutate) ------------------------------------------------------
    @abstractmethod
    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]: ...

    @abstractmethod
    def set_dark_mode(self, enabled: bool) -> None: ...

    @abstractmethod
    def open_settings(self, pane: str) -> str: ...

    @abstractmethod
    def lock_screen(self) -> None: ...

    @abstractmethod
    def sleep_display(self) -> None: ...

    @abstractmethod
    def set_wifi_power(self, enabled: bool) -> None: ...

    # --- the menu bar's quick panels (Herald OS Linux; other hosts say so) ------------------
    def wifi_networks(self) -> list[dict[str, Any]]:
        raise HostNotSupported(f"listing Wi-Fi networks is not available on {self.platform}")

    def wifi_connect(self, ssid: str, password: str | None) -> None:
        raise HostNotSupported(f"joining Wi-Fi networks is not available on {self.platform}; use the system's network settings")

    def bluetooth_set_power(self, enabled: bool) -> None:
        raise HostNotSupported(f"switching Bluetooth is not available on {self.platform}")

    def bluetooth_connect(self, device: str, connect: bool) -> dict[str, Any]:
        raise HostNotSupported(f"connecting Bluetooth devices is not available on {self.platform}")

    def audio_devices(self) -> dict[str, Any]:
        raise HostNotSupported(f"listing sound devices is not available on {self.platform}")

    def set_audio_output(self, device: str) -> dict[str, Any]:
        raise HostNotSupported(f"choosing the sound output is not available on {self.platform}")

    def set_brightness(self, percent: int) -> None:
        raise HostNotSupported(f"setting the brightness is not available on {self.platform}")

    def power_profiles(self) -> dict[str, Any]:
        raise HostNotSupported(f"power modes are not available on {self.platform}")

    def set_power_profile(self, profile: str) -> None:
        raise HostNotSupported(f"power modes are not available on {self.platform}")

    # --- destructive ------------------------------------------------------------------------
    @abstractmethod
    def kill(self, pid: int, force: bool) -> None: ...

    @abstractmethod
    def trash(self, paths: Sequence[Path]) -> None: ...

    @abstractmethod
    def notify(self, title: str, body: str) -> None: ...
