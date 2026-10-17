#!/usr/bin/env python3
"""Publish one current source release and retain exactly one prior source archive."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import tomllib

from export_release import ROOT, export_release, reviewed_files
from build_release import validate_artifacts

VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.+-]*)?")
LEGACY = re.compile(r"slide-notes-[0-9][A-Za-z0-9_.-]*")


def archive_version(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"不是普通源码归档: {path}")
    with tarfile.open(path) as archive:
        projects = [item for item in archive.getmembers() if item.isfile() and len(Path(item.name).parts) == 2 and Path(item.name).name == "pyproject.toml"]
        if len(projects) != 1 or projects[0].size > 64000:
            raise ValueError("历史归档没有唯一的项目元数据")
        version = tomllib.loads(archive.extractfile(projects[0]).read().decode())["project"]["version"]
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise ValueError("无效历史版本")
        return version


def current_archive(current):
    if current.is_symlink() or not current.is_dir():
        raise ValueError("current 必须是本工具管理的普通目录")
    info = json.loads((current / "RELEASE.json").read_text())
    extended = "assets" in info
    if extended:
        validate_artifacts(current)
    name = info["sourceArchive"]
    if not isinstance(name, str) or Path(name).name != name:
        raise ValueError("current 的归档名称无效")
    archive = current / name
    version = archive_version(archive)
    if version != info["version"] or hashlib.sha256(archive.read_bytes()).hexdigest() != info["sourceSHA256"]:
        raise ValueError("当前版本归档校验失败，未执行清理")
    source_name = info["sourceDirectory"]
    if not isinstance(source_name, str) or Path(source_name).name != source_name:
        raise ValueError("当前版本源码目录名称无效")
    source = current / source_name
    if source.is_symlink() or not source.is_dir():
        raise ValueError("当前版本源码目录无效")
    checksums = json.loads((source / "SOURCE_MANIFEST.json").read_text())["files"]
    actual = {path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
    if actual != set(checksums) | {"SOURCE_MANIFEST.json"} or any(path.is_symlink() for path in source.rglob("*")):
        raise ValueError("当前源码目录存在未知文件，未执行清理")
    for filename, expected in checksums.items():
        if hashlib.sha256((source / filename).read_bytes()).hexdigest() != expected:
            raise ValueError("当前源码目录已被修改，未执行清理")
    for entry in current.iterdir():
        if entry.name in {source_name, name, "RELEASE.json"}:
            continue
        if extended and entry.name in {info["sourceZIP"], "RELEASE_NOTES.md", "SHA256SUMS"}:
            if entry.is_symlink() or not entry.is_file():
                raise ValueError("当前发布附件不是普通文件，未执行清理")
            continue
        if entry.name != "packages" or not entry.is_dir() or entry.is_symlink() or any(item.is_symlink() or not item.is_file() or not item.name.startswith("slide_notes_local-") or not item.name.endswith((".whl", ".tar.gz")) for item in entry.iterdir()):
            raise ValueError("当前发布目录存在未知内容，未执行清理")
    return archive


def retention_plan(root, dist, history=None):
    version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError("无效项目版本")
    reviewed_files(root)
    if dist.is_symlink():
        raise ValueError("dist 不能是符号链接")
    entries = list(dist.iterdir()) if dist.exists() else []
    for entry in entries:
        if entry.is_symlink():
            raise ValueError(f"dist 存在符号链接，未执行清理: {entry.name}")
        if entry.name in ("current", "history"):
            if not entry.is_dir():
                raise ValueError(f"不是普通发布目录: {entry.name}")
        elif entry.name == "packages":
            if not entry.is_dir() or any(not item.is_file() or item.is_symlink() or not item.name.startswith("slide_notes_local-") or not item.name.endswith((".whl", ".tar.gz")) for item in entry.iterdir()):
                raise ValueError("旧 packages 目录存在未知内容，未执行清理")
        elif LEGACY.fullmatch(entry.name):
            if entry.is_dir():
                if not (entry / "pyproject.toml").is_file() or any(item.is_symlink() for item in entry.rglob("*")):
                    raise ValueError(f"旧源码目录含未知内容或符号链接: {entry.name}")
            elif not entry.name.endswith(".tar.gz"):
                raise ValueError(f"未知发布文件: {entry.name}")
        else:
            raise ValueError(f"dist 存在未知文件，未执行清理: {entry.name}")
    if (dist / "history").exists():
        for entry in (dist / "history").iterdir():
            archive_version(entry)
    if (dist / "current").exists():
        if history is not None:
            raise ValueError("已有 current 时自动保留其归档，不接受 --history")
        previous = current_archive(dist / "current")
    elif history is not None:
        candidate = Path(history).absolute()
        if candidate.is_symlink():
            raise ValueError("历史归档不能是符号链接")
        previous = candidate.resolve()
        if not previous.is_relative_to(dist.resolve()):
            raise ValueError("首次保留的历史归档必须位于 dist 中")
        archive_version(previous)
    elif entries:
        raise ValueError("首次整理旧 dist 请用 --history 指定要保留的源码归档")
    else:
        previous = None
    return version, previous, entries


def publish_release(root=ROOT, dist=None, history=None, dry_run=False):
    root = Path(root).resolve()
    dist = Path(dist).absolute() if dist is not None else root / "dist"
    version, previous, entries = retention_plan(root, dist, history)
    previous_version = archive_version(previous) if previous else None
    plan = {"version": version, "current": str(dist / "current"), "historyVersion": previous_version,
            "replace": sorted(entry.name for entry in entries), "keepHistory": 1}
    if dry_run:
        return plan
    dist.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".slide-notes-publish-", dir=dist.parent) as temporary:
        staging = Path(temporary)
        new_current, new_history = staging / "current", staging / "history"
        new_current.mkdir(); new_history.mkdir()
        source, archive = export_release(new_current / f"slide-notes-{version}-source", root)
        info = {"format": 1, "version": version, "sourceDirectory": source.name,
                "sourceArchive": archive.name, "sourceSHA256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "createdAt": datetime.now(timezone.utc).isoformat()}
        (new_current / "RELEASE.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
        if previous:
            kept = new_history / f"slide-notes-{previous_version}-source.tar.gz"
            shutil.copy2(previous, kept)
            if hashlib.sha256(kept.read_bytes()).digest() != hashlib.sha256(previous.read_bytes()).digest():
                raise ValueError("历史归档复制校验失败，未执行清理")
        dist.mkdir(exist_ok=True)
        moved, published = [], []
        try:
            # Old artifacts are kept in a rollback area until both new folders
            # have been published. Only these reviewed entries are then removed.
            for index, entry in enumerate(entries):
                backup = staging / f"previous-{index}"
                entry.rename(backup); moved.append((entry, backup))
            for directory in (new_current, new_history):
                target = dist / directory.name
                directory.rename(target); published.append(target)
        except BaseException:
            for target in reversed(published):
                shutil.rmtree(target)
            for original, backup in reversed(moved):
                backup.rename(original)
            raise
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--history", type=Path, help="首次整理旧 dist 时，指定唯一保留的历史源码归档")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        result = publish_release(ROOT, args.dist, args.history, args.dry_run)
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
