#!/usr/bin/env python3
"""Export the reviewed application source, without copying a user's workspace."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = Path("scripts/release-manifest.json")
FORBIDDEN_PARTS = {
    ".git", ".env", ".slide-notes", ".venv", "__pycache__", "node_modules",
    "notebooks", "material", "meam5170", "picture", "sessions", "research", "data",
}


def relative_path(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in (".", "..") for part in path.parts):
        raise ValueError(f"发布清单含不安全的路径: {value}")
    if any(part in FORBIDDEN_PARTS or part.startswith(".env") for part in path.parts):
        raise ValueError(f"发布清单包含私人或生成目录: {value}")
    return Path(*path.parts)


def reviewed_files(root=ROOT):
    """Return destination -> source; new app modules require explicit review."""
    root = root.resolve()
    manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    if manifest.get("format") != 1:
        raise ValueError("不支持的发布清单格式")
    files = {}

    def add(source_name, destination_name=None):
        source = relative_path(source_name)
        destination = relative_path(destination_name or source_name)
        if destination == Path("SOURCE_MANIFEST.json"):
            raise ValueError("SOURCE_MANIFEST.json 是导出工具生成的保留路径")
        if destination in files:
            raise ValueError(f"发布路径重复: {destination}")
        # Reject directory symlinks too, rather than silently traversing outside.
        for path in [source, *source.parents]:
            if (root / path).is_symlink():
                raise ValueError(f"拒绝导出符号链接: {source}")
        if not (root / source).is_file():
            raise ValueError(f"缺少发布文件: {source}")
        (root / source).resolve().relative_to(root)
        files[destination] = source

    for name in manifest["files"]:
        add(name)
    for destination, source in manifest.get("replacements", {}).items():
        add(source, destination)
    for name in manifest.get("trees", []):
        tree = relative_path(name)
        if (root / tree).is_symlink() or not (root / tree).is_dir():
            raise ValueError(f"不是可发布目录: {tree}")
        for entry in sorted((root / tree).rglob("*")):
            if entry.is_symlink():
                raise ValueError(f"拒绝导出符号链接: {entry.relative_to(root)}")
            if entry.is_file():
                add(entry.relative_to(root).as_posix())

    # Source, tests and guides have independent roots. Each new maintained file
    # must be reviewed, including nested domain modules and frontend entrypoints.
    app_sources = set()
    for directory in ("src/slide_notes", "frontend", "tests", "docs", "scripts"):
        for path in (root / directory).rglob("*"):
            relative = path.relative_to(root)
            if any(part in FORBIDDEN_PARTS | {".pytest_cache"} or part.startswith(".env") for part in relative.parts):
                continue
            if path.is_relative_to(root / "src/slide_notes/static"):
                continue
            if path.is_file():
                app_sources.add(relative)
    missing = app_sources - set(files.values())
    if missing:
        raise ValueError("请先审阅并登记新增源码: " + ", ".join(map(str, sorted(missing))))
    return dict(sorted(files.items()))


def export_release(destination, root=ROOT):
    root = root.resolve()
    destination = Path(destination).absolute()
    archive_path = Path(str(destination) + ".tar.gz")
    for target in (destination, archive_path):
        if target.exists() or target.is_symlink():
            raise ValueError(f"输出已存在；请选择新目录，避免覆盖: {target}")
    for protected in (root / "src", root / "frontend", root / "tests", root / "docs", root / "scripts"):
        if destination.resolve().is_relative_to(protected):
            raise ValueError("输出目录不能位于应用源码或发布脚本目录中")
    files = reviewed_files(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".slide-notes-release-", dir=destination.parent) as temporary:
        staging = Path(temporary) / destination.name
        staging.mkdir()
        checksums = {}
        for target_name, source_name in files.items():
            target = staging / target_name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / source_name, target)
            checksums[target_name.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
        (staging / "SOURCE_MANIFEST.json").write_text(json.dumps({
            "format": 1,
            "files": checksums,
            "excluded": ["personal workspace files", "local configuration", "runtime sessions", "reverse engineering evidence"],
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staging_archive = Path(temporary) / "source.tar.gz"
        with tarfile.open(staging_archive, "w:gz") as archive:
            # Archive metadata must not contain the local account name.
            def public_metadata(info):
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                return info
            archive.add(staging, arcname=destination.name, filter=public_metadata)
        staging.rename(destination)
        staging_archive.rename(archive_path)
    return destination, archive_path


def main():
    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / f"dist/slide-notes-{version}-source-{stamp}")
    args = parser.parse_args()
    try:
        destination, archive = export_release(args.output)
    except (OSError, ValueError, KeyError) as error:
        parser.error(str(error))
    print(destination)
    print(archive)


if __name__ == "__main__":
    main()
