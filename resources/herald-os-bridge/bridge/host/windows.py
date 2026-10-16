"""Windows host adapter: typed stub. See docs/internal/ROADMAP.md for the planned implementation
(PowerShell ``Get-Process``, ``Get-NetTCPConnection``, Windows Search, ``Start-Process``)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Sequence

from ..documents import DocumentText
from .base import AppInfo, FileSearch, FoundFile, HostAdapter, HostNotSupported, PortListener, ProcessRow

_MESSAGE = "The Herald OS system bridge does not support Windows yet."


class WindowsHost(HostAdapter):
    platform = "win32"

    def available(self) -> bool:
        return False

    def system_info(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def list_processes(self, sort: Literal["cpu", "memory"], limit: int) -> list[ProcessRow]:
        raise HostNotSupported(_MESSAGE)

    def find_processes(self, name: str, limit: int) -> list[ProcessRow]:
        raise HostNotSupported(_MESSAGE)

    def listeners_on_port(self, port: int) -> list[PortListener]:
        raise HostNotSupported(_MESSAGE)

    def disk_usage(self, path: Path, depth: int, limit: int, timeout: float) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def find_files(self, query: FileSearch) -> list[FoundFile]:
        raise HostNotSupported(_MESSAGE)

    def installed_apps(self) -> list[AppInfo]:
        raise HostNotSupported(_MESSAGE)

    def running_apps(self) -> list[AppInfo]:
        raise HostNotSupported(_MESSAGE)

    def open_app(self, name: str, args: Sequence[str] = ()) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_url(self, url: str, app: str | None = None) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_path(self, path: Path, app: str | None = None) -> None:
        raise HostNotSupported(_MESSAGE)

    def reveal(self, path: Path) -> None:
        raise HostNotSupported(_MESSAGE)

    def quit_app(self, name: str, force: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def read_document(self, path: Path, max_pages: int, ocr: bool) -> DocumentText:
        raise HostNotSupported(_MESSAGE)

    def network_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def bluetooth_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def audio_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def appearance_status(self) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def system_logs(self, minutes: int, level: str, process: str | None, limit: int) -> list[str]:
        raise HostNotSupported(_MESSAGE)

    def set_volume(self, percent: int | None, muted: bool | None) -> dict[str, Any]:
        raise HostNotSupported(_MESSAGE)

    def set_dark_mode(self, enabled: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def open_settings(self, pane: str) -> str:
        raise HostNotSupported(_MESSAGE)

    def lock_screen(self) -> None:
        raise HostNotSupported(_MESSAGE)

    def sleep_display(self) -> None:
        raise HostNotSupported(_MESSAGE)

    def set_wifi_power(self, enabled: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def kill(self, pid: int, force: bool) -> None:
        raise HostNotSupported(_MESSAGE)

    def trash(self, paths: Sequence[Path]) -> None:
        raise HostNotSupported(_MESSAGE)

    def notify(self, title: str, body: str) -> None:
        raise HostNotSupported(_MESSAGE)
