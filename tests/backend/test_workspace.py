import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from slide_notes.web.server import Store, Workspace, validate
from test_runtime import document


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.a = self.root / "a.json"
        self.a.write_text(json.dumps(document("x = 1")))
        self.workspace = Workspace(self.root, Store(self.a))

    def tearDown(self):
        self.workspace.stop()
        self.temp.cleanup()

    def test_notes_filter_validates_format_and_finds_nested_notes(self):
        (self.root / "nested").mkdir()
        (self.root / "nested/b.json").write_text(json.dumps(document("x = 2")))
        (self.root / "invalid.json").write_text('{"version":1,"title":"bad","slides":[{"name":"broken","cells":[3]}]}')
        (self.root / "settings.json").write_text('{"value":4}')
        (self.root / "original.py").write_text('import marimo\napp = marimo.App()')
        (self.root / ".venv").mkdir()
        (self.root / ".venv/ignored.json").write_text(self.a.read_text())
        found = self.workspace.search(notes_only=True)["entries"]
        self.assertEqual({e["path"] for e in found}, {"a.json", "nested/b.json", "original.py"})
        self.assertIn("invalid.json", {e["path"] for e in self.workspace.files()["entries"]})
        self.assertEqual(self.workspace.files(".venv")["entries"][0]["name"], "ignored.json")

    def test_traversal_and_external_symlinks_are_rejected(self):
        with self.assertRaises(ValueError): self.workspace.resolve("../outside")
        (self.root / "external").symlink_to(self.root.parent, target_is_directory=True)
        entry = self.workspace.describe(self.root / "external")
        self.assertTrue(entry["unavailable"])
        with self.assertRaises(ValueError): self.workspace.files("external")

    def test_python_source_strings_comments_and_tests_are_not_notebooks(self):
        sources = {
            "server.py": 'source = "import marimo; app = marimo.App()"',
            "test_workspace.py": 'def test_file():\n    source = "import marimo; app = marimo.App()"',
            "comments.py": '# import marimo\n# app = marimo.App()',
            "helper.py": 'import marimo\ndef make_app():\n    return marimo.App()',
            "broken.py": 'import marimo\napp = marimo.App(',
            "alias.py": 'import marimo as mo\napp = mo.App()',
            "imported.py": 'from marimo import App as Notebook\napp: Notebook = Notebook()',
        }
        for name, source in sources.items():
            (self.root / name).write_text(source)
        found = self.workspace.search(notes_only=True)["entries"]
        self.assertEqual({e["path"] for e in found}, {"a.json", "alias.py", "imported.py"})
        self.assertEqual(self.workspace.describe(self.root / "server.py")["kind"], "file")

    def test_only_bundled_template_is_excluded_not_user_example_files(self):
        template = self.root / "example.json"
        template.write_text(self.a.read_text())
        (self.root / "notes").mkdir()
        user_note = self.root / "notes/example.json"
        user_note.write_text(self.a.read_text())
        with patch("slide_notes.web.server.TEMPLATE_PATH", template):
            found = self.workspace.search(notes_only=True)["entries"]
            self.assertEqual({e["path"] for e in found}, {"a.json", "notes/example.json"})
            self.assertEqual(self.workspace.describe(template)["kind"], "template")
            self.assertIn("example.json", {e["name"] for e in self.workspace.files()["entries"]})

    def test_separate_revisions_stores_and_kernels(self):
        created = self.workspace.create("second")
        a_key, a, a_runner = self.workspace.notebook("a.json")
        b_key, b, b_runner = self.workspace.notebook(created["path"])
        self.assertIsNot(a_runner, b_runner)
        self.assertNotEqual(a_key, b_key)
        old = a.get()
        changed = b.get()["document"]
        changed["title"] = "only second"
        b.save(changed, created["revision"])
        self.assertEqual(a.get(), old)
        self.assertEqual(b.get()["document"]["title"], "only second")

    def test_switching_never_reuses_another_documents_revision(self):
        second = self.workspace.create("second")
        _, a, _ = self.workspace.notebook("a.json")
        with self.assertRaises(FileExistsError): a.save(second["document"],second["revision"])
        self.assertEqual(a.get()["document"],document("x = 1"))

    def test_layout_survives_save_reload_without_changing_sources(self):
        current = self.workspace.document("a.json")
        doc = document("x = 1", "x + 2")
        doc["slides"][0]["cells"][0]["layout"] = {"row": "row1", "x": 0, "width": 35.5, "snapLeft": False, "snapTop": False, "snapBottom": True, "column": "right", "y": 42.5, "height": 200}
        doc["slides"][0]["cells"][1]["layout"] = {"row": "row1", "x": 45.5, "width": 54.5, "snapRight": True, "gapBefore": 137.5}
        Store(self.a).save(doc, current["revision"])
        self.assertEqual(Store(self.a).get()["document"], doc)
        self.assertEqual(self.workspace.search(notes_only=True)["entries"][0]["kind"], "notebook")

    def test_malformed_layout_is_rejected_and_legacy_notes_are_valid(self):
        validate(document("x = 1"))
        for layout in (None, [], {"width": True}, {"width": float("nan")},
                       {"width": float("inf")}, {"width": 0}, {"width": 101},
                       {"row": "bad row"}, {"row": 42}, {"column": "bad column"}, {"column": 42}, {"width": 60, "x": 50},
                       {"width": 50, "x": -1}, {"width": 50, "x": True},
                       {"snapLeft": "false"}, {"snapRight": 0},
                       {"snapTop": "false"}, {"snapBottom": 0},
                       {"y": -1}, {"y": True}, {"y": float("nan")}, {"y": 10001},
                       {"gapBefore": -1}, {"gapBefore": True}, {"gapBefore": float("nan")}, {"gapBefore": 1000001},
                       {"height": 61}, {"height": False}, {"height": float("inf")}, {"height": 10001}):
            with self.subTest(layout=layout):
                doc = document("x = 1")
                doc["slides"][0]["cells"][0]["layout"] = layout
                with self.assertRaises(ValueError): validate(doc)

    def test_preview_is_read_only_and_binary_safe(self):
        (self.root / "file.bin").write_bytes(b"\x00\x01")
        self.assertTrue(self.workspace.preview("file.bin")["binary"])
        before = self.a.read_bytes()
        self.assertIn('x = 1',self.workspace.preview("a.json")["content"])
        self.assertEqual(before,self.a.read_bytes())


if __name__ == "__main__":
    unittest.main()
