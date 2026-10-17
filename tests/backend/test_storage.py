import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from slide_notes.application import Application, Environment, write_json
from test_runtime import document


class NotebookStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.root=self.base/'workspace';self.root.mkdir()
        self.patch=patch.object(Environment,'start',Environment.snapshot);self.patch.start()
        self.app=Application(self.base/'config')
    def tearDown(self):
        self.app.stop();self.patch.stop();self.temp.cleanup()
    def note(self,name,source='x = 1'):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(document(source),ensure_ascii=False));return path
    def open(self):
        info=self.app.open(str(self.root));return info,self.app.get(info['id'])

    def test_initialization_scopes_notes_but_leaves_all_files_visible(self):
        (self.root/'notes').write_text('existing CLI entry')
        (self.root/'code').mkdir()
        info,workspace=self.open()
        self.assertEqual(info['notesDirectory'],'notebooks')
        self.assertEqual(workspace.create('new')['path'],'notebooks/new.json')
        workspace.mutate('mkdir','notebooks/empty')
        self.assertEqual({e['path'] for e in workspace.files(notes_only=True)['entries']},{'notebooks/new.json','notebooks/empty'})
        self.assertIn('code',{e['path'] for e in workspace.files()['entries']})
        with self.assertRaises(ValueError): workspace.files('code',notes_only=True)
        with self.assertRaises(ValueError): workspace.create('wrong','code')
        with self.assertRaises(ValueError): workspace.mutate('trash','notebooks',revision=workspace.impact('notebooks')['revision'])
        # New external JSON files after the one-time migration never pollute notebook search.
        self.note('code/hidden.json')
        self.assertEqual([e['path'] for e in workspace.search(notes_only=True)['entries']],['notebooks/new.json'])

    def test_migration_preserves_bytes_relative_paths_session_and_old_links(self):
        original=self.note('old/course/note.json','x = 42');raw=original.read_bytes()
        (original.parent/'data.csv').write_text('data')
        key=hashlib.sha256(str(self.root).encode()).hexdigest()[:20]
        write_json(self.app.config/'session.json',{'workspace':key,'notebooks':{key:'old/course/note.json'}})
        info,workspace=self.open()
        destination=self.root/'notebooks/old/course/note.json'
        self.assertEqual(destination.read_bytes(),raw);self.assertFalse(original.exists())
        self.assertEqual((original.parent/'data.csv').read_text(),'data')
        self.assertEqual(workspace.document('old/course/note.json')['path'],'notebooks/old/course/note.json')
        self.assertEqual(self.app.session()['notebooks'][key],'notebooks/old/course/note.json')
        self.assertEqual(info['notebookAliases']['old/course/note.json'],'notebooks/old/course/note.json')
        restarted=Application(self.app.config)
        try:
            again=restarted.get(key)
            self.assertEqual(len(again.search(notes_only=True)['entries']),1)
            self.assertEqual(again.document('old/course/note.json')['path'],'notebooks/old/course/note.json')
        finally: restarted.stop()

    def test_no_overwrite_and_generated_examples_or_marimo_are_not_migrated(self):
        old=self.note('note.json','x = 10');existing=self.note('notebooks/note.json','x = 20');existing_bytes=existing.read_bytes()
        for name in ['build/lib/copy.json','dist/release/copy.json','slide_notes/example.json','slide_notes/examples/demo.json']:
            self.note(name)
        (self.root/'slide_notes/server.py').write_text('# source')
        (self.root/'pyproject.toml').write_text('[project]')
        (self.root/'notebook.py').write_text('import marimo\napp=marimo.App()')
        self.note('invalid.json');(self.root/'invalid.json').write_text('{"not":"notebook"}')
        info,workspace=self.open()
        self.assertEqual(existing.read_bytes(),existing_bytes)
        self.assertEqual(info['notebookAliases'],{'note.json':'notebooks/note-migrated-2.json'})
        self.assertFalse(old.exists())
        self.assertTrue((self.root/'notebook.py').exists())
        for name in ['build/lib/copy.json','dist/release/copy.json','slide_notes/example.json','slide_notes/examples/demo.json']:
            self.assertTrue((self.root/name).exists())
        self.assertEqual(len(workspace.search(notes_only=True)['entries']),2)

    def test_src_checkout_migration_preserves_application_and_fixture_notebooks(self):
        protected = ['src/slide_notes/example.json', 'src/slide_notes/examples/demo.json',
                     'frontend/public/example.json', 'tests/fixtures/note.json',
                     'docs/example.json', 'scripts/example.json']
        for name in protected:
            self.note(name, 'fixture = 1')
        marker = self.root/'src/slide_notes/web/server.py'
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text('# source checkout')
        (self.root/'pyproject.toml').write_text('[project]')
        before = {name: (self.root/name).read_bytes() for name in protected}
        user = self.note('material/research.json', 'user = 2')
        info, workspace = self.open()
        self.assertEqual(info['notebookAliases'], {'material/research.json': 'notebooks/material/research.json'})
        self.assertFalse(user.exists())
        self.assertEqual(len(workspace.search(notes_only=True)['entries']), 1)
        for name, original in before.items():
            self.assertEqual((self.root/name).read_bytes(), original)

    def test_pending_journal_recovers_move_before_status_was_written(self):
        dest=self.note('notebooks/old.json');self.note('remaining.json','x = 2')
        entries=[]
        for source,target,file in [('old.json','notebooks/old.json',dest),('remaining.json','notebooks/remaining.json',self.root/'remaining.json')]:
            entries.append({'source':source,'destination':target,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'status':'pending'})
        write_json(self.root/'.slide-notes/notes-migration.json',{'version':1,'entries':entries})
        _,workspace=self.open()
        self.assertEqual(len(workspace.search(notes_only=True)['entries']),2)
        self.assertTrue(all(e['status']=='done' for e in json.loads((self.root/'.slide-notes/notes-migration.json').read_text())['entries']))

    def test_notes_directory_symlink_cannot_leak_other_workspace_files(self):
        self.root.joinpath('notebooks').symlink_to(self.base,target_is_directory=True)
        with self.assertRaises(ValueError): self.open()
        self.root.joinpath('notebooks').unlink()
        _,workspace=self.open()
        outside=self.note('code/outside.json')
        (workspace.notes_root/'linked').symlink_to(outside.parent,target_is_directory=True)
        (workspace.notes_root/'linked.json').symlink_to(outside)
        self.assertEqual(workspace.files(notes_only=True)['entries'],[])
        self.assertEqual(workspace.search(notes_only=True)['entries'],[])

    def test_legacy_application_notes_migrate_flat_with_human_names(self):
        source=self.note('slide_notes/data/note-random-id.json')
        doc=json.loads(source.read_text());doc['title']='iLQR';source.write_text(json.dumps(doc))
        raw=source.read_bytes();_,workspace=self.open()
        self.assertEqual((workspace.notes_root/'iLQR.json').read_bytes(),raw)
        self.assertFalse((workspace.notes_root/'slide_notes').exists())
        self.assertEqual(workspace.document('slide_notes/data/note-random-id.json')['path'],'notebooks/iLQR.json')

    def test_previously_migrated_layout_is_flattened_once_and_preserves_old_links(self):
        source=self.note('notebooks/slide_notes/data/note-random.json')
        doc=json.loads(source.read_text());doc['title']='Paper';source.write_text(json.dumps(doc));raw=source.read_bytes()
        existing=self.note('notebooks/Paper.json','x = 99');other=existing.read_bytes()
        write_json(self.root/'.slide-notes/notes-migration.json',{'version':1,'entries':[{'source':'slide_notes/data/note-random.json','destination':'notebooks/slide_notes/data/note-random.json','sha256':digest_bytes(raw),'status':'done'}]})
        info,workspace=self.open()
        self.assertEqual((workspace.notes_root/'Paper-2.json').read_bytes(),raw)
        self.assertEqual(existing.read_bytes(),other)
        self.assertFalse((workspace.notes_root/'slide_notes').exists())
        for old in ('slide_notes/data/note-random.json','notebooks/slide_notes/data/note-random.json'):
            self.assertEqual(workspace.document(old)['path'],'notebooks/Paper-2.json')
        restarted=Application(self.app.config)
        try:
            restored=restarted.get(info['id'])
            self.assertEqual(restored.document('slide_notes/data/note-random.json')['path'],'notebooks/Paper-2.json')
        finally: restarted.stop()

    def test_notebook_rename_updates_title_filename_and_protects_collisions(self):
        _,workspace=self.open();note=workspace.create('before')
        result=workspace.rename_notebook(note['path'],'新名称',note['revision'])
        self.assertEqual(result['path'],'notebooks/新名称.json')
        self.assertEqual(result['document']['title'],'新名称')
        self.assertEqual(result['document']['slides'],note['document']['slides'])
        self.assertFalse((self.root/note['path']).exists())
        workspace.create('taken')
        with self.assertRaises(FileExistsError): workspace.rename_notebook(result['path'],'taken',result['revision'])
        with self.assertRaises(FileExistsError): workspace.rename_notebook(result['path'],'another',note['revision'])
        with self.assertRaises(ValueError): workspace.rename_notebook(result['path'],'../outside',result['revision'])
        with patch.object(Path,'rename',side_effect=OSError('cannot move')):
            with self.assertRaises(OSError): workspace.rename_notebook(result['path'],'failed',result['revision'])
        self.assertEqual(workspace.document(result['path'])['document']['title'],'新名称')

def digest_bytes(raw): return hashlib.sha256(raw).hexdigest()

if __name__=='__main__': unittest.main()
