"""The install catalog (linux/catalog/*.json) and herald-os-catalog's method choice."""

import importlib.machinery
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_LOADER = importlib.machinery.SourceFileLoader("herald_os_catalog", str(ROOT / "linux" / "bin" / "herald-os-catalog"))
_SPEC = importlib.util.spec_from_loader("herald_os_catalog", _LOADER)
cat = importlib.util.module_from_spec(_SPEC)
_LOADER.exec_module(cat)

GROUPS = cat.load_catalog(ROOT / "linux" / "catalog")
ENTRIES = {entry["id"]: entry for group in GROUPS for entry in group["entries"]}
MAC_KINDS = {"brew", "brew-cask"}


def fedora(**overrides):
    return {"arch": "x86_64", "kvm": True, "pm": "dnf", "aur": None, "flatpak": True, "image": False, "omarchy": False, **overrides}


def arch_linux(**overrides):
    return fedora(**{"pm": "pacman", "aur": "yay", **overrides})


def test_groups_load_in_order_with_the_planned_sections():
    assert [group["id"] for group in GROUPS] == ["ai", "developer", "editors", "terminals", "gaming", "windows", "media", "services", "webapps"]


def test_entries_are_well_formed():
    seen = set()
    for group in GROUPS:
        for entry in group["entries"]:
            assert entry["id"] not in seen, f"duplicate id {entry['id']}"
            seen.add(entry["id"])
            assert entry["label"] and entry["install"], entry["id"]
            for method in entry["install"]:
                assert method["kind"] in cat.LINUX_KINDS | MAC_KINDS, (entry["id"], method["kind"])
                assert method.get("ref"), entry["id"]
                if method["kind"] == "script":
                    assert method["ref"] in cat.RECIPES, method["ref"]
                if method["kind"] in ("webapp", "link"):
                    assert method["ref"].startswith("https://"), entry["id"]


def test_coding_agents_open_in_the_terminal():
    agents = [entry for entry in ENTRIES.values() if entry.get("terminal")]
    assert {entry["id"] for entry in agents} == {"claude-code", "codex", "opencode", "gemini-cli", "copilot-cli"}
    assert all(entry.get("bin") for entry in agents)


def test_fedora_prefers_flatpak_and_dnf():
    assert cat.pick_method(ENTRIES["steam"], fedora())[0]["kind"] == "flatpak"
    assert cat.pick_method(ENTRIES["helix"], fedora())[0]["kind"] == "dnf"
    assert cat.pick_method(ENTRIES["1password"], fedora())[0]["kind"] == "script"


def test_arch_uses_pacman_and_the_aur():
    assert cat.pick_method(ENTRIES["helix"], arch_linux())[0]["kind"] == "pacman"
    assert cat.pick_method(ENTRIES["ghostty"], arch_linux())[0]["kind"] == "pacman"
    assert cat.pick_method(ENTRIES["1password"], arch_linux())[0]["kind"] == "aur"
    # Without an AUR helper the download page is the honest fallback.
    assert cat.pick_method(ENTRIES["1password"], arch_linux(aur=None))[0]["kind"] == "link"


def test_arm_machines_skip_x86_only_software():
    method, reason = cat.pick_method(ENTRIES["steam"], fedora(arch="aarch64"))
    assert method is None and reason == "needs an x86_64 PC"
    assert cat.pick_method(ENTRIES["prism-launcher"], fedora(arch="aarch64"))[0]["kind"] == "flatpak"
    assert cat.pick_method(ENTRIES["1password"], fedora(arch="aarch64"))[0]["kind"] == "link"


def test_windows_needs_kvm():
    method, reason = cat.pick_method(ENTRIES["windows"], fedora(kvm=False))
    assert method is None and "KVM" in reason
    assert cat.pick_method(ENTRIES["windows"], fedora())[0]["ref"] == "windows"


def test_the_image_has_no_system_packages():
    image = fedora(pm=None, image=True)
    method, reason = cat.pick_method(ENTRIES["helix"], image)
    assert method is None and reason == "needs dnf"
    assert cat.pick_method(ENTRIES["zed"], image)[0]["kind"] == "flatpak"
    assert cat.pick_method(ENTRIES["claude-code"], image)[0]["kind"] == "npm"
    assert cat.pick_method(ENTRIES["node"], image)[0]["kind"] == "mise"


def test_macos_only_methods_are_skipped_on_linux():
    assert cat.pick_method(ENTRIES["lm-studio"], fedora())[0]["kind"] == "link"
    assert cat.pick_method(ENTRIES["ollama"], fedora())[0]["kind"] == "script"


def test_package_commands_per_manager(monkeypatch):
    monkeypatch.setattr(cat, "sudo", lambda: ["sudo", "-n"])
    assert cat.pkg_command("install", ["helix"], "dnf") == ["sudo", "-n", "dnf", "-y", "install", "helix"]
    assert cat.pkg_command("remove", ["helix"], "pacman") == ["sudo", "-n", "pacman", "--noconfirm", "-Rns", "helix"]
    monkeypatch.setattr(cat, "aur_helper", lambda: "paru")
    assert cat.pkg_command("install", ["1password"], "aur") == ["paru", "--noconfirm", "--needed", "-S", "1password"]
    monkeypatch.setattr(cat, "is_image", lambda: True)
    with pytest.raises(cat.CatalogError):
        cat.pkg_command("install", ["helix"], None)


def test_pkg_available_asks_the_right_manager(monkeypatch):
    seen = []

    def fake_quiet(argv, timeout=60):
        seen.append(argv)
        return cat.subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(cat, "quiet", fake_quiet)
    assert cat.pkg_available("helix", "dnf") and cat.pkg_available("helix", "pacman")
    assert seen == [["dnf", "-q", "list", "--available", "helix"], ["pacman", "-Si", "helix"]]


def test_pkg_manager_reports_the_image(monkeypatch, capsys):
    monkeypatch.setattr(cat, "is_image", lambda: True)
    assert cat.main(["pkg", "manager"]) == 0
    assert capsys.readouterr().out.strip() == "image"


def test_entry_view_reports_state_and_extras(monkeypatch):
    class Nothing(cat.Probe):
        def installed(self, entry):
            return False

    group = next(g for g in GROUPS if g["id"] == "ai")
    view = cat.entry_view(group, ENTRIES["lm-studio"], fedora(), Nothing(fedora()))
    assert view == {
        "id": "lm-studio",
        "label": "LM Studio",
        "description": ENTRIES["lm-studio"]["description"],
        "group": "ai",
        "installed": False,
        "available": True,
        "method": "link",
        "removable": False,
        "hermes": "lmstudio",
        "url": "https://lmstudio.ai/download",
    }
    agent = cat.entry_view(group, ENTRIES["codex"], fedora(), Nothing(fedora()))
    assert agent["terminal"] is True and agent["bin"] == "codex"


def test_options_parse_sizes_and_purge():
    assert cat.options(["windows", "--ram", "8", "--cpus", "4", "--purge"]) == (["windows"], {"ram": 8, "cpus": 4, "purge": True})
    with pytest.raises(cat.CatalogError):
        cat.options(["windows", "--ram", "lots"])


def test_append_once_and_remove_line(tmp_path):
    rc = tmp_path / ".bashrc"
    rc.write_text("alias ll='ls -l'")
    cat.append_once(rc, "export A=1")
    cat.append_once(rc, "export A=1")
    assert rc.read_text() == "alias ll='ls -l'\nexport A=1\n"
    cat.remove_line(rc, "export A=1")
    assert rc.read_text() == "alias ll='ls -l'\n"
