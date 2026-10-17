"""Agent workflow tests against a real local API and temporary notebooks."""
from _paths import EXAMPLES_ROOT, python_environment
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

from slide_notes.cli import Client, CLIError, apply_operations
from slide_notes.web.server import Store, Workspace, handler_factory
from test_runtime import document


class OperationTests(unittest.TestCase):
    def test_batch_is_atomic_and_rejects_unknown_keys(self):
        original = document('x = 1')
        before = copy.deepcopy(original)
        for operations in (
            [{'op': 'notebook.rename', 'title': 'changed'}, {'op': 'cell.delete', 'id': 'missing'}],
            [{'op': 'cell.update', 'id': 'c0', 'soruce': 'x = 2'}],
            [{'op': 'slide.delete', 'id': 'page'}],
            [{'op': 'cell.update', 'id': 'c0', 'showCode': 'false'}],
        ):
            with self.assertRaises(ValueError):
                apply_operations(original, operations)
            self.assertEqual(original, before)

    def test_order_move_layout_and_unicode_sources(self):
        original = document('x = 1', 'x + 1')
        updated, _ = apply_operations(original, [
            {'op': 'slide.add', 'id': 'second', 'name': '第二页'},
            {'op': 'slide.move', 'id': 'second', 'before': 'page'},
            {'op': 'cell.add', 'id': 'text', 'slide': 'page', 'kind': 'markdown',
             'source': '# 中文公式\n\n$x^2$', 'before': 'c0', 'display': 'fragment'},
            {'op': 'cell.update', 'id': 'c0', 'layout': {'row': 'r1', 'x': 0, 'width': 50}},
            {'op': 'cell.update', 'id': 'c1', 'layout': {'row': 'r1', 'x': 50, 'width': 50}},
            {'op': 'cell.move', 'id': 'c0', 'slide': 'second'},
        ])
        self.assertEqual([s['id'] for s in updated['slides']], ['second', 'page'])
        self.assertNotIn('layout', updated['slides'][0]['cells'][0])
        self.assertEqual(updated['slides'][1]['cells'][0]['source'], '# 中文公式\n\n$x^2$')
        self.assertEqual(original, document('x = 1', 'x + 1'))


class CLITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.path = self.root / 'a.json'
        self.path.write_text(json.dumps(document('x = 2', 'y = x + 3\ny')))
        self.workspace = Workspace(self.root, Store(self.path))
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_factory(self.workspace))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.client = Client(self.url)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.workspace.stop()
        self.thread.join()
        self.tmp.cleanup()

    def cli(self, *args, stdin=None, code=0):
        result = subprocess.run([sys.executable, '-m', 'slide_notes.cli', '--url', self.url, *args],
                                input=stdin, text=True, capture_output=True, timeout=35, cwd=self.root, env=python_environment())
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return json.loads(result.stdout or result.stderr)

    def test_create_select_read_edit_and_delete(self):
        created = self.cli('create', '--title', '新笔记')
        path = created['path']
        page = created['document']['slides'][0]['id']
        args = ('--notebook', path)
        self.cli(*args, 'cell', 'add', '--id', 'intro', '--slide', page, '--kind', 'markdown',
                 '--source-file', '-', stdin='# 你好\n\n$x^2$')
        self.cli(*args, 'cell', 'update', '--id', 'intro', '--display', 'skip')
        cell = self.cli(*args, 'show', '--cell', 'intro')['document']
        self.assertEqual(cell['source'], '# 你好\n\n$x^2$')
        self.assertEqual(cell['display'], 'skip')
        self.assertEqual(len(self.cli('list')['entries']), 2)
        self.assertEqual(self.cli('show')['document']['title'], 'test')
        self.cli(*args, 'cell', 'delete', '--id', 'intro')
        self.assertEqual(self.cli(*args, 'show')['document']['slides'][0]['cells'], [])

    def test_html_cell_round_trip_and_python_runtime_isolation(self):
        source = '<style>body{color:blue}</style><button>拖动</button><script>throw new Error("browser only");</script>'
        before = self.cli('show')
        page = before['document']['slides'][0]['id']
        self.cli('cell', 'add', '--id', 'htmlpreview', '--slide', page, '--kind', 'html',
                 '--source-file', '-', stdin=source)
        cell = self.cli('show', '--cell', 'htmlpreview')['document']
        self.assertEqual(cell['kind'], 'html')
        self.assertEqual(cell['source'], source)
        self.assertTrue(self.cli('validate')['valid'])
        result = self.cli('run')
        self.assertTrue(result['ok'])
        self.assertNotIn('htmlpreview', result['state']['outputs'])
        self.assertFalse(result['state']['errors'])

    def test_dry_run_failed_batch_and_stale_revision_do_not_write(self):
        revision = self.cli('show')['revision']
        before = self.path.read_bytes()
        operations = json.dumps([{'op': 'notebook.rename', 'title': 'new'}])
        result = self.cli('apply', '--file', '-', '--dry-run', stdin=operations)
        self.assertTrue(result['dryRun'])
        self.assertEqual(self.path.read_bytes(), before)
        failed = json.dumps([{'op': 'notebook.rename', 'title': 'new'}, {'op': 'cell.delete', 'id': 'missing'}])
        self.cli('apply', '--file', '-', stdin=failed, code=2)
        self.assertEqual(self.path.read_bytes(), before)
        self.cli('rename', 'changed', '--revision', revision)
        self.cli('rename', 'must not save', '--revision', revision, code=3)
        with self.assertRaises(CLIError) as conflict:
            self.client.request('/api/save', {'path': 'a.json', 'revision': revision, 'document': document('x=9')})
        self.assertEqual(conflict.exception.code, 3)
        with self.assertRaises(CLIError) as conflict:
            self.client.request('/api/run', {'path': 'a.json', 'revision': revision})
        self.assertEqual(conflict.exception.code, 3)
        self.assertEqual(self.cli('show')['document']['title'], 'changed')

    def test_runtime_reads_are_passive_and_mark_stale(self):
        self.assertIsNone(self.cli('runtime')['state'])
        self.assertIsNone(self.workspace.notebook()[2].process)
        run = self.cli('run')
        self.assertEqual(run['state']['outputs']['c1']['result']['text'], '5')
        snapshot = self.cli('runtime', '--view', 'graph')
        self.assertFalse(snapshot['stale'])
        self.assertIn({'from': 'c0', 'to': 'c1', 'variable': 'x'}, snapshot['state']['edges'])
        old = self.cli('runtime', '--view', 'outputs')['state']
        self.assertEqual(old, self.cli('runtime', '--view', 'outputs')['state'])
        self.cli('cell', 'update', '--id', 'c0', '--source', 'x = 7')
        self.assertTrue(self.cli('runtime')['stale'])
        self.assertEqual(self.cli('runtime', '--view', 'outputs')['state'], old)
        self.assertEqual(self.cli('run', '--cell', 'c0')['state']['outputs']['c1']['result']['text'], '10')
        self.cli('interrupt')
        self.assertIsNone(self.cli('runtime')['state'])

    def test_controls_failures_and_source_file(self):
        source = self.root / 'control.py'
        source.write_text('x = note.slider("x", 0, 10, value=2, key="x")\nx')
        self.cli('cell', 'update', '--id', 'c0', '--source-file', str(source))
        state = self.cli('run')['state']
        key = state['outputs']['c0']['controls'][0]['key']
        self.assertEqual(self.cli('run', '--control', key, '6')['state']['outputs']['c1']['result']['text'], '9.0')
        self.cli('cell', 'update', '--id', 'c0', '--source', 'x = 1 / 0')
        failed = self.cli('run', '--view', 'errors', code=4)
        self.assertFalse(failed['ok'])
        self.assertIn('ZeroDivisionError', failed['state']['c0'])
        self.cli('run', '--cell', 'missing', code=2)
        self.cli('run', '--control', key, 'nan', code=2)

    def test_validate_replace_and_path_boundary(self):
        current = self.cli('show')
        changed = copy.deepcopy(current['document'])
        changed['title'] = 'replacement'
        content = json.dumps(changed)
        self.assertTrue(self.cli('validate', '--file', '-', stdin=content)['valid'])
        self.cli('replace', '--file', '-', '--revision', current['revision'], stdin=content)
        self.assertEqual(self.cli('show')['document'], changed)
        self.cli('replace', '--file', '-', '--revision', current['revision'], stdin=content, code=3)
        self.cli('replace', '--file', '-', '--revision', '', stdin=content, code=3)
        self.cli('--notebook', '../outside.json', 'show', code=1)
        self.cli('cell', 'add', code=2)
        self.cli('validate', '--file', '-', stdin='not json', code=2)

    def test_bundled_agent_demo_executes_and_updates_surface(self):
        example = EXAMPLES_ROOT / 'agent-demo.operations.json'
        original = self.path.read_bytes()
        self.cli('apply', '--file', str(example), '--dry-run')
        self.assertEqual(self.path.read_bytes(), original)
        self.cli('apply', '--file', str(example))
        state = self.cli('run')['state']
        self.assertEqual(state['outputs']['agentsurface']['result'], {'kind': 'plotly'})
        graph = self.cli('runtime', '--view', 'graph')['state']
        self.assertIn({'from': 'agentparams', 'to': 'agentsurface', 'variable': 'x1'}, graph['edges'])
        state = self.cli('run', '--control', 'agentparams:x1', '1.2')['state']
        self.assertIn('1.800', state['outputs']['agentparams']['result']['text'])

    def test_real_marimo_cli_events_and_summary(self):
        doc = document('import marimo as mo\nchoice = mo.ui.dropdown({"平方":2,"立方":3}, value="平方")\nchoice',
                       'answer = choice.value\nanswer')
        revision = self.cli('show')['revision']
        self.cli('replace', '--file', '-', '--revision', revision, stdin=json.dumps(doc))
        state = self.cli('run')['state']
        key = state['outputs']['c0']['result']['widgets'][0]['key']
        state = self.cli('run', '--event', key, '["立方"]')['state']
        self.assertEqual(state['outputs']['c1']['result']['text'], '3')
        self.assertEqual(self.cli('runtime')['state']['outputs']['c0']['result']['widgets'][0]['value'], ['立方'])
        self.cli('run', '--event', key, 'bad json', code=2)
        self.cli('run', '--event', key, '["missing"]', code=1)
        from slide_notes.cli import runtime_view
        summary = runtime_view({'errors': {}, 'variables': [], 'outputs': {'a': {'result': {
            'kind': 'marimo', 'html': '', 'widgets': [{'type': 'plotly', 'key': 'mo:test', 'figure': {'data': []}}]
        }}}}, 'summary')
        self.assertNotIn('figure', summary['outputs']['a']['result']['widgets'][0])


if __name__ == '__main__':
    unittest.main()
