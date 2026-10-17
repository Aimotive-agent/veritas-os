"""The niri config the Herald OS session starts with: Herald's own file, never the person's."""

import importlib.machinery
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_LOADER = importlib.machinery.SourceFileLoader("herald_os_session_cli", str(ROOT / "linux" / "bin" / "herald-os"))
_SPEC = importlib.util.spec_from_loader("herald_os_session_cli", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

TEMPLATE = (ROOT / "linux" / "niri" / "config.kdl").read_text()
PERSONAL = 'input { keyboard { xkb { layout "de"; } } }\nbinds { Mod+T { spawn "alacritty"; } }\n'
MIGRATION = ROOT / "linux" / "migrations" / "2026-10-08-herald-niri-config.sh"


def keymap_home(tmp_path, monkeypatch):
    niri = tmp_path / ".config" / "niri"
    niri.mkdir(parents=True)
    (niri / "config.kdl").write_text(PERSONAL)
    monkeypatch.setattr(cli, "CONFIG_DIR", tmp_path / ".config" / "herald-os")
    monkeypatch.setattr(cli, "KEYMAP_FILE", tmp_path / ".config" / "herald-os" / "keymap")
    monkeypatch.setattr(cli, "NIRI_CONFIG", niri / "herald-os.kdl")
    return niri


def test_the_template_next_to_the_command_comes_first():
    assert cli.NIRI_TEMPLATES[0] == ROOT / "linux" / "niri" / "config.kdl"


def test_keymaps_render_into_herald_s_own_file(tmp_path, monkeypatch):
    niri = keymap_home(tmp_path, monkeypatch)
    assert cli.keymap_cmd(["apply"]) == 0
    assert (niri / "herald-os.kdl").read_text() == TEMPLATE
    monkeypatch.setattr(cli.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert cli.keymap_cmd(["omarchy"]) == 0
    assert (niri / "herald-os.kdl").read_text() == cli.render_keymap(TEMPLATE, "omarchy")
    assert (niri / "config.kdl").read_text() == PERSONAL


def test_an_unchanged_config_is_not_written_again(tmp_path, monkeypatch):
    niri = keymap_home(tmp_path, monkeypatch)
    cli.keymap_cmd(["apply"])
    before = (niri / "herald-os.kdl").stat()
    cli.keymap_cmd(["apply"])
    after = (niri / "herald-os.kdl").stat()
    assert (before.st_ino, before.st_mtime_ns) == (after.st_ino, after.st_mtime_ns)


def stub(bin_dir: Path, name: str, body: str) -> None:
    (bin_dir / name).write_text(f"#!/bin/sh\n{body}\n")
    (bin_dir / name).chmod(0o755)


def session_env(tmp_path):
    """A fresh account with herald-os on the PATH and stand-ins for niri and cage that record how they ran."""
    home, bin_dir = tmp_path / "home", tmp_path / "bin"
    home.mkdir()
    bin_dir.mkdir()
    (bin_dir / "herald-os").symlink_to(ROOT / "linux" / "bin" / "herald-os")
    for name in ("niri", "cage"):
        stub(bin_dir, name, f'printf "%s\\n" "$@" >"$HOME/{name}.args"')
    # The theme engine is not under test (and must not reach a real session's socket).
    stub(bin_dir, "herald-os-theme", "exit 0")
    env = {
        "HOME": str(home),
        "XDG_RUNTIME_DIR": str(tmp_path / "run"),
        "PATH": os.pathsep.join([str(bin_dir), str(Path(sys.executable).parent), "/usr/bin", "/bin"]),
        "HERALD_OS_NIRI_NESTED": "0",
    }
    return home, env


def test_the_session_starts_niri_with_herald_s_config_on_a_fresh_account(tmp_path):
    home, env = session_env(tmp_path)
    niri = home / ".config" / "niri"
    niri.mkdir(parents=True)
    (niri / "config.kdl").write_text(PERSONAL)
    subprocess.run(["bash", str(ROOT / "linux" / "session" / "herald-os-compositor")], env=env, check=True, timeout=60)
    assert (home / "niri.args").read_text().split("\n")[:3] == ["--session", "--config", str(niri / "herald-os.kdl")]
    assert (niri / "herald-os.kdl").read_text() == TEMPLATE
    assert (niri / "config.kdl").read_text() == PERSONAL
    # Everything the config includes exists before niri reads it.
    assert all((niri / name).is_file() for name in ("theme.kdl", "outputs.kdl", "local.kdl"))
    # Nested niri (no hardware GL) reads the same file.
    subprocess.run(["bash", str(ROOT / "linux" / "session" / "herald-os-niri-nested")], env=env, check=True, timeout=60)
    assert (home / "niri.args").read_text().split("\n")[:2] == ["--config", str(niri / "herald-os.kdl")]


def test_without_herald_s_config_the_shell_runs_under_cage_not_bare_niri(tmp_path):
    home, env = session_env(tmp_path)
    (tmp_path / "bin" / "herald-os").unlink()
    stub(tmp_path / "bin", "herald-os", "exit 1")
    subprocess.run(["bash", str(ROOT / "linux" / "session" / "herald-os-compositor")], env=env, check=True, timeout=60)
    assert not (home / "niri.args").exists()
    assert (home / "cage.args").read_text().split("\n")[0] == "-s"


def test_the_migration_points_herald_s_old_config_at_the_new_one(tmp_path):
    home, env = session_env(tmp_path)
    niri = home / ".config" / "niri"
    niri.mkdir(parents=True)
    (niri / "config.kdl").write_text(TEMPLATE)
    for _ in range(2):
        subprocess.run(["bash", str(MIGRATION)], env=env, check=True, timeout=60)
    assert (niri / "herald-os.kdl").read_text() == TEMPLATE
    old = (niri / "config.kdl").read_text().splitlines()
    assert old[0] == TEMPLATE.splitlines()[0] and old[-1] == 'include "herald-os.kdl"'
    assert old.count('include "herald-os.kdl"') == 1


def test_the_migration_leaves_a_personal_config_alone(tmp_path):
    home, env = session_env(tmp_path)
    niri = home / ".config" / "niri"
    niri.mkdir(parents=True)
    (niri / "config.kdl").write_text(PERSONAL)
    subprocess.run(["bash", str(MIGRATION)], env=env, check=True, timeout=60)
    assert (niri / "config.kdl").read_text() == PERSONAL
    assert (niri / "herald-os.kdl").read_text() == TEMPLATE
