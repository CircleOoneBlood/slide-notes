#!/usr/bin/env python3
"""Verify installable packages against the reviewed src-layout source."""
import argparse
from pathlib import Path
import tarfile
import zipfile

from export_release import reviewed_files

PRIVATE_PARTS = {"notebooks", "material", "picture", "meam5170", "sessions", ".slide-notes", "research", "node_modules", ".venv", ".git", "__pycache__"}


def check_wheel(source, wheel):
    package = source / "src/slide_notes"
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        for path in package.rglob("*"):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            if path.suffix != ".py" and not path.is_relative_to(package / "static") and not path.is_relative_to(package / "examples") and path.name != "example.json":
                continue
            name = path.relative_to(source / "src").as_posix()
            if name not in names or archive.read(name) != path.read_bytes():
                raise ValueError(f"wheel 缺少或改变了运行资源: {name}")
        if not any(name.endswith("/licenses/LICENSE") for name in names):
            raise ValueError("wheel 缺少项目许可证")
        for name in names:
            parts = Path(name).parts
            if any(part in PRIVATE_PARTS or part.startswith(".env") for part in parts):
                raise ValueError(f"wheel 包含私人或开发目录: {name}")
            if parts[0] in {"tests", "frontend", "scripts", "docs", "src"}:
                raise ValueError(f"wheel 混入开发源码目录: {name}")
    return len(names)


def check_sdist(source, sdist):
    with tarfile.open(sdist) as archive:
        members = {"/".join(Path(entry.name).parts[1:]): entry for entry in archive.getmembers() if entry.isfile()}
        for path in reviewed_files(source):
            name = path.as_posix()
            if name not in members or archive.extractfile(members[name]).read() != (source / path).read_bytes():
                raise ValueError(f"sdist 缺少或改变了开发源码: {name}")
        for name in members:
            if any(part in PRIVATE_PARTS or part.startswith(".env") for part in Path(name).parts):
                raise ValueError(f"sdist 包含私人或开发目录: {name}")
    return len(members)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--sdist", type=Path)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent.parent)
    arguments = parser.parse_args()
    print(f"wheel: {check_wheel(arguments.source, arguments.wheel)} files verified")
    if arguments.sdist:
        print(f"sdist: {check_sdist(arguments.source, arguments.sdist)} files verified")


if __name__ == "__main__":
    main()
