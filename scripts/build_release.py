#!/usr/bin/env python3
"""Build verified GitHub Release assets from the reviewed public source only."""
import argparse
import ast
from datetime import datetime, timezone
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

from check_package import check_sdist, check_wheel
from export_release import ROOT, export_release

VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.+-]*)?")
DIGEST = re.compile(r"[0-9a-f]{64}")


def project_version(root=ROOT, tag=None):
    root = Path(root)
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Invalid project version")
    module = ast.parse((root / "src/slide_notes/__init__.py").read_text(encoding="utf-8"))
    versions = [ast.literal_eval(node.value) for node in module.body if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets)]
    package = json.loads((root / "frontend/package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "frontend/package-lock.json").read_text(encoding="utf-8"))
    if versions != [version] or any(value != version for value in (package["version"], lock["version"], lock["packages"][""]["version"])):
        raise ValueError("Python and frontend versions must match pyproject.toml")
    if tag is not None and tag != "v" + version:
        raise ValueError(f"Release tag must be v{version}, received {tag!r}")
    return version


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build_packages(source, packages, python=sys.executable):
    # Build tooling may create egg-info; never modify the exported source tree.
    with tempfile.TemporaryDirectory(prefix="slide-notes-package-") as temporary:
        copied = Path(temporary) / "source"
        shutil.copytree(source, copied)
        subprocess.run([str(python), "-m", "build", str(copied), "--outdir", str(packages)], check=True)


def package_versions(wheel, sdist, version):
    with zipfile.ZipFile(wheel) as archive:
        metadata = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        if len(metadata) != 1 or BytesParser().parsebytes(archive.read(metadata[0]))["Version"] != version:
            raise ValueError("Wheel metadata version differs from release version")
    with tarfile.open(sdist) as archive:
        metadata = [entry for entry in archive.getmembers() if entry.isfile() and len(PurePosixPath(entry.name).parts) == 2 and entry.name.endswith("/PKG-INFO")]
        if len(metadata) != 1 or BytesParser().parsebytes(archive.extractfile(metadata[0]).read())["Version"] != version:
            raise ValueError("Source distribution metadata version differs from release version")


def source_zip(source, target):
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("Source ZIP cannot contain symlinks")
            if path.is_file():
                archive.write(path, (Path(source.name) / path.relative_to(source)).as_posix())
    with zipfile.ZipFile(target) as archive:
        expected = {f"{source.name}/{path.relative_to(source).as_posix()}": path for path in source.rglob("*") if path.is_file()}
        if set(archive.namelist()) != set(expected) or any(archive.read(name) != path.read_bytes() for name, path in expected.items()):
            raise ValueError("Source ZIP did not preserve the reviewed source")


def release_notes(version):
    return f"""# Slide Notes {version}

Local notebooks with workspace files, Markdown/math, PDF reading, Python cells and optional local Claude Code or API agents.

## Install on Linux, Windows or macOS

Download `slide-notes-{version}-source.zip`, extract it, and open a terminal in the extracted folder. Python 3.12 or later and an internet connection for Python dependencies are required. This is a Python application, not a bundled native executable or an offline installer.

- Linux/macOS: `bash install.sh`
- Windows PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1`

The installers add a desktop launcher. Existing workspaces and notes remain outside the application installation. See `README.md` in the archive for setup and usage.

PDF text/search/page tools require Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`). Isolated agent shell commands currently require Linux with Bubblewrap and `prlimit`; Windows and macOS retain notebook, workspace and available PDF tools. Model credentials and a local Claude Code installation are optional and are configured separately.

The `.whl` asset is available for Python package installation; the source `.tar.gz` and ZIP contain the same reviewed project files. `RELEASE.json`, `SOURCE_MANIFEST.json` inside the source archive, and `SHA256SUMS` record asset/source integrity. No personal notebooks, local credentials, sessions or reverse-engineering evidence are included.
"""


def checksum_text(directory, info):
    entries = {name: asset["sha256"] for name, asset in info["assets"].items()}
    entries["RELEASE.json"] = sha256(directory / "RELEASE.json")
    return "".join(f"{digest}  {name}\n" for name, digest in sorted(entries.items()))


def validate_artifacts(directory):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError("Release directory cannot be a symlink")
    if (directory / "RELEASE.json").is_symlink():
        raise ValueError("Release metadata must be an ordinary file")
    info = json.loads((directory / "RELEASE.json").read_text(encoding="utf-8"))
    version = info["version"]
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("Invalid release version")
    expected = {f"slide-notes-{version}-source.tar.gz", f"slide-notes-{version}-source.zip", "RELEASE_NOTES.md",
                f"packages/slide_notes_local-{version}-py3-none-any.whl", f"packages/slide_notes_local-{version}.tar.gz"}
    if info.get("sourceArchive") != f"slide-notes-{version}-source.tar.gz" or info.get("sourceZIP") != f"slide-notes-{version}-source.zip":
        raise ValueError("Unexpected source archive names")
    if info.get("sourceDirectory") != f"slide-notes-{version}-source":
        raise ValueError("Unexpected source directory name")
    allowed_root = {PurePosixPath(path).parts[0] for path in expected} | {info["sourceDirectory"], "RELEASE.json", "SHA256SUMS"}
    if {entry.name for entry in directory.iterdir()} != allowed_root:
        raise ValueError("Release directory contains unknown or missing files")
    source = directory / info["sourceDirectory"]
    if source.is_symlink() or not source.is_dir() or any(path.is_symlink() for path in source.rglob("*")):
        raise ValueError("Reviewed source must not contain symlinks")
    checksums = json.loads((source / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"))["files"]
    actual = {path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
    if actual != set(checksums) | {"SOURCE_MANIFEST.json"} or any(sha256(source / name) != digest for name, digest in checksums.items()):
        raise ValueError("Reviewed source checksum mismatch")
    assets = info["assets"]
    if not isinstance(assets, dict) or len(assets) != len(expected):
        raise ValueError("Unexpected release asset count")
    paths = set()
    for name, asset in assets.items():
        relative = asset["path"]
        if not isinstance(relative, str) or relative not in expected or PurePosixPath(relative).name != name or relative in paths:
            raise ValueError("Unexpected release asset path")
        paths.add(relative)
        path = directory.joinpath(*PurePosixPath(relative).parts)
        if any(parent.is_symlink() for parent in (path, *path.parents[:len(PurePosixPath(relative).parts)])) or not path.is_file():
            raise ValueError("Release assets must be ordinary files")
        if not isinstance(asset["sha256"], str) or not DIGEST.fullmatch(asset["sha256"]) or sha256(path) != asset["sha256"]:
            raise ValueError(f"Release asset checksum mismatch: {name}")
    if paths != expected or info["uploadAssets"] != sorted(expected) + ["RELEASE.json", "SHA256SUMS"]:
        raise ValueError("Unexpected upload asset list")
    packages_directory = directory / "packages"
    if packages_directory.is_symlink() or {path.name for path in packages_directory.iterdir()} != {PurePosixPath(path).name for path in expected if path.startswith("packages/")}:
        raise ValueError("Packages directory contains unknown files")
    if info["sourceSHA256"] != assets[info["sourceArchive"]]["sha256"] or info["sourceZIPSHA256"] != assets[info["sourceZIP"]]["sha256"]:
        raise ValueError("Source checksums do not match asset checksums")
    packages = {name: asset["sha256"] for name, asset in assets.items() if asset["path"].startswith("packages/")}
    if info.get("packages") != packages:
        raise ValueError("Package checksum metadata differs")
    sums = directory / "SHA256SUMS"
    if sums.is_symlink() or sums.read_text(encoding="utf-8") != checksum_text(directory, info):
        raise ValueError("SHA256SUMS does not match release assets")
    return info


def build_release(output, root=ROOT, tag=None, python=sys.executable):
    root, output = Path(root).resolve(), Path(output).absolute()
    version = project_version(root, tag)
    if output.exists() or output.is_symlink():
        raise ValueError("Release output already exists; choose a new directory")
    for protected in (root / "src", root / "frontend", root / "tests", root / "docs", root / "scripts"):
        if output.resolve().is_relative_to(protected):
            raise ValueError("Release output cannot be inside application sources")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".slide-notes-assets-", dir=output.parent) as temporary:
        staging = Path(temporary) / "release"
        staging.mkdir()
        source, archive = export_release(staging / f"slide-notes-{version}-source", root)
        packages = staging / "packages"
        packages.mkdir()
        build_packages(source, packages, python)
        wheels, sdists = list(packages.glob("*.whl")), list(packages.glob("*.tar.gz"))
        if len(wheels) != 1 or len(sdists) != 1 or len(list(packages.iterdir())) != 2:
            raise ValueError("Build must produce exactly one wheel and source distribution")
        wheel, sdist = wheels[0], sdists[0]
        package_versions(wheel, sdist, version)
        check_wheel(source, wheel)
        check_sdist(source, sdist)
        zipped = staging / f"slide-notes-{version}-source.zip"
        source_zip(source, zipped)
        notes = staging / "RELEASE_NOTES.md"
        notes.write_text(release_notes(version), encoding="utf-8")
        assets = {path.name: {"path": path.relative_to(staging).as_posix(), "sha256": sha256(path)} for path in (archive, zipped, wheel, sdist, notes)}
        info = {"format": 1, "version": version, "sourceDirectory": source.name,
                "sourceArchive": archive.name, "sourceSHA256": assets[archive.name]["sha256"],
                "sourceZIP": zipped.name, "sourceZIPSHA256": assets[zipped.name]["sha256"],
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "packages": {path.name: assets[path.name]["sha256"] for path in (wheel, sdist)},
                "assets": assets, "uploadAssets": sorted(asset["path"] for asset in assets.values()) + ["RELEASE.json", "SHA256SUMS"]}
        (staging / "RELEASE.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (staging / "SHA256SUMS").write_text(checksum_text(staging, info), encoding="utf-8")
        validate_artifacts(staging)
        staging.rename(output)
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--tag")
    parser.add_argument("--check-version", action="store_true")
    parser.add_argument("--verify", type=Path, help="Validate existing release assets without changing them")
    arguments = parser.parse_args()
    try:
        if arguments.verify:
            print(json.dumps(validate_artifacts(arguments.verify), ensure_ascii=False, indent=2))
        elif arguments.check_version:
            print(project_version(ROOT, arguments.tag))
        elif arguments.output:
            print(json.dumps(build_release(arguments.output, tag=arguments.tag), ensure_ascii=False, indent=2))
        else:
            parser.error("Use --output, --check-version or --verify")
    except (OSError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
