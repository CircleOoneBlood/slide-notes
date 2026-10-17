"""Workspace lifecycle and filesystem integration; all data lives in temp directories."""
from _paths import python_environment
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer

from slide_notes.application import Application, Environment
from slide_notes.web.server import handler_factory


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.start = patch.object(Environment, 'start', Environment.snapshot)
        self.start.start()
        self.app = Application(self.root/'config')
        self.info = self.app.open(str(self.root/'notes'), create=True)
        self.workspace = self.app.get(self.info['id'])

    def tearDown(self):
        self.app.stop()
        self.start.stop()
        self.temp.cleanup()

    def test_create_filtered_tree_and_environment_separation(self):
        self.workspace.mutate('mkdir', 'notebooks/课程')
        note = self.workspace.create('函数', 'notebooks/课程')
        (self.workspace.root/'notebooks/课程/readme.txt').write_text('data')
        self.assertEqual(note['path'], 'notebooks/课程/函数.json')
        self.assertTrue(note['managed'])
        self.assertEqual([e['name'] for e in self.workspace.files(notes_only=True)['entries']], ['课程'])
        self.assertEqual(len(self.workspace.files('notebooks/课程')['entries']), 2)
        self.assertEqual(len(self.workspace.files('notebooks/课程', True)['entries']), 1)
        self.assertEqual(self.workspace.environment.python, self.workspace.root/'.slide-notes/venv/bin/python')

    def test_move_open_folder_preserves_store_runner_and_saves_at_new_path(self):
        self.workspace.mutate('mkdir', 'notebooks/old')
        note = self.workspace.create('note', 'notebooks/old')
        _, store, runner = self.workspace.notebook(note['path'])
        revision = self.workspace.impact('notebooks/old')['revision']
        self.workspace.mutate('move', 'notebooks/old', 'notebooks/new', revision)
        _, next_store, next_runner = self.workspace.notebook('notebooks/new/note.json')
        self.assertIs(store, next_store)
        self.assertIs(runner, next_runner)
        doc = note['document']; doc['title'] = 'Saved after moving'
        store.save(doc, note['revision'])
        self.assertFalse((self.workspace.root/'notebooks/old').exists())
        self.assertEqual(self.workspace.document('notebooks/new/note.json')['document']['title'], doc['title'])

    def test_trash_counts_hidden_files_restore_and_collision(self):
        self.workspace.mutate('mkdir', 'notebooks/folder')
        self.workspace.create('note', 'notebooks/folder')
        (self.workspace.root/'notebooks/folder/data.csv').write_text('x,y\n1,2')
        impact = self.workspace.impact('notebooks/folder')
        self.assertEqual((impact['notes'], impact['otherFiles']), (1, 1))
        item = self.workspace.mutate('trash', 'notebooks/folder', revision=impact['revision'])
        self.assertFalse((self.workspace.root/'notebooks/folder').exists())
        self.assertEqual(len(self.workspace.trash_list()['entries']), 1)
        self.workspace.mutate('mkdir', 'notebooks/folder')
        with self.assertRaises(FileExistsError): self.workspace.mutate('restore', item['id'])
        (self.workspace.root/'notebooks/folder').rmdir()
        self.workspace.mutate('restore', item['id'])
        self.assertEqual((self.workspace.root/'notebooks/folder/data.csv').read_text(), 'x,y\n1,2')
        self.assertEqual(self.workspace.trash_list()['entries'], [])

    def test_equivalent_relative_paths_keep_live_store_keys_canonical(self):
        self.workspace.mutate('mkdir', 'notebooks/folder')
        note = self.workspace.create('note', 'notebooks/folder')
        _, original, _ = self.workspace.notebook(note['path'])
        revision = self.workspace.impact('notebooks/folder//note.json')['revision']
        self.workspace.mutate('move', 'notebooks/folder//note.json', 'notebooks/folder/./other.json', revision)
        self.assertIs(self.workspace.notebook('notebooks/folder/other.json')[1], original)
        self.assertNotIn('notebooks/folder/note.json', self.workspace.stores)

    def test_stale_revisions_no_overwrites_and_no_moving_active_kernel(self):
        note = self.workspace.create('one')
        revision = self.workspace.impact(note['path'])['revision']
        doc = note['document']; doc['title'] = 'edited'
        self.workspace.notebook(note['path'])[1].save(doc, note['revision'])
        with self.assertRaises(FileExistsError): self.workspace.mutate('trash', note['path'], revision=revision)
        revision = self.workspace.impact(note['path'])['revision']
        self.workspace.create('two')
        with self.assertRaises(FileExistsError): self.workspace.mutate('move', note['path'], 'notebooks/two.json', revision)
        runner = self.workspace.notebook(note['path'])[2]
        with runner.lock:
            with self.assertRaises(ValueError): self.workspace.mutate('trash', note['path'], revision=revision)
        self.assertTrue((self.workspace.root/note['path']).exists())

    def test_paths_reserved_directories_and_symlinks(self):
        for path in ('', '../escape', '/tmp/escape', '.slide-notes/bad', '.venv/bad'):
            with self.subTest(path=path), self.assertRaises(ValueError): self.workspace.mutate('mkdir', path)
        (self.workspace.root/'link').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): self.workspace.mutate('mkdir', 'link/bad')
        self.workspace.mutate('mkdir', 'parent')
        with self.assertRaises(ValueError): self.workspace.mutate('move', 'parent', 'parent/child', self.workspace.impact('parent')['revision'])
        (self.workspace.root/'notebooks/示例笔记').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): self.app.examples(self.info['id'])

    def test_multiple_workspaces_restart_and_examples(self):
        second = self.app.open(str(self.root/'second'), create=True)
        self.assertNotEqual(self.info['id'], second['id'])
        with self.assertRaises(ValueError): self.app.get()
        self.workspace.create('only-first')
        self.assertEqual(self.app.get(second['id']).search(notes_only=True)['entries'], [])
        paths = self.app.examples(self.info['id'])['paths']
        (self.workspace.root/paths[0]).write_text('user changed')
        self.app.examples(self.info['id'])
        self.assertEqual((self.workspace.root/paths[0]).read_text(), 'user changed')
        restarted = Application(self.root/'config')
        try:
            self.assertEqual(restarted.get(self.info['id']).root, self.workspace.root)
            self.assertEqual(len(restarted.home()['recent']), 2)
        finally: restarted.stop()

    def test_http_home_assets_cli_and_scoped_file_operations(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_factory(application=self.app))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def cli(*args):
            result = subprocess.run([sys.executable, '-m', 'slide_notes.cli', '--url', base,
                '--workspace', self.info['id'], *args], capture_output=True, text=True, env=python_environment())
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        try:
            for path, marker in [('/', b'data-managed-workbench="true"'), ('/editor', b'new-notebook'), ('/obsidian-markdown.bundle.js', b'ObsidianMarkdown'), ('/obsidian-math.bundle.js', b'ObsidianMath'), ('/obsidian-markdown.css', b'.obsidian-markdown'), ('/vendor/mathjax/MathJax_Main-Regular.woff', b'wOFF'), ('/vendor/katex/katex.min.css', b'katex'), ('/editor.bundle.js', b'NotebookCodeEditor'), ('/pdf-reader.html', b'viewerContainer'), ('/pdf-reader.mjs', b'PDFViewer'), ('/vendor/pdfjs/pdf.worker.mjs', b'pdfjsVersion'), ('/vendor/pdfjs/standard_fonts/FoxitSerif.pfb', b'ChromSerifOTF')]:
                with urlopen(base+path) as response: self.assertIn(marker, response.read())
            self.assertEqual(len(cli('workspace', 'list')['recent']), 1)
            self.assertEqual(cli('workspace', 'environment')['status'], 'missing')
            cli('files', 'mkdir', 'notebooks/new')
            note = cli('create', '--title', 'cli', '--directory', 'notebooks/new')
            info = cli('files', 'impact', note['path'])
            cli('files', 'move', note['path'], 'notebooks/renamed.json', '--revision', info['revision'])
            listing = cli('files', 'list', '--notes-only')
            self.assertIn('notebooks/renamed.json', [e['path'] for e in listing['entries']])
            self.assertFalse((self.workspace.root/'notebooks/new/cli.json').exists())
            with urlopen(base+'/api/app/workspace?workspace='+self.info['id']) as response:
                self.assertEqual(json.load(response)['id'], self.info['id'])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_editor_tabs_persist_independently_and_reject_invalid_paths(self):
        note = self.workspace.create('Tabs')
        (self.workspace.root/'lecture.pdf').write_bytes(b'%PDF-1.4\n%%EOF')
        editors = {'tabs': [{'kind':'notebook', 'path':note['path']}, {'kind':'pdf', 'path':'lecture.pdf'}], 'active':'lecture.pdf'}
        self.app.remember(self.info['id'], None, editors)
        restarted = Application(self.app.config)
        try:
            self.assertEqual(restarted.session()['editors'][self.info['id']], editors)
            restarted.remember(None)
            self.assertEqual(restarted.session()['editors'][self.info['id']], editors)
            restarted.remember(self.info['id'], None, {'tabs':[], 'active':None})
            self.assertEqual(restarted.session()['editors'][self.info['id']]['tabs'], [])
        finally: restarted.stop()
        original = self.app.session()
        for invalid in [ {'tabs':[{'kind':'pdf','path':'../outside.pdf'}], 'active':None},
                         {'tabs':[], 'active':'missing'}, {'tabs':[{'kind':'html','path':'lecture.pdf'}]} ]:
            with self.assertRaises(ValueError): self.app.remember(self.info['id'], None, invalid)
            self.assertEqual(self.app.session(), original)

    def test_images_read_only_get_head_svg_and_containment(self):
        import base64
        raw=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=')
        (self.workspace.root/'sample.PNG').write_bytes(raw)
        (self.workspace.root/'fake.png').write_text('<html>not an image</html>')
        (self.workspace.root/'plot.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>')
        (self.workspace.root/'bad.svg').write_text('<!DOCTYPE svg [<!ENTITY name "x">]><svg/>')
        (self.root/'outside.png').write_bytes(raw);(self.workspace.root/'link.png').symlink_to(self.root/'outside.png')
        self.assertEqual(self.workspace.describe(self.workspace.root/'sample.PNG')['kind'],'image')
        editors={'tabs':[{'kind':'image','path':'sample.PNG'}],'active':'sample.PNG'}
        self.app.remember(self.info['id'],None,editors);self.assertEqual(self.app.session()['editors'][self.info['id']],editors)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_factory(application=self.app));threading.Thread(target=server.serve_forever,daemon=True).start()
        base=f'http://127.0.0.1:{server.server_port}/api/image?workspace={self.info["id"]}&path='
        try:
            with urlopen(base+'sample.PNG') as response:
                self.assertEqual(response.headers['Content-Type'],'image/png');self.assertEqual(response.read(),raw)
            with urlopen(Request(base+'sample.PNG',method='HEAD')) as response:self.assertEqual(response.read(),b'');self.assertEqual(int(response.headers['Content-Length']),len(raw))
            with urlopen(base+'plot.svg') as response:
                self.assertEqual(response.headers['Content-Type'],'image/svg+xml');self.assertIn('sandbox',response.headers['Content-Security-Policy']);response.read()
            with urlopen(base+'sample.PNG&download=1') as response:self.assertTrue(response.headers['Content-Disposition'].startswith('attachment'));response.read()
            for path in ['../outside.png','link.png','fake.png','missing.png','bad.svg']:
                with self.assertRaises(HTTPError) as error:urlopen(base+path)
                self.assertEqual(error.exception.code,400)
            self.assertEqual((self.workspace.root/'sample.PNG').read_bytes(),raw)
        finally:server.shutdown();server.server_close()

    def test_pdf_stream_ranges_download_and_workspace_containment(self):
        raw = b'%PDF-1.4\n' + b'x' * 140000 + b'\n%%EOF'
        (self.workspace.root/'lecture.pdf').write_bytes(raw)
        (self.workspace.root/'fake.pdf').write_text('<html>not a PDF</html>')
        (self.root/'outside.pdf').write_bytes(raw)
        (self.workspace.root/'link.pdf').symlink_to(self.root/'outside.pdf')
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_factory(application=self.app))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}/api/pdf?workspace={self.info["id"]}&path='
        try:
            with urlopen(base+'lecture.pdf') as response:
                self.assertEqual(response.headers['Content-Type'], 'application/pdf')
                self.assertEqual(response.read(), raw)
            with urlopen(Request(base+'lecture.pdf', method='HEAD')) as response:
                self.assertEqual(int(response.headers['Content-Length']), len(raw))
                self.assertEqual(response.read(), b'')
            for header, expected in [('bytes=5-12',raw[5:13]), ('bytes=-20',raw[-20:]), ('bytes=140000-',raw[140000:])]:
                with urlopen(Request(base+'lecture.pdf', headers={'Range':header})) as response:
                    self.assertEqual(response.status, 206)
                    self.assertEqual(response.read(), expected)
            with urlopen(base+'lecture.pdf&download=1') as response:
                self.assertTrue(response.headers['Content-Disposition'].startswith('attachment'))
            for path in ['../outside.pdf','link.pdf','fake.pdf','missing.pdf']:
                with self.assertRaises(HTTPError) as error: urlopen(base+path)
                self.assertEqual(error.exception.code, 400)
            for header in ['bytes=999999-', 'bytes=-0', 'bytes=3-1', 'bytes=1-2,4-5']:
                with self.assertRaises(HTTPError) as error: urlopen(Request(base+'lecture.pdf', headers={'Range':header}))
                self.assertEqual(error.exception.code, 416)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_session_restores_workspace_and_notebook_across_restart(self):
        first = self.workspace.create('first')
        self.app.remember(self.info['id'], first['path'])
        second = self.app.open(str(self.root/'second'), create=True)
        second_note = self.app.get(second['id']).create('second')
        self.app.remember(second['id'], second_note['path'])
        restarted = Application(self.root/'config')
        try:
            session = restarted.home()['session']
            self.assertEqual(session['workspace'], second['id'])
            self.assertEqual(session['notebooks'][self.info['id']], first['path'])
            self.assertEqual(restarted.get(session['workspace']).document(session['notebooks'][second['id']])['document']['title'], 'second')
            restarted.remember(None)
            self.assertIsNone(restarted.home()['session']['workspace'])
            self.assertEqual(restarted.home()['session']['notebooks'][second['id']], second_note['path'])
        finally: restarted.stop()

if __name__ == '__main__': unittest.main()
