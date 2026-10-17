"""Release assets are versioned, complete and private-data free before upload."""
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from build_release import build_release, package_versions, project_version, validate_artifacts
from release import current_archive, publish_release


class ReleaseAssetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root = self.base / "repository"
        self.root.mkdir()
        files = {
            "README.md": "Public notes application\n",
            "LICENSE": "MIT public license\n",
            "pyproject.toml": '[project]\nname="slide-notes-local"\nversion="0.3.1"\n',
            "src/slide_notes/__init__.py": "__version__ = '0.3.1'\n",
            "src/slide_notes/static/app.js": "console.log('public');\n",
            "frontend/package.json": json.dumps({"version": "0.3.1"}),
            "frontend/package-lock.json": json.dumps({"version": "0.3.1", "packages": {"": {"version": "0.3.1"}}}),
        }
        for name, value in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
        manifest = self.root / "scripts/release-manifest.json"
        manifest.parent.mkdir()
        manifest.write_text(json.dumps({"format": 1, "files": [*files, "scripts/release-manifest.json"]}), encoding="utf-8")
        private = self.root / "notebooks/private.json"
        private.parent.mkdir()
        private.write_text("PRIVATE NOTE NEVER RELEASE", encoding="utf-8")
        self.output = self.base / "assets"

    def tearDown(self):
        self.temporary.cleanup()

    def fake_build(self, source, packages, python):
        from export_release import reviewed_files
        with zipfile.ZipFile(packages / "slide_notes_local-0.3.1-py3-none-any.whl", "w") as archive:
            for path in (source / "src/slide_notes").rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(source / "src").as_posix())
            archive.writestr("slide_notes_local-0.3.1.dist-info/licenses/LICENSE", "MIT public license")
            archive.writestr("slide_notes_local-0.3.1.dist-info/METADATA", "Metadata-Version: 2.4\nName: slide-notes-local\nVersion: 0.3.1\n")
        with tarfile.open(packages / "slide_notes_local-0.3.1.tar.gz", "w:gz") as archive:
            for relative in reviewed_files(source):
                archive.add(source / relative, arcname="slide_notes_local-0.3.1/" + relative.as_posix())
            metadata = b"Metadata-Version: 2.4\nName: slide-notes-local\nVersion: 0.3.1\n"
            entry = tarfile.TarInfo("slide_notes_local-0.3.1/PKG-INFO")
            entry.size = len(metadata)
            archive.addfile(entry, io.BytesIO(metadata))

    def build(self):
        with patch("build_release.build_packages", side_effect=self.fake_build):
            return build_release(self.output, self.root, "v0.3.1")

    def test_versions_and_tag_are_exact(self):
        self.assertEqual(project_version(self.root, "v0.3.1"), "0.3.1")
        for tag in ("0.3.1", "v0.3.0", "v0.3.1-extra"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                project_version(self.root, tag)
        for filename, value in (("frontend/package.json", '{"version":"0.3.0"}'), ("src/slide_notes/__init__.py", "__version__ = '0.3.0'\n")):
            path = self.root / filename
            original = path.read_text(encoding="utf-8")
            path.write_text(value, encoding="utf-8")
            with self.assertRaises(ValueError):
                project_version(self.root)
            path.write_text(original, encoding="utf-8")

    def test_complete_upload_assets_and_zip_have_verified_public_bytes(self):
        info = self.build()
        self.assertEqual(validate_artifacts(self.output), info)
        self.assertEqual(len(info["uploadAssets"]), 7)
        for relative in info["uploadAssets"]:
            self.assertTrue((self.output / relative).is_file())
        with zipfile.ZipFile(self.output / info["sourceZIP"]) as archive:
            names = archive.namelist()
            self.assertFalse(any("notebooks" in name for name in names))
            self.assertFalse(any(b"PRIVATE NOTE NEVER RELEASE" in archive.read(name) for name in names))
            source = self.output / info["sourceDirectory"]
            for path in source.rglob("*"):
                if path.is_file():
                    self.assertEqual(archive.read(source.name + "/" + path.relative_to(source).as_posix()), path.read_bytes())
        sums = (self.output / "SHA256SUMS").read_text(encoding="utf-8")
        for relative in info["uploadAssets"]:
            if relative != "SHA256SUMS":
                digest = hashlib.sha256((self.output / relative).read_bytes()).hexdigest()
                self.assertIn(digest + "  " + Path(relative).name + "\n", sums)

    def test_existing_output_and_failed_build_never_publish_partial_assets(self):
        self.output.mkdir()
        (self.output / "keep.txt").write_text("preserved", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual((self.output / "keep.txt").read_text(), "preserved")
        other = self.base / "failed"
        with patch("build_release.build_packages", side_effect=RuntimeError("build failed")):
            with self.assertRaises(RuntimeError):
                build_release(other, self.root)
        self.assertFalse(other.exists())

    def test_tampering_paths_symlinks_and_checksum_changes_are_rejected(self):
        info = self.build()
        target = self.output / info["sourceZIP"]
        original = target.read_bytes()
        target.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            validate_artifacts(self.output)
        target.write_bytes(original)
        target.unlink()
        target.symlink_to(self.root / "README.md")
        with self.assertRaisesRegex(ValueError, "ordinary"):
            validate_artifacts(self.output)
        target.unlink()
        target.write_bytes(original)
        metadata = self.output / "RELEASE.json"
        original_metadata = metadata.read_text(encoding="utf-8")
        altered = json.loads(original_metadata)
        altered["assets"][info["sourceZIP"]]["path"] = "../private.zip"
        metadata.write_text(json.dumps(altered), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "path"):
            validate_artifacts(self.output)
        metadata.write_text(original_metadata, encoding="utf-8")
        (self.output / "SHA256SUMS").write_text("wrong", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "SHA256SUMS"):
            validate_artifacts(self.output)

    def test_package_version_and_extended_current_retention_are_checked(self):
        info = self.build()
        wheel = next((self.output / "packages").glob("*.whl"))
        sdist = next((self.output / "packages").glob("*.tar.gz"))
        with self.assertRaisesRegex(ValueError, "version"):
            package_versions(wheel, sdist, "9.9.9")
        self.assertEqual(current_archive(self.output).name, info["sourceArchive"])
        unknown = self.output / "personal.txt"
        unknown.write_text("never remove", encoding="utf-8")
        with self.assertRaises(ValueError):
            current_archive(self.output)
        unknown.unlink()
        dist = self.base / "dist"
        dist.mkdir()
        self.output.rename(dist / "current")
        previous = (dist / "current" / info["sourceArchive"]).read_bytes()
        publish_release(self.root, dist)
        self.assertEqual((dist / "history" / info["sourceArchive"]).read_bytes(), previous)
        self.assertEqual({entry.name for entry in dist.iterdir()}, {"current", "history"})


if __name__ == "__main__":
    unittest.main()
