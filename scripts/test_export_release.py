"""Exercise release boundaries using disposable source/workspace directories."""
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from export_release import ROOT, export_release, reviewed_files


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "source"
        self.root.mkdir()
        self.files = ["README.md", "src/slide_notes/__init__.py", "scripts/release-manifest.json"]
        for name, text in {
            "README.md": "Public source\n",
            "src/slide_notes/__init__.py": "# public application\n",
            "src/slide_notes/static/app.js": "console.log('public');\n",
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.manifest()

    def tearDown(self):
        self.temporary.cleanup()

    def manifest(self, **changes):
        document = {"format": 1, "files": self.files, "trees": ["src/slide_notes/static"]}
        document.update(changes)
        path = self.root / "scripts/release-manifest.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(document))

    def test_export_never_copies_workspace_data_and_hashes_every_public_file(self):
        for name in ("notebooks/private.json", "material/paper.pdf", "picture/photo.png", "sessions/chat.json", ".slide-notes/config.json", ".env", "src/slide_notes/research/private.json", "src/slide_notes/data/old-note.json"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("DO NOT PUBLISH")
        directory, archive_path = export_release(self.base / "public", self.root)
        checksum = json.loads((directory / "SOURCE_MANIFEST.json").read_text())["files"]
        exported = {path.relative_to(directory).as_posix() for path in directory.rglob("*") if path.is_file()}
        self.assertEqual(exported, set(checksum) | {"SOURCE_MANIFEST.json"})
        for name, digest in checksum.items():
            content = (directory / name).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), digest)
            self.assertNotIn(b"DO NOT PUBLISH", content)
        with tarfile.open(archive_path) as archive:
            members = archive.getmembers()
            self.assertTrue(all(member.uname == member.gname == "" for member in members))
            names = {member.name.removeprefix("public/") for member in members if member.isfile()}
            self.assertEqual(names, exported)

    def test_missing_module_blocks_export_before_output_is_created(self):
        nested=self.root / "src/slide_notes/ai/new.py"
        nested.parent.mkdir()
        nested.write_text("# newly added module")
        with self.assertRaisesRegex(ValueError, "ai/new.py"):
            export_release(self.base / "public", self.root)
        self.assertFalse((self.base / "public").exists())
        self.assertFalse((self.base / "public.tar.gz").exists())

    def test_manifest_cannot_include_private_paths_or_escape(self):
        for name in ("../private.txt", "/tmp/private.txt", ".env.local", "notebooks/private.json", "src/slide_notes/research/report.json"):
            with self.subTest(name=name):
                self.manifest(files=self.files + [name])
                with self.assertRaises(ValueError):
                    reviewed_files(self.root)

    def test_symlink_files_and_directories_are_rejected(self):
        external = self.base / "private"
        external.mkdir()
        (external / "secret.txt").write_text("secret")
        link = self.root / "src/slide_notes/static/link"
        for target in (external, external / "secret.txt"):
            with self.subTest(target=str(target)):
                link.symlink_to(target)
                with self.assertRaisesRegex(ValueError, "符号链接"):
                    reviewed_files(self.root)
                link.unlink()

    def test_existing_directory_or_archive_is_never_overwritten(self):
        destination = self.base / "public"
        destination.mkdir()
        (destination / "keep").write_text("unchanged")
        with self.assertRaises(ValueError):
            export_release(destination, self.root)
        self.assertEqual((destination / "keep").read_text(), "unchanged")
        other = self.base / "another"
        Path(str(other) + ".tar.gz").write_text("unchanged archive")
        with self.assertRaises(ValueError):
            export_release(other, self.root)
        self.assertFalse(other.exists())

    def test_repository_manifest_covers_all_current_application_sources(self):
        files = reviewed_files(ROOT)
        for name in ("src/slide_notes/ai/tools.py", "src/slide_notes/ai/workspace_tools.py", "src/slide_notes/ai/tool_trace.py", "src/slide_notes/workspace/image_files.py", "src/slide_notes/workspace/visibility.py", "frontend/src/markdown/markdown-live-preview.js", "frontend/src/markdown/markdown-math-source-map.js", "tests/fixtures/ilqr-cell5.md"):
            self.assertIn(Path(name), files)
        self.assertEqual(files[Path("AGENTS.md")], Path("scripts/release/AGENTS.md"))
        self.assertFalse(any("research" in path.parts for path in files))


if __name__ == "__main__":
    unittest.main()
