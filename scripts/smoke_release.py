#!/usr/bin/env python3
"""Install a release wheel and verify it using temporary workspaces on each OS."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import venv
import zipfile
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def clean_environment(base):
    environment = dict(os.environ)
    for key in ("PYTHONPATH", "PYTHONUTF8", "SLIDE_NOTES_WORKSPACE", "SLIDE_NOTES_NOTEBOOK", "SLIDE_NOTES_URL"):
        environment.pop(key, None)
    environment.update(PYTHONIOENCODING="utf-8", SLIDE_NOTES_CONFIG_HOME=str(base / "config"),
                       XDG_CONFIG_HOME=str(base / "xdg-config"), XDG_DATA_HOME=str(base / "xdg-data"))
    return environment


def verify_installed(expected_version):
    import slide_notes
    from slide_notes.application import Application
    from slide_notes.launcher import desktop_install
    from slide_notes.paths import PACKAGE_ROOT, STATIC_ROOT
    from slide_notes.web.server import handler_factory

    assert slide_notes.__version__ == expected_version, (slide_notes.__version__, expected_version)
    assert Path(PACKAGE_ROOT).resolve().is_relative_to(Path(sys.prefix).resolve()), "Smoke imported the source checkout"
    for module in ("ai.service", "ai.workspace_tools", "ai.pdf_reader", "notebook.runtime", "notebook.kernel_worker", "workspace.file_ops"):
        __import__("slide_notes." + module)
    assert (STATIC_ROOT / "workspace-menu.js").is_file()
    with tempfile.TemporaryDirectory(prefix="slide-notes-smoke-") as temporary:
        base = Path(temporary)
        os.environ.update(clean_environment(base))
        for entry in ("slide_notes.launcher", "slide_notes.cli"):
            subprocess.run([sys.executable, "-I", "-m", entry, "--help"], check=True, capture_output=True, timeout=30)
        desktop = Path(desktop_install(data_home=base / "desktop"))
        assert desktop.exists() and desktop.resolve().is_relative_to(base.resolve()), "Desktop launcher escaped temporary directory"
        app = Application(config_home=base / "config")
        workspace_root = base / "工作区 空间"
        workspace_root.mkdir()
        info = app.open(str(workspace_root), initialize=False)
        workspace = app.get(info["id"])
        workspace.environment.python = Path(sys.executable)
        workspace.environment.state["status"] = "ready"
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory(application=app))
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"

        def cli(*arguments):
            result = subprocess.run([sys.executable, "-I", "-m", "slide_notes.cli", "--url", url, "--workspace", info["id"], *arguments],
                                    capture_output=True, text=True, encoding="utf-8", timeout=60,
                                    env=clean_environment(base), cwd=base)
            if result.returncode:
                raise AssertionError(result.stdout + result.stderr)
            return json.loads(result.stdout)

        try:
            with urlopen(url + "/api/app/home", timeout=10) as response:
                assert json.load(response)["application"] == "slide-notes"
            with urlopen(url + "/", timeout=10) as response:
                assert b'data-managed-workbench="true"' in response.read()
            with urlopen(url + "/workspace-menu.js", timeout=10) as response:
                assert response.read() == (STATIC_ROOT / "workspace-menu.js").read_bytes()
            created = cli("create", "--title", "发布验证 中文")
            path = created["path"]
            page = created["document"]["slides"][0]["id"]
            cli("--notebook", path, "cell", "add", "--id", "releaseText", "--slide", page, "--kind", "markdown", "--source", "# 中文公式\n\n$x^2$")
            cli("--notebook", path, "cell", "add", "--id", "releasePython", "--slide", page, "--kind", "python", "--source", "release_answer = 40 + 3\nrelease_answer")
            read = cli("--notebook", path, "show")
            assert read["document"]["title"] == "发布验证 中文"
            assert read["document"]["slides"][0]["cells"][0]["source"] == "# 中文公式\n\n$x^2$"
            result = cli("--notebook", path, "run")
            assert result["ok"] and not result["state"]["errors"], result
            assert result["state"]["outputs"]["releasePython"]["result"]["text"] == "43", result
            snapshot = cli("--notebook", path, "runtime")
            assert not snapshot["stale"]

            payload = "导入内容 与公式 $x^2$".encode("utf-8")
            relative = "资料/中文 文件.md"
            query = urlencode({"workspace": info["id"], "path": relative})
            with urlopen(Request(url + "/api/files/import?" + query, data=payload, headers={"Content-Type": "application/octet-stream"}), timeout=10) as response:
                assert json.load(response)["path"] == relative
            assert (workspace_root / relative).read_bytes() == payload
            impact = cli("files", "impact", relative)
            trashed = cli("files", "trash", relative, "--revision", impact["revision"])
            assert not (workspace_root / relative).exists()
            assert cli("files", "trash-list")["entries"][0]["path"] == relative
            assert cli("files", "restore", trashed["id"])["path"] == relative
            assert (workspace_root / relative).read_bytes() == payload

            outside = base / "outside.txt"
            invalid_paths = ["../outside.txt", str(outside), ".slide-notes/secret"]
            if os.name == "nt":
                invalid_paths += ["..\\outside.txt", "C:\\outside-release-smoke.txt", "C:/outside-release-smoke.txt"]
            for invalid in invalid_paths:
                try:
                    workspace.import_file(invalid, io.BytesIO(b"invalid"), 7)
                except ValueError:
                    pass
                else:
                    raise AssertionError(f"Workspace accepted outside/protected path: {invalid!r}")
            assert not outside.exists()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            app.stop()
    print(json.dumps({"status": "passed", "version": expected_version, "platform": sys.platform,
                      "checks": ["installed imports", "desktop launcher", "HTTP/static", "Unicode CLI", "Python worker 43", "Unicode file import/trash/restore", "workspace boundaries"]}))


def installed_checks(python, info, base, runtime_tests, launcher_tests):
    subprocess.run([str(python), "-I", str(Path(__file__).resolve()), "--verify-installed", info["version"]],
                   check=True, timeout=180, env=clean_environment(base), cwd=base)
    for selected in (runtime_tests, launcher_tests):
        if selected:
            tests = Path(selected).resolve()
            subprocess.run([str(python), "-I", "-m", "unittest", "discover", "-s", str(tests.parent), "-p", tests.name],
                           check=True, timeout=180, env=clean_environment(base), cwd=base)


def install_and_smoke(artifacts, runtime_tests=None, launcher_tests=None):
    from build_release import validate_artifacts
    artifacts = Path(artifacts).resolve()
    info = validate_artifacts(artifacts)
    wheel, = [artifacts / asset["path"] for asset in info["assets"].values() if asset["path"].endswith(".whl")]
    with tempfile.TemporaryDirectory(prefix="slide-notes-install-") as temporary:
        base = Path(temporary)
        environment = base / "environment"
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", str(wheel)], check=True, timeout=300)
        installed_checks(python, info, base, runtime_tests, launcher_tests)

        # Exercise exactly the downloaded-source installation users perform,
        # including PowerShell parsing and native shortcut creation on Windows.
        extracted = base / "下载源码 中文"
        source = extracted / info["sourceDirectory"]
        with zipfile.ZipFile(artifacts / info["sourceZIP"]) as archive:
            for member in archive.infolist():
                path = Path(member.filename)
                if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != info["sourceDirectory"] or "\\" in member.filename:
                    raise ValueError("Unsafe source ZIP member")
            archive.extractall(extracted)
        application = base / "安装目录 空间" / "app"
        installer_environment = clean_environment(base)
        installer_environment.update(SLIDE_NOTES_INSTALL_DIR=str(application), SLIDE_NOTES_BIN_DIR=str(base / "安装命令"),
                                     SLIDE_NOTES_DESKTOP_HOME=str(base / "安装桌面"), SLIDE_NOTES_PYTHON=sys.executable)
        if os.name == "nt":
            command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(source / "install.ps1")]
        else:
            command = ["bash", str(source / "install.sh")]
        subprocess.run(command, check=True, timeout=420, env=installer_environment, cwd=source)
        assert (application / ".slide-notes-install.json").is_file(), "Source installer did not claim its own environment"
        assert any((base / "安装桌面").iterdir()), "Source installer did not write a desktop launcher"
        source_python = application / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        installed_checks(source_python, info, base, runtime_tests, launcher_tests)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--artifacts", type=Path)
    mode.add_argument("--verify-installed", metavar="VERSION")
    parser.add_argument("--runtime-tests", type=Path)
    parser.add_argument("--launcher-tests", type=Path)
    arguments = parser.parse_args()
    if arguments.verify_installed:
        verify_installed(arguments.verify_installed)
    else:
        install_and_smoke(arguments.artifacts, arguments.runtime_tests, arguments.launcher_tests)


if __name__ == "__main__":
    main()
