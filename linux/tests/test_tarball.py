"""Herald OS from the release tarball: herald-os-tarball, and the commands finding their data in /opt/herald-os."""

import errno
import hashlib
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import ssl
import stat
import struct
import subprocess
import sys
import tarfile
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / "linux" / "bin"


def load(name: str, path: Path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, loader))
    loader.exec_module(module)
    return module


tb = load("herald_os_tarball", BIN / "herald-os-tarball")
cli = load("herald_os_cli_tarball", BIN / "herald-os")


def asar(manifest: dict) -> bytes:
    """An app.asar holding only package.json, laid out as Electron writes them."""
    body = json.dumps(manifest).encode()
    text = json.dumps({"files": {"package.json": {"size": len(body), "offset": "0"}}}).encode()
    padded = text + b"\0" * (-len(text) % 4)
    header = struct.pack("<II", 4 + len(padded), len(text)) + padded
    return struct.pack("<II", 4, len(header)) + header + body


def write(path: Path, data, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    path.chmod(mode)


def make_app(app: Path, version: str, tools=("herald-os", "herald-os-app", "herald-os-update", "herald-os-tarball")) -> Path:
    """An unpacked release tarball: the Electron binary, app.asar and the Linux resources."""
    write(app / "herald-os", "#!/bin/sh\n", 0o755)
    write(app / "chrome-sandbox", "", 0o755)
    write(app / "resources" / "app.asar", asar({"name": "@herald-os/desktop", "version": version}))
    write(app / "resources" / "icons" / "herald-os.png", b"\x89PNG")
    linux = app / "resources" / "herald-os-linux"
    for tool in tools:
        source = BIN / tool
        write(linux / "bin" / tool, source.read_bytes() if source.exists() else "#!/bin/sh\n", 0o755)
    for name in (*tb.SESSION_SCRIPTS, "herald-os.desktop", *tb.UNITS):
        source = ROOT / "linux" / "session" / name
        write(linux / "session" / name, source.read_bytes(), source.stat().st_mode & 0o777)
    shutil.copytree(ROOT / "linux" / "niri", linux / "niri")
    shutil.copytree(ROOT / "linux" / "catalog", app / "resources" / "catalog")
    shutil.copytree(ROOT / "linux" / "themes", app / "resources" / "themes")
    return app


@pytest.fixture
def layout(tmp_path, monkeypatch):
    monkeypatch.setattr(tb, "owner", lambda path: None)
    monkeypatch.setattr(tb.shutil, "which", lambda name: f"/usr/bin/{name}" if name == "niri" else None)
    found = tb.Layout(tmp_path)
    make_app(found.app, "0.1.0")
    return found


def test_the_version_comes_out_of_app_asar(layout, tmp_path):
    assert tb.read_version(layout.app) == "0.1.0"
    write(tmp_path / "broken" / "resources" / "app.asar", b"not an archive")
    assert tb.read_version(tmp_path / "broken") is None
    assert tb.read_version(tmp_path / "missing") is None


def test_versions_sort_the_way_semver_does():
    ordered = ["0.1.0-alpha.1", "0.1.0-alpha.2", "0.1.0-alpha.10", "0.1.0-alpha.beta", "0.1.0-beta", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "1.0.0"]
    keys = [tb.version_key(version) for version in ordered]
    assert keys == sorted(keys) and len(set(keys)) == len(keys)
    assert tb.is_newer("0.1.0-alpha.2", "0.1.0-alpha.1") and not tb.is_newer("0.1.0-alpha.1", "0.1.0-alpha.1")
    assert not tb.is_newer("0.1.0", "0.2.0-alpha.1")
    assert tb.is_newer("0.1.0", None) and not tb.is_newer("nightly", None)


def release(tag, assets=("x64", "arm64"), prerelease=False, draft=False, checksums=True):
    files = []
    for arch in assets:
        name = f"herald-os-{tag[1:]}-linux-{arch}.tar.gz"
        files.append({"name": name, "size": 1000, "browser_download_url": f"https://example.com/{tag}/{name}"})
        if checksums:
            files.append({"name": f"{name}.sha256", "browser_download_url": f"https://example.com/{tag}/{name}.sha256"})
    return {"tag_name": tag, "prerelease": prerelease, "draft": draft, "assets": files}


def test_the_newest_stable_release_with_this_machine_s_tarball_wins():
    listing = [
        release("v0.3.0", draft=True),
        release("v0.2.1", assets=("x64",)),
        release("v0.2.0-beta.1", prerelease=True),
        release("v0.1.9", checksums=False),
        release("v0.1.5"),
        release("v0.1.0"),
    ]
    assert tb.pick_release(listing, "x64")["version"] == "0.2.1"
    assert tb.pick_release(listing, "arm64")["version"] == "0.1.5"
    assert tb.pick_release(listing, "arm64", channel="edge")["version"] == "0.2.0-beta.1"
    exact = tb.pick_release(listing, "arm64", version="0.2.0-beta.1")
    assert exact["checksum_url"].endswith("herald-os-0.2.0-beta.1-linux-arm64.tar.gz.sha256")
    assert tb.pick_release(listing, "x64", version="0.3.0") is None
    assert tb.pick_release([], "x64") is None


def test_install_puts_the_session_and_commands_in_place_and_remove_takes_them_out(layout):
    assert tb.install(layout) == 0
    for name in ("herald-os", "herald-os-app", "herald-os-update", "herald-os-tarball", *tb.SESSION_SCRIPTS):
        assert tb.points_into(layout.bin / name, layout.app), name
    assert (layout.bin / "herald-os-compositor").resolve() == (layout.linux / "session" / "herald-os-compositor").resolve()
    assert layout.session_entry == layout.root / "usr" / "share" / "wayland-sessions" / "herald-os.desktop"
    assert "Exec=herald-os-compositor" in layout.session_entry.read_text()
    assert "Exec=herald-os-app" in layout.app_entry.read_text() and layout.icon.read_bytes() == b"\x89PNG"
    assert all((layout.units / unit).is_file() for unit in tb.UNITS)
    assert stat.S_IMODE((layout.app / "chrome-sandbox").stat().st_mode) == 0o4755
    before = outside_opt(layout)
    assert tb.install(layout) == 0
    assert outside_opt(layout) == before
    assert tb.remove(layout) == 0
    assert not [path for path in outside_opt(layout) if path.is_file() or path.is_symlink()]
    assert (layout.app / "resources" / "app.asar").is_file()


def outside_opt(layout) -> list[Path]:
    return sorted(path for path in layout.root.rglob("*") if path.relative_to(layout.root).parts[0] != "opt")


def test_without_niri_the_login_screen_gets_no_session_it_cannot_start(layout, monkeypatch, capsys):
    tb.install(layout)
    monkeypatch.setattr(tb.shutil, "which", lambda name: None)
    tb.install(layout)
    assert not any(entry.exists() for entry in layout.session_entries)
    assert "needs niri" in capsys.readouterr().out
    assert layout.app_entry.is_file()


def test_ostree_systems_get_the_session_under_usr_local(tmp_path, monkeypatch):
    monkeypatch.setattr(tb, "owner", lambda path: None)
    monkeypatch.setattr(tb.shutil, "which", lambda name: "/usr/bin/niri")
    write(tmp_path / "run" / "ostree-booted", "")
    found = tb.Layout(tmp_path)
    make_app(found.app, "0.1.0")
    tb.install(found)
    assert (tmp_path / "usr" / "local" / "share" / "wayland-sessions" / "herald-os.desktop").is_file()
    assert not (tmp_path / "usr" / "share").exists()


def test_install_leaves_files_that_are_not_its_links_alone(layout):
    write(layout.bin / "herald-os-app", "#!/bin/sh\necho mine\n", 0o755)
    with pytest.raises(SystemExit):
        tb.install(layout)
    assert (layout.bin / "herald-os-app").read_text() == "#!/bin/sh\necho mine\n"
    assert not (layout.bin / "herald-os").exists()


def test_install_drops_links_to_commands_the_version_no_longer_has(layout):
    tb.install(layout)
    (layout.linux / "bin" / "herald-os-app").unlink()
    tb.install(layout)
    assert not (layout.bin / "herald-os-app").is_symlink()


def test_a_package_s_herald_os_is_left_to_the_package(layout, monkeypatch, capsys):
    monkeypatch.setattr(tb, "owner", lambda path: "herald-os-bin")
    assert "herald-os-bin package" in tb.not_a_tarball(layout)
    assert tb.status(layout) == 2 and tb.check(layout, "stable") == 2
    assert "herald-os-bin" in capsys.readouterr().err
    shutil.rmtree(layout.app)
    assert "no Herald OS release tarball" in tb.not_a_tarball(layout)


def tarball_of(app: Path, version: str, arch: str, out: Path) -> tuple[Path, Path]:
    """A release tarball (one top folder, as electron-builder writes it) and its .sha256."""
    name = f"herald-os-{version}-linux-{arch}.tar.gz"
    with tarfile.open(out / name, "w:gz") as archive:
        archive.add(app, arcname=name[: -len(".tar.gz")])
    checksum = out / f"{name}.sha256"
    checksum.write_text(f"{hashlib.sha256((out / name).read_bytes()).hexdigest()}  {name}\n")
    return out / name, checksum


@pytest.fixture
def published(layout, tmp_path, monkeypatch):
    """Release 0.2.0 on a stand-in for GitHub; downloads copy from it."""
    served = tmp_path / "served"
    served.mkdir()
    arch = tb.machine_arch() or "x64"
    monkeypatch.setattr(tb, "machine_arch", lambda: arch)
    tarball_of(make_app(tmp_path / "build" / "app", "0.2.0"), "0.2.0", arch, served)
    monkeypatch.setattr(tb, "releases", lambda: [release("v0.2.0")])
    monkeypatch.setattr(tb, "download", lambda url, target: shutil.copy(served / url.rsplit("/", 1)[1], target))
    tb.install(layout)
    return served


def test_update_swaps_in_the_new_release_and_rollback_swaps_back(layout, published, capsys):
    assert tb.check(layout, "stable") == 0 and capsys.readouterr().out.strip() == "0.2.0"
    assert tb.update(layout) == 0
    assert tb.read_version(layout.app) == "0.2.0" and tb.read_version(layout.previous) == "0.1.0"
    assert stat.S_IMODE((layout.app / "chrome-sandbox").stat().st_mode) == 0o4755
    assert tb.points_into(layout.bin / "herald-os", layout.app) and (layout.bin / "herald-os").resolve().is_file()
    assert not list(layout.app.parent.glob(".herald-os-update-*"))
    assert tb.check(layout, "stable") == 1
    assert tb.update(layout) == 0 and "up to date" in capsys.readouterr().out
    assert tb.rollback(layout) == 0
    assert tb.read_version(layout.app) == "0.1.0" and tb.read_version(layout.previous) == "0.2.0"


def test_a_tarball_that_does_not_match_its_checksum_changes_nothing(layout, published):
    (published / f"herald-os-0.2.0-linux-{tb.machine_arch()}.tar.gz").write_bytes(b"something else")
    with pytest.raises(SystemExit):
        tb.update(layout)
    assert tb.read_version(layout.app) == "0.1.0" and not layout.previous.exists()
    assert not list(layout.app.parent.glob(".herald-os-update-*"))


def test_a_checksum_file_for_another_file_is_refused(tmp_path):
    tarball = tmp_path / "herald-os-0.2.0-linux-x64.tar.gz"
    tarball.write_bytes(b"data")
    checksum = tmp_path / "sums.sha256"
    checksum.write_text(f"{hashlib.sha256(b'data').hexdigest()}  herald-os-0.2.0-linux-arm64.tar.gz\n")
    with pytest.raises(tb.ReleaseError):
        tb.verify(tarball, checksum)
    checksum.write_text(f"{hashlib.sha256(b'data').hexdigest()}  {tarball.name}\n")
    tb.verify(tarball, checksum)


def test_the_command_line_stages_into_herald_os_destdir(tmp_path):
    make_app(tmp_path / "opt" / "herald-os", "0.1.0")
    env = {**os.environ, "HERALD_OS_DESTDIR": str(tmp_path)}
    tool = tmp_path / "opt" / "herald-os" / "resources" / "herald-os-linux" / "bin" / "herald-os-tarball"
    assert subprocess.run([sys.executable, str(tool), "install"], env=env, capture_output=True, text=True).returncode == 0
    shown = subprocess.run([sys.executable, str(tmp_path / "usr" / "local" / "bin" / "herald-os-tarball"), "status"], env=env, capture_output=True, text=True)
    assert shown.returncode == 0 and "Herald OS 0.1.0, from the release tarball" in shown.stdout
    assert subprocess.run([sys.executable, str(tool), "check", "--channel", "nightly"], env=env, capture_output=True).returncode == 2


def test_the_commands_find_the_catalog_and_themes_in_the_tarball(tmp_path):
    app = make_app(tmp_path / "opt" / "herald-os", "0.1.0", tools=("herald-os", "herald-os-catalog", "herald-os-theme"))
    linked = tmp_path / "usr" / "local" / "bin"
    linked.mkdir(parents=True)
    for tool in ("herald-os", "herald-os-catalog", "herald-os-theme"):
        (linked / tool).symlink_to(app / "resources" / "herald-os-linux" / "bin" / tool)
    env = {"HOME": str(tmp_path / "home"), "PATH": os.pathsep.join([str(linked), str(Path(sys.executable).parent), "/usr/bin", "/bin"])}
    listing = subprocess.run([sys.executable, str(linked / "herald-os-catalog"), "list", "--json"], env=env, capture_output=True, text=True, check=True)
    groups = json.loads(listing.stdout)["groups"]
    assert len(groups) > 5 and all(group["entries"] for group in groups)
    themes = subprocess.run([sys.executable, str(linked / "herald-os-theme"), "list"], env=env, capture_output=True, text=True, check=True)
    assert "herald-ocean" in themes.stdout and "herald-paper" in themes.stdout
    names = subprocess.run([sys.executable, str(linked / "herald-os"), "theme", "list"], env=env, capture_output=True, text=True, check=True)
    assert len(names.stdout.split()) == len(list((ROOT / "linux" / "themes").glob("*/theme.json")))


def test_setup_says_how_to_start_what_is_installed(tmp_path, monkeypatch):
    entry = tmp_path / "herald-os.desktop"
    monkeypatch.setattr(cli, "SESSION_ENTRIES", (entry,))
    monkeypatch.setattr(cli.shutil, "which", lambda name: "/usr/bin/niri")
    assert "sudo herald-os-tarball install" in cli.session_hint()
    entry.write_text("[Desktop Entry]\n")
    assert cli.session_hint().startswith("Start the full session from your login screen")
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert "also needs niri" in cli.session_hint()


def updater_env(tmp_path, check_exit: int):
    """herald-os-update with stand-ins for herald-os, sudo and herald-os-tarball (which reports 0.2.0)."""
    stubs, home, repo = tmp_path / "stubs", tmp_path / "home", tmp_path / "checkout"
    for folder in (stubs, home, repo / "linux" / "migrations"):
        folder.mkdir(parents=True)
    scripts = {
        "herald-os": 'echo "$@" >>"$HOME/herald-os.log"',
        "sudo": '[ "$1" = -n ] && shift\nexec "$@"',
        "herald-os-tarball": f'echo "$@" >>"$HOME/tarball.log"\n[ "$1" = check ] && echo 0.2.0 && exit {check_exit}\nexit 0',
    }
    for name, body in scripts.items():
        write(stubs / name, f"#!/bin/sh\n{body}\n", 0o755)
    return {"HOME": str(home), "HERALD_OS_REPO": str(repo), "PATH": os.pathsep.join([str(stubs), "/usr/bin", "/bin"])}


def test_the_updater_reports_and_installs_a_newer_release(tmp_path):
    env = updater_env(tmp_path, check_exit=0)
    checked = subprocess.run(["bash", str(BIN / "herald-os-update"), "--check", "--no-system"], env=env, capture_output=True, text=True, timeout=60)
    assert checked.stdout.strip() == "Herald OS 0.2.0"
    assert json.loads((tmp_path / "home" / ".local" / "state" / "herald-os" / "update-available.json").read_text())["pending"] == 1
    subprocess.run(["bash", str(BIN / "herald-os-update"), "--no-system", "--no-hermes"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    assert (tmp_path / "home" / "tarball.log").read_text().splitlines()[-1] == "update 0.2.0"


def test_the_updater_leaves_an_up_to_date_tarball_alone(tmp_path):
    env = updater_env(tmp_path, check_exit=1)
    checked = subprocess.run(["bash", str(BIN / "herald-os-update"), "--check", "--no-system"], env=env, capture_output=True, text=True, timeout=60)
    assert checked.stdout.strip() == "up to date"
    subprocess.run(["bash", str(BIN / "herald-os-update"), "--no-system", "--no-hermes"], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    assert "update" not in (tmp_path / "home" / "tarball.log").read_text().split()


# ---------------------------------------------------------------------------------------------
# Downloads are HTTPS only, and no swap leaves /opt/herald-os missing or half replaced.


def test_every_request_to_github_is_https_only(tmp_path, monkeypatch):
    ran = []
    monkeypatch.setattr(tb.subprocess, "call", lambda argv, **kwargs: ran.append(argv) or 0)
    monkeypatch.setattr(tb.subprocess, "run", lambda argv, **kwargs: ran.append(argv) or subprocess.CompletedProcess(argv, 0, "[]", ""))
    tb.download("https://github.com/iamlukethedev/Herald-OS/releases/download/v1/x.tar.gz", tmp_path / "x")
    tb.releases()
    assert len(ran) == 2
    for argv in ran:
        assert argv[0] == "curl" and "--fail" in argv
        assert argv[argv.index("--proto") + 1] == "=https" and argv[argv.index("--proto-redir") + 1] == "=https"
    with pytest.raises(tb.ReleaseError):
        tb.download("http://example.com/x.tar.gz", tmp_path / "y")
    assert len(ran) == 2


@pytest.fixture
def tls_server(tmp_path, monkeypatch):
    """A local HTTPS server that answers, redirects within HTTPS, or redirects to a plain http server,
    with a certificate curl trusts through CURL_CA_BUNDLE."""
    if not (shutil.which("openssl") and shutil.which("curl")):
        pytest.skip("needs openssl and curl")
    key, cert = tmp_path / "key.pem", tmp_path / "cert.pem"
    made = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], capture_output=True)
    if made.returncode != 0:
        pytest.skip("openssl could not make a test certificate")
    routes: dict[str, tuple[int, bytes | str]] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            status, value = routes.get(self.path, (404, b""))
            self.send_response(status)
            if status == 302:
                self.send_header("Location", value)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_header("Content-Length", str(len(value)))
            self.end_headers()
            self.wfile.write(value)

        def log_message(self, *args):
            pass

    plain = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    secure = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    secure.socket = context.wrap_socket(secure.socket, server_side=True)
    https = f"https://127.0.0.1:{secure.server_port}"
    routes.update({
        "/release.tar.gz": (200, b"release"),
        "/cdn": (302, f"{https}/release.tar.gz"),
        "/downgrade": (302, f"http://127.0.0.1:{plain.server_port}/release.tar.gz"),
    })
    for server in (plain, secure):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("CURL_CA_BUNDLE", str(cert))
    yield https
    for server in (plain, secure):
        server.shutdown()
        server.server_close()


def test_a_redirect_to_plain_http_is_refused(tls_server, tmp_path):
    target = tmp_path / "release.tar.gz"
    try:
        tb.download(f"{tls_server}/release.tar.gz", target)
    except tb.ReleaseError:
        pytest.skip("this curl does not read its CA bundle from CURL_CA_BUNDLE")
    assert target.read_bytes() == b"release"
    target.unlink()
    tb.download(f"{tls_server}/cdn", target)
    assert target.read_bytes() == b"release"
    target.unlink()
    with pytest.raises(tb.ReleaseError):
        tb.download(f"{tls_server}/downgrade", target)
    assert not target.exists() or target.read_bytes() != b"release"
    # Without the protocol limits curl follows the downgrade, so the refusal above is theirs.
    assert subprocess.call(["curl", "-fsSL", "-o", str(target), f"{tls_server}/downgrade"]) == 0 and target.read_bytes() == b"release"


def test_the_kernel_exchanges_two_folders_in_one_step_where_it_can(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    write(first / "which", "first")
    write(second / "which", "second")
    try:
        tb.exchange(first, second)
    except OSError as exc:
        assert exc.errno in tb.EXCHANGE_UNSUPPORTED, exc
        if sys.platform == "linux":
            pytest.skip("this filesystem cannot exchange two folders")
        return
    assert (first / "which").read_text() == "second" and (second / "which").read_text() == "first"


def fake_exchange(calls: list):
    """An exchange with renameat2's outcome, for systems without it (macOS), recorded in ``calls``."""

    def swap(first, second):
        assert Path(first).exists() and Path(second).exists()
        calls.append((Path(first), Path(second)))
        middle = Path(first).with_name(".fake-exchange")
        os.rename(first, middle)
        os.rename(second, first)
        os.rename(middle, second)

    return swap


def no_exchange(*paths):
    raise OSError(errno.ENOSYS, "renameat2 is not available")


def renames(monkeypatch, fail=lambda source, target, count: False) -> list:
    """Path.rename, recorded, and failing where ``fail`` says (with the number of the rename)."""
    done: list = []
    real = Path.rename

    def rename(self, target):
        source, target = Path(self), Path(target)
        if fail(source, target, len(done) + 1):
            done.append((source, target, "failed"))
            raise OSError(errno.EIO, "injected failure", str(source))
        done.append((source, target, "ok"))
        return real(self, target)

    monkeypatch.setattr(Path, "rename", rename)
    return done


def versions(layout, *others):
    return [tb.read_version(path) for path in (layout.app, layout.previous, *others)]


def test_update_puts_the_new_version_in_place_with_one_exchange(layout, published, monkeypatch):
    calls: list = []
    monkeypatch.setattr(tb, "exchange", fake_exchange(calls))
    done = renames(monkeypatch)
    assert tb.update(layout) == 0
    assert len(calls) == 1 and calls[0][1] == layout.app and calls[0][0].name == "herald-os"
    # /opt/herald-os itself is never renamed away: only the replaced version moves on, to .previous.
    assert [(source.name, target) for source, target, _ in done] == [("herald-os", layout.previous)]
    assert versions(layout) == ["0.2.0", "0.1.0"]


def test_a_failed_exchange_leaves_everything_as_it_was(layout, published, monkeypatch, capsys):
    monkeypatch.setattr(tb, "exchange", lambda first, second: (_ for _ in ()).throw(OSError(errno.EIO, "injected failure")))
    with pytest.raises(SystemExit):
        tb.update(layout)
    assert versions(layout) == ["0.1.0", None]
    assert "Herald OS 0.1.0 is in" in capsys.readouterr().err
    assert not list(layout.app.parent.glob(".herald-os-update-*"))


def test_without_exchange_a_failed_swap_puts_the_version_in_use_back(layout, published, monkeypatch):
    monkeypatch.setattr(tb, "exchange", no_exchange)
    done = renames(monkeypatch, fail=lambda source, target, count: target == layout.app and source != layout.previous)
    with pytest.raises(SystemExit):
        tb.update(layout)
    assert [status for *_, status in done] == ["ok", "failed", "ok"]
    assert versions(layout) == ["0.1.0", None]
    assert not list(layout.app.parent.glob(".herald-os-update-*"))


def test_when_putting_it_back_fails_too_the_message_says_where_it_is(layout, published, monkeypatch, capsys):
    monkeypatch.setattr(tb, "exchange", no_exchange)
    renames(monkeypatch, fail=lambda source, target, count: count > 1)
    with pytest.raises(SystemExit):
        tb.update(layout)
    assert versions(layout) == [None, "0.1.0"]
    error = capsys.readouterr().err
    assert f"0.1.0 is in {layout.previous}" in error and f"sudo mv {layout.previous} {layout.app}" in error


def test_a_replaced_version_that_cannot_move_on_is_kept(layout, published, monkeypatch, capsys):
    monkeypatch.setattr(tb, "exchange", fake_exchange([]))
    renames(monkeypatch, fail=lambda source, target, count: target == layout.previous)
    assert tb.update(layout) == 0
    assert versions(layout) == ["0.2.0", None]
    kept = list(layout.app.parent.glob(".herald-os-update-*/herald-os"))
    assert len(kept) == 1 and tb.read_version(kept[0]) == "0.1.0"
    assert not list(layout.app.parent.glob(".herald-os-update-*/*.tar.gz"))
    assert str(kept[0]) in capsys.readouterr().out


@pytest.fixture
def updated(layout, published, monkeypatch):
    """0.2.0 in /opt/herald-os, 0.1.0 in /opt/herald-os.previous."""
    tb.update(layout)
    assert versions(layout) == ["0.2.0", "0.1.0"]
    return layout


def test_rollback_is_one_exchange(updated, monkeypatch):
    calls: list = []
    monkeypatch.setattr(tb, "exchange", fake_exchange(calls))
    done = renames(monkeypatch)
    assert tb.rollback(updated) == 0
    assert calls == [(updated.app, updated.previous)] and not done
    assert versions(updated) == ["0.1.0", "0.2.0"]


def test_a_failed_rollback_exchange_changes_nothing(updated, monkeypatch):
    monkeypatch.setattr(tb, "exchange", lambda first, second: (_ for _ in ()).throw(OSError(errno.EIO, "injected failure")))
    with pytest.raises(SystemExit):
        tb.rollback(updated)
    assert versions(updated) == ["0.2.0", "0.1.0"]


@pytest.mark.parametrize("step", [1, 2, 3])
def test_without_exchange_a_rollback_that_fails_at_any_step_puts_both_versions_back(updated, monkeypatch, step):
    monkeypatch.setattr(tb, "exchange", no_exchange)
    parked = updated.app.with_name(".herald-os.rollback")
    done = renames(monkeypatch, fail=lambda source, target, count: count == step)
    with pytest.raises(SystemExit):
        tb.rollback(updated)
    assert [status for *_, status in done].count("failed") == 1
    assert versions(updated) == ["0.2.0", "0.1.0"] and not parked.exists()


def test_a_rollback_that_cannot_put_things_back_says_where_they_are(updated, monkeypatch, capsys):
    monkeypatch.setattr(tb, "exchange", no_exchange)
    parked = updated.app.with_name(".herald-os.rollback")
    renames(monkeypatch, fail=lambda source, target, count: count > 1)
    with pytest.raises(SystemExit):
        tb.rollback(updated)
    assert versions(updated, parked) == [None, "0.1.0", "0.2.0"]
    error = capsys.readouterr().err
    assert f"0.2.0 is in {parked}" in error and f"sudo mv {updated.previous} {updated.app}" in error
