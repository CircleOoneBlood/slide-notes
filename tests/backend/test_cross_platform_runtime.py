"""Portable installed-package checks, including a real authenticated kernel."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import psutil

from slide_notes.application import Application, Environment
from slide_notes.ai.command import available as command_available
from slide_notes.ai.service import AIService
from slide_notes.ai.claude import executable as claude_executable
from slide_notes.paths import KERNEL_WORKER, configuration_directory, environment_python
from slide_notes.web.server import connected_worker


class CrossPlatformRuntimeTests(unittest.TestCase):
    def test_native_venv_interpreter_and_configuration_locations(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self.assertEqual(environment_python(home, 'win32'), home / 'Scripts/python.exe')
            self.assertEqual(environment_python(home, 'darwin'), home / 'bin/python')
            self.assertEqual(environment_python(home, 'linux'), home / 'bin/python')
            with patch.dict(os.environ, {}, clear=True), patch('slide_notes.paths.Path.home', return_value=home):
                with patch('slide_notes.paths.sys.platform', 'win32'):
                    self.assertEqual(configuration_directory(), home / 'AppData/Roaming/slide-notes')
                with patch('slide_notes.paths.sys.platform', 'darwin'):
                    self.assertEqual(configuration_directory(), home / 'Library/Application Support/slide-notes')
                legacy = home / '.config/slide-notes'
                legacy.mkdir(parents=True)
                with patch('slide_notes.paths.sys.platform', 'darwin'):
                    self.assertEqual(configuration_directory(), legacy)
                with patch.dict(os.environ, {'SLIDE_NOTES_CONFIG_HOME': str(home / 'custom')}):
                    self.assertEqual(configuration_directory(), home / 'custom')

    def test_unicode_workspace_note_and_ai_configuration_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = Application(root / '配置')
            try:
                info = app.open(str(root / '我的工作区'), create=True, initialize=False)
                workspace = app.get(info['id'])
                created = workspace.create('公式笔记 α')
                document = created['document']
                document['title'] = '中文标题 α'
                document['slides'][0]['cells'] = [{'id': '内容', 'kind': 'markdown',
                    'source': '中文与公式 $x_k$。', 'display': 'normal'}]
                workspace.notebook(created['path'])[1].save(document, created['revision'])
                app.remember(info['id'], notebook=created['path'])
                reread = workspace.document(created['path'])
                self.assertEqual(reread['document']['title'], '中文标题 α')
                self.assertEqual(workspace.files('notebooks')['entries'][0]['title'], '中文标题 α')
                self.assertEqual(app.recent()[0]['name'], '我的工作区')
                self.assertEqual(app.session()['notebooks'][info['id']], created['path'])
                ai = AIService(root / '配置')
                ai.configure({'baseUrl': 'https://example.com/v1', 'model': '中文模型', 'apiKey': 'test-only-key'})
                self.assertEqual(AIService(root / '配置').config(True)['model'], '中文模型')
                self.assertEqual(json.loads(ai.path.read_text(encoding='utf-8'))['apiKey'], 'test-only-key')
                for path in ('../outside.md', '/outside.md'):
                    with self.assertRaises(ValueError): workspace.editable_path(path)
            finally:
                app.stop()

    def test_authenticated_worker_rejects_another_client_and_hides_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # A client that does not possess the key cannot become the worker.
            wrapper = root / 'worker.py'
            wrapper.write_text(
                'import runpy, socket, sys\n'
                'with socket.create_connection(("127.0.0.1", int(sys.argv[2])), timeout=3) as bad:\n'
                '    bad.sendall(b"0" * 32)\n'
                '    assert bad.recv(1) == b""\n'
                f'runpy.run_path({str(KERNEL_WORKER)!r}, run_name="__main__")\n',
                encoding='utf-8',
            )
            connection, process = connected_worker(sys.executable, root, worker_path=wrapper)
            try:
                source = ('import os\n'
                          '答案 = 43\n'
                          'secret_present = "SLIDE_NOTES_WORKER_AUTHKEY" in os.environ\n'
                          'working_directory = os.getcwd()\n'
                          'print("你好")\n答案')
                document = {'version': 1, 'title': 'Kernel', 'slides': [{'id': 'page', 'name': 'Page',
                    'cells': [{'id': 'cell', 'kind': 'code', 'source': source, 'display': 'normal'}]}]}
                connection.send({'document': document})
                self.assertTrue(connection.poll(20), 'kernel did not return a result')
                response = connection.recv()
                self.assertTrue(response['ok'], response)
                self.assertFalse(response['state']['errors'], response)
                values = {item['name']: item['value'] for item in response['state']['variables']}
                self.assertEqual(values['答案'], '43')
                self.assertEqual(values['secret_present'], 'False')
                self.assertEqual(values['working_directory'], repr(str(root)))
                self.assertEqual(response['state']['outputs']['cell']['stdout'], '你好\n')
            finally:
                connection.close()
                if process.is_alive(): process.terminate()
                process.join(5)
                if process.is_alive(): process.kill(); process.join(3)

    def test_stopping_environment_cancels_installer_and_child_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / 'child-pid'
            environment = Environment(root)
            errors = []
            code = ('import pathlib, subprocess, sys, time\n'
                    'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])\n'
                    f'pathlib.Path({str(marker)!r}).write_text(str(child.pid), encoding="utf-8")\n'
                    'print("ready", flush=True)\ntime.sleep(120)\n')
            def install():
                try: environment.command([sys.executable, '-u', '-c', code])
                except RuntimeError as error: errors.append(str(error))
            environment.thread = threading.Thread(target=install, daemon=True)
            environment.thread.start()
            try:
                deadline = time.monotonic() + 10
                while not marker.exists() and time.monotonic() < deadline: time.sleep(.03)
                self.assertTrue(marker.exists(), 'installer child did not start')
                child_pid = int(marker.read_text(encoding='utf-8'))
                environment.stop()
                self.assertFalse(environment.thread.is_alive(), 'installer reader did not stop')
                self.assertIsNotNone(environment.process.poll())
                try: self.assertEqual(psutil.Process(child_pid).status(), psutil.STATUS_ZOMBIE)
                except psutil.NoSuchProcess: pass
            finally:
                environment.stop()

    def test_unsupported_platform_does_not_enable_unsandboxed_commands(self):
        for platform in ('win32', 'darwin'):
            with self.subTest(platform=platform), patch('slide_notes.ai.command.sys.platform', platform):
                self.assertFalse(command_available())

    def test_windows_claude_requires_native_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native = root / '.local/bin/claude.exe'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'test-only executable detection')
            native.chmod(0o755)
            wrapper = root / 'claude.cmd'
            wrapper.write_text('@echo off\n', encoding='utf-8')
            with patch('slide_notes.ai.claude.sys.platform', 'win32'):
                with self.assertRaisesRegex(ValueError, 'claude.exe'):
                    claude_executable(str(wrapper))
                self.assertEqual(claude_executable(str(native)), str(native.resolve()))
                with patch('slide_notes.ai.claude.shutil.which', return_value=str(wrapper)), patch('slide_notes.ai.claude.Path.home', return_value=root):
                    self.assertEqual(claude_executable(), str(native.resolve()))


if __name__ == '__main__':
    unittest.main()
