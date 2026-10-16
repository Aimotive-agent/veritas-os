"""Per-platform host adapters. The tool layer never branches on ``sys.platform``."""

from __future__ import annotations

import sys

from .base import HostAdapter, HostNotSupported

_adapter: HostAdapter | None = None


def host() -> HostAdapter:
    global _adapter
    if _adapter is None:
        if sys.platform == "darwin":
            from .darwin import DarwinHost

            _adapter = DarwinHost()
        elif sys.platform.startswith("win"):
            from .windows import WindowsHost

            _adapter = WindowsHost()
        else:
            from .linux import LinuxHost

            _adapter = LinuxHost()
    return _adapter


def host_available() -> bool:
    return host().available()


__all__ = ["HostAdapter", "HostNotSupported", "host", "host_available"]
