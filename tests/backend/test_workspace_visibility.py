"""Content projection preserves notes/files and never deletes hidden resources."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from slide_notes.application import Application, Environment


class WorkspaceVisibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.patch=patch.object(Environment,'start',Environment.snapshot);self.patch.start()
        self.app=Application(self.base/'config')
        self.info=self.app.open(str(self.base/'workspace'),create=True)
        self.workspace=self.app.get(self.info['id']);self.root=self.workspace.root

    def tearDown(self):
        self.app.stop();self.patch.stop();self.temp.cleanup()

    def write(self,path,text='data'):
        target=self.root/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(text);return target

    def paths(self,path=''):
        return {entry['path'] for entry in self.workspace.files(path,content_only=True)['entries']}

    def test_existing_papers_pictures_notebooks_survive_source_and_config_filter(self):
        for path in ('slide_notes/server.py','scripts/build.py','layouts/old.json','build/result.txt',
                     'dist/result.txt','sessions/cache.json','README.md','AGENTS.md','LICENSE',
                     'pyproject.toml','requirements.txt','start-notes.sh','notebook.py','notes',
                     '.gitignore','.env','.github/workflows/test.yaml','vite.config.ts','tsconfig.app.json'):
            self.write(path)
        self.write('meam5170/paper.pdf');self.write('picture/one.png');self.write('idea.md')
        self.workspace.create('Original')
        self.assertEqual(self.paths(),{'notebooks','meam5170','picture','idea.md'})
        self.assertEqual(self.paths('meam5170'),{'meam5170/paper.pdf'})
        filtered={entry['path'] for entry in self.workspace.search(content_only=True)['entries']}
        self.assertEqual(filtered,{'notebooks/Original.json','meam5170/paper.pdf','picture/one.png','idea.md'})
        self.assertIn('pyproject.toml',{entry['path'] for entry in self.workspace.files()['entries']})
        self.assertEqual((self.root/'pyproject.toml').read_text(),'data')

    def test_src_checkout_hides_software_roots_and_keeps_personal_content(self):
        for path in ('src/slide_notes/web/server.py', 'src/slide_notes/example.json',
                     'frontend/src/workbench/app.js', 'tests/fixtures/note.json',
                     'docs/guides/agent.md', 'scripts/export_release.py', 'pyproject.toml'):
            self.write(path)
        self.write('material/research.pdf');self.write('picture/chart.png');self.write('idea.md')
        self.workspace.create('Kept note')
        self.assertEqual(self.paths(), {'notebooks', 'material', 'picture', 'idea.md'})
        filtered = {entry['path'] for entry in self.workspace.search(content_only=True)['entries']}
        self.assertEqual(filtered, {'notebooks/Kept note.json', 'material/research.pdf', 'picture/chart.png', 'idea.md'})
        self.assertTrue((self.root/'src/slide_notes/web/server.py').exists())
        self.assertIn('src', {entry['path'] for entry in self.workspace.files()['entries']})

    def test_imported_config_like_names_are_user_files_and_survive_restart_move_and_restore(self):
        self.write('README.md','original project doc')
        result=self.workspace.import_file('README.md',io.BytesIO(b'user document'),13)
        path=result['path'];self.assertEqual(path,'README (1).md');self.assertIn(path,self.paths())
        self.workspace.import_file('config.json',io.BytesIO(b'{}'),2)
        self.assertIn('config.json',self.paths())
        self.workspace.mutate('mkdir','docs')
        self.workspace.mutate('move','config.json','docs/settings.json',self.workspace.impact('config.json')['revision'])
        self.assertIn('docs/settings.json',self.paths('docs'))
        item=self.workspace.mutate('trash','docs/settings.json',revision=self.workspace.impact('docs/settings.json')['revision'])
        self.assertNotIn('docs/settings.json',self.workspace.user_file_paths())
        self.workspace.mutate('restore',item['id']);self.assertIn('docs/settings.json',self.paths('docs'))
        restarted=Application(self.base/'config')
        try:
            again=restarted.get(self.info['id'])
            self.assertIn('docs/settings.json',{entry['path'] for entry in again.files('docs',content_only=True)['entries']})
        finally:restarted.stop()

    def test_user_file_inside_hidden_source_folder_reveals_only_its_ancestors(self):
        self.write('slide_notes/server.py');self.write('pyproject.toml');self.write('slide_notes/settings.json')
        self.workspace.import_file('slide_notes/my-data.csv',io.BytesIO(b'x\n1'),3)
        self.assertIn('slide_notes',self.paths())
        self.assertEqual(self.paths('slide_notes'),{'slide_notes/my-data.csv'})
        self.assertEqual({entry['path'] for entry in self.workspace.search('my-data',content_only=True)['entries']},{'slide_notes/my-data.csv'})
        self.assertEqual(self.workspace.search('settings',content_only=True)['entries'],[])

    def test_created_and_copied_directories_remain_visible_without_unhiding_internal_paths(self):
        self.workspace.mutate('mkdir','settings.json');self.write('settings.json/config.toml')
        self.assertEqual(self.paths('settings.json'),{'settings.json/config.toml'})
        copied=self.workspace.mutate('copy','settings.json','settings.json',self.workspace.impact('settings.json')['revision'])
        self.assertIn(copied['path'],self.paths())
        self.write('settings.json/.slide-notes/secret')
        self.assertNotIn('settings.json/.slide-notes',self.paths('settings.json'))

    def test_metadata_symlink_is_rejected_without_reading_or_writing_outside_workspace(self):
        metadata=self.root/'.slide-notes/user-files.json';outside=self.base/'outside.json';outside.write_text('{"paths":[]}')
        metadata.symlink_to(outside)
        with self.assertRaises(ValueError):self.workspace.files(content_only=True)
        self.assertEqual(outside.read_text(),'{"paths":[]}')

    def test_backend_filter_is_opt_in_and_only_notebooks_view_stays_unchanged(self):
        self.write('package.json','{}');self.write('notebooks/data.csv');note=self.workspace.create('Visible')
        self.assertIn('package.json',{entry['path'] for entry in self.workspace.files()['entries']})
        self.assertNotIn('package.json',self.paths())
        self.assertEqual({entry['path'] for entry in self.workspace.files(notes_only=True)['entries']},{note['path']})
