"""Disposable release-rotation checks; never clean the real workspace."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from release import publish_release


class ReleaseRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "repository"
        self.root.mkdir()
        self.dist = self.root / "dist"
        self.files = {"README.md": "Public source", "pyproject.toml": '[project]\nname="slide-notes-local"\nversion="0.3.0"\n', "src/slide_notes/__init__.py": "# source"}
        for name, value in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
        manifest = self.root / "scripts/release-manifest.json"
        manifest.parent.mkdir()
        manifest.write_text(json.dumps({"format": 1, "files": [*self.files, "scripts/release-manifest.json"], "trees": []}))

    def tearDown(self):
        self.temporary.cleanup()

    def version(self, version):
        (self.root / "pyproject.toml").write_text(f'[project]\nname="slide-notes-local"\nversion="{version}"\n')

    def test_rotation_keeps_current_and_only_immediate_previous_archive(self):
        publish_release(self.root, self.dist)
        first = (self.dist / "current/slide-notes-0.3.0-source.tar.gz").read_bytes()
        self.version("0.3.1");publish_release(self.root, self.dist)
        self.assertEqual((self.dist / "history/slide-notes-0.3.0-source.tar.gz").read_bytes(), first)
        self.version("0.3.2");publish_release(self.root, self.dist)
        self.assertEqual({p.name for p in self.dist.iterdir()}, {"current", "history"})
        self.assertEqual([p.name for p in (self.dist / "history").iterdir()], ["slide-notes-0.3.1-source.tar.gz"])
        self.assertTrue((self.dist / "current/slide-notes-0.3.2-source/SOURCE_MANIFEST.json").is_file())

    def test_unknown_files_symlinks_and_modified_current_stop_before_cleanup(self):
        publish_release(self.root, self.dist)
        private = self.dist / "keep.txt";private.write_text("user file")
        with self.assertRaisesRegex(ValueError, "未知"):
            publish_release(self.root, self.dist)
        self.assertEqual(private.read_text(), "user file");private.unlink()
        link = self.dist / "link";link.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "符号链接"):
            publish_release(self.root, self.dist)
        link.unlink()
        readme = self.dist / "current/slide-notes-0.3.0-source/README.md";readme.write_text("edited")
        with self.assertRaisesRegex(ValueError, "已被修改"):
            publish_release(self.root, self.dist)
        self.assertEqual(readme.read_text(), "edited")

    def test_dry_run_creates_nothing_and_first_cleanup_requires_history_choice(self):
        plan = publish_release(self.root, self.dist, dry_run=True)
        self.assertEqual(plan["keepHistory"], 1);self.assertFalse(self.dist.exists())
        self.dist.mkdir();(self.dist / "slide-notes-0.2.0-source.tar.gz").write_text("legacy")
        with self.assertRaisesRegex(ValueError, "--history"):
            publish_release(self.root, self.dist)
        self.assertTrue((self.dist / "slide-notes-0.2.0-source.tar.gz").exists())

    def test_bootstrap_keeps_selected_archive_and_rejects_escape(self):
        publish_release(self.root, self.dist)
        current = self.dist / "current"
        archive = current / "slide-notes-0.3.0-source.tar.gz"
        original = archive.read_bytes()
        legacy = self.dist / archive.name;archive.rename(legacy)
        import shutil
        shutil.rmtree(current);(self.dist / "history").rmdir()
        self.version("0.3.1")
        with self.assertRaisesRegex(ValueError, "dist 中"):
            publish_release(self.root, self.dist, self.dist / "../private.tar.gz")
        publish_release(self.root, self.dist, legacy)
        self.assertFalse(legacy.exists())
        self.assertEqual((self.dist / "history/slide-notes-0.3.0-source.tar.gz").read_bytes(), original)

    def test_failed_promotion_restores_the_previous_release(self):
        publish_release(self.root, self.dist)
        archive = self.dist / "current/slide-notes-0.3.0-source.tar.gz"
        original = archive.read_bytes()
        metadata = (self.dist / "current/RELEASE.json").read_bytes()
        self.version("0.3.1")
        rename = Path.rename

        def fail_history(source, target):
            if source.name == "history" and target == self.dist / "history":
                raise OSError("simulated publish failure")
            return rename(source, target)

        with patch.object(Path, "rename", fail_history):
            with self.assertRaisesRegex(OSError, "simulated"):
                publish_release(self.root, self.dist)
        self.assertEqual(archive.read_bytes(), original)
        self.assertEqual((self.dist / "current/RELEASE.json").read_bytes(), metadata)
        self.assertEqual({p.name for p in self.dist.iterdir()}, {"current", "history"})
