"""A shipped worker must retain its workspace interpreter's dependency priority."""
from _paths import PACKAGE_ROOT
import os
from pathlib import Path
import shutil
import site
import socket
import subprocess
import sys
import tempfile
import unittest
import venv
from multiprocessing.connection import Connection


class WorkerBootstrapTests(unittest.TestCase):
    def test_host_package_parent_does_not_shadow_workspace_dependencies(self):
        with tempfile.TemporaryDirectory(prefix='notes-worker-priority-') as directory:
            root = Path(directory)
            host_site = root / 'host-site-packages'
            package = host_site / 'slide_notes'
            for source in PACKAGE_ROOT.rglob('*.py'):
                target = package / source.relative_to(PACKAGE_ROOT)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            marker = 'notes_worker_priority_probe'
            (host_site / (marker + '.py')).write_text("origin = 'host'\n")
            with (package / '__init__.py').open('a') as stream:
                stream.write(f'\nfrom {marker} import origin as bootstrap_origin\n')

            # Use a genuinely separate interpreter. Reuse only the test runner's
            # installed dependencies; its parent directory is not the fake host.
            environment_root = root / 'workspace-venv'
            venv.EnvBuilder(with_pip=False).create(environment_root)
            python = environment_root / 'bin/python'
            workspace_site = Path(subprocess.check_output(
                [str(python), '-c', 'import site; print(site.getsitepackages()[0])'],
                text=True,
            ).strip())
            (workspace_site / (marker + '.py')).write_text("origin = 'workspace'\n")
            environment = os.environ.copy()
            environment['PYTHONPATH'] = os.pathsep.join(site.getsitepackages())
            workspace = root / 'workspace'
            workspace.mkdir()
            parent, child = socket.socketpair()
            connection = Connection(parent.detach())
            process = None
            try:
                process = subprocess.Popen(
                    [str(python), str(package / 'notebook/kernel_worker.py'),
                     str(child.fileno()), str(workspace)],
                    pass_fds=(child.fileno(),), env=environment,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                child.close()
                source = ('import slide_notes, sys\n'
                          'origin = slide_notes.bootstrap_origin\n'
                          f'host_parent_visible = {str(host_site)!r} in sys.path\n'
                          'origin')
                document = {'version': 1, 'title': 'Worker priority', 'slides': [
                    {'id': 'page', 'name': 'Page', 'cells': [
                        {'id': 'cell', 'kind': 'code', 'source': source, 'display': 'normal'}
                    ]}
                ]}
                connection.send({'document': document})
                self.assertTrue(connection.poll(20), 'workspace worker failed to respond')
                response = connection.recv()
                self.assertTrue(response['ok'], response)
                self.assertFalse(response['state']['errors'], response)
                values = {item['name']: item['value'] for item in response['state']['variables']}
                self.assertEqual(values['origin'], "'workspace'")
                self.assertEqual(values['host_parent_visible'], 'False')
            finally:
                child.close()
                connection.close()
                if process is not None:
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
