"""Parsers shared by the POSIX adapters (macOS and Linux). Pure functions only: no subprocesses."""

from __future__ import annotations

import re

from .base import ProcessRow


def parse_ps(text: str) -> list[ProcessRow]:
    """``ps -o pid=,ppid=,user=,%cpu=,%mem=,rss=,comm=`` lines -> rows (rss reported in KiB by ps)."""
    rows: list[ProcessRow] = []
    for line in text.splitlines():
        match = re.match(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$", line)
        if not match:
            continue
        rows.append(ProcessRow(
            pid=int(match[1]), ppid=int(match[2]), user=match[3], cpu_percent=float(match[4]),
            mem_percent=float(match[5]), rss_bytes=int(match[6]) * 1024, command=match[7].strip(),
        ))
    return rows


def parse_du(text: str) -> list[tuple[int, str]]:
    """``du -k`` lines (``SIZE<TAB>PATH``) -> (bytes, path)."""
    rows: list[tuple[int, str]] = []
    for line in text.splitlines():
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        try:
            rows.append((int(parts[0]) * 1024, parts[1]))
        except ValueError:
            continue
    return rows


__all__ = ["parse_ps", "parse_du"]
