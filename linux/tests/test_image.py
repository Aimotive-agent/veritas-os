"""Telling the Herald OS image from other bootc and ostree systems (Silverblue, Bazzite, Bluefin)."""

import importlib.machinery
import importlib.util
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_LOADER = importlib.machinery.SourceFileLoader("herald_os_image_cli", str(ROOT / "linux" / "bin" / "herald-os"))
_SPEC = importlib.util.spec_from_loader("herald_os_image_cli", _LOADER)
cli = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cli)

FEDORA = 'NAME="Fedora Linux"\nVERSION_ID=44\nID=fedora\n'
SILVERBLUE = FEDORA + 'VARIANT="Silverblue"\nVARIANT_ID=silverblue\n'
HERALD = FEDORA + "IMAGE_ID=herald-os\n"
# Each machine: whether it booted from an image, its /usr/lib/os-release and whether the shell is in
# /usr/share/herald-os/app, then whether it is the Herald OS image.
MACHINES = {
    "herald-os": ((True, HERALD, False), True),
    "herald-os, quoted": ((True, FEDORA + 'IMAGE_ID="herald-os"\n', False), True),
    "herald-os before IMAGE_ID": ((True, FEDORA, True), True),
    "silverblue": ((True, SILVERBLUE, False), False),
    "bazzite": ((True, FEDORA + "IMAGE_ID=bazzite\n", False), False),
    "fedora workstation": ((False, FEDORA, False), False),
    "herald-os as a container": ((False, HERALD, True), False),
}


def machine(tmp_path, booted: bool, release: str, shell: bool) -> dict[str, Path]:
    paths = {"booted": tmp_path / "run" / "ostree-booted", "release": tmp_path / "usr" / "lib" / "os-release", "shell": tmp_path / "app.asar"}
    paths["release"].parent.mkdir(parents=True)
    paths["release"].write_text(release)
    if booted:
        paths["booted"].parent.mkdir(parents=True)
        paths["booted"].write_text("")
    if shell:
        paths["shell"].write_text("")
    return paths


def use(monkeypatch, paths: dict[str, Path]) -> None:
    monkeypatch.setattr(cli, "OSTREE_BOOTED", paths["booted"])
    monkeypatch.setattr(cli, "OS_RELEASES", (paths["release"].parent.parent / "etc-os-release", paths["release"]))
    monkeypatch.setattr(cli, "IMAGE_SHELL", paths["shell"])


@pytest.mark.parametrize("name", MACHINES)
def test_only_the_herald_os_image_is_the_image(name, tmp_path, monkeypatch):
    setup, expected = MACHINES[name]
    use(monkeypatch, machine(tmp_path, *setup))
    assert cli.is_image() is expected


@pytest.mark.parametrize("name", MACHINES)
def test_the_updater_agrees(name, tmp_path):
    setup, expected = MACHINES[name]
    paths = machine(tmp_path, *setup)
    script = (ROOT / "linux" / "bin" / "herald-os-update").read_text()
    function = re.search(r"^is_herald_image\(\) \{\n.*?^\}\n", script, re.M | re.S).group(0)
    found = subprocess.run(
        ["bash", "-c", f'OSTREE_BOOTED="{paths["booted"]}"\nOS_RELEASE=("{tmp_path / "etc-os-release"}" "{paths["release"]}")\nIMAGE_SHELL="{paths["shell"]}"\n{function}is_herald_image'],
        check=False,
    )
    assert (found.returncode == 0) is expected


def test_on_silverblue_rollback_and_channel_never_run_bootc(tmp_path, monkeypatch):
    use(monkeypatch, machine(tmp_path, True, SILVERBLUE, False))
    monkeypatch.setattr(cli, "CONFIG_DIR", tmp_path / "config")
    ran = []
    monkeypatch.setattr(cli.subprocess, "call", lambda argv, **kwargs: ran.append(argv) or 0)
    monkeypatch.setattr(cli, "sh", lambda argv, **kwargs: ran.append(argv) or subprocess.CompletedProcess(argv, 0, "{}", ""))
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    with pytest.raises(SystemExit) as stopped:
        cli.rollback()
    assert stopped.value.code == 2
    assert cli.main(["channel", "edge"]) == 0
    assert (tmp_path / "config" / "channel").read_text() == "edge\n"
    assert not [argv for argv in ran if "bootc" in argv]


def test_the_image_build_names_the_image_in_os_release():
    packages = (ROOT / "linux" / "image" / "packages.sh").read_text()
    assert "echo 'IMAGE_ID=herald-os' >>/usr/lib/os-release" in packages
