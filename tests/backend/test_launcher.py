"""A running API must not make a broken desktop homepage eligible for reuse."""
import io
import base64
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import tempfile
import venv
from email.message import Message
import unittest
from unittest.mock import patch

from slide_notes.launcher import reusable_server, main, desktop_install


def response(body, mime='application/json'):
    result=io.BytesIO(body)
    result.headers=Message()
    result.headers['Content-Type']=mime
    return result


class LauncherTests(unittest.TestCase):
    def test_api_success_does_not_hide_broken_or_obsolete_homepage(self):
        info={'application':'slide-notes','session':None}
        for second in (OSError('404 Not found'),response(b'{"error":"Not found"}'),response(b'<html>Old welcome</html>','text/html')):
            with self.subTest(second=second), patch('slide_notes.launcher.urlopen',side_effect=[response(json.dumps(info).encode()),second]):
                self.assertFalse(reusable_server(2720))
        with patch('slide_notes.launcher.urlopen',return_value=response(b'{"application":"slide-notes"}')) as opening:
            self.assertFalse(reusable_server(2720))
            self.assertEqual(opening.call_count,1)

    def test_healthy_notebook_workbench_is_reusable(self):
        with patch('slide_notes.launcher.urlopen',side_effect=[response(b'{"application":"slide-notes","session":null}'),response(b'<body data-managed-workbench="true"><script src="/workspace-menu.js"></script>','text/html')]):
            self.assertTrue(reusable_server(2721))

    def test_desktop_skips_stale_port_and_opens_healthy_instance(self):
        with patch('sys.argv',['slide-notes']), patch('slide_notes.launcher.ThreadingHTTPServer') as bind, patch('slide_notes.launcher.reusable_server',side_effect=[False,True]) as probe, patch('slide_notes.launcher.webbrowser.open') as browser, patch('sys.stdout',new_callable=io.StringIO):
            main()
            self.assertEqual([call.args[0] for call in probe.call_args_list],[2720,2721])
            browser.assert_called_once_with('http://127.0.0.1:2721/')
            bind.assert_not_called()


class DesktopInstallTests(unittest.TestCase):
    def test_desktop_environment_redirects_all_files_without_system_registration(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ,{'SLIDE_NOTES_DESKTOP_HOME':temporary}), patch('slide_notes.launcher.sys.platform','linux'), patch('slide_notes.launcher.subprocess.run') as run:
                target=desktop_install()
                self.assertEqual(target,Path(temporary)/'applications/slide-notes.desktop')
                run.assert_not_called()

    def test_linux_custom_root_quotes_python_and_does_not_touch_user_desktop(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary)/"空间 O'Brien $test %file"
            executable=base/'venv/bin/python'
            executable.parent.mkdir(parents=True)
            executable.touch()
            with patch('slide_notes.launcher.sys.platform','linux'), patch('slide_notes.launcher.sys.executable',str(executable)), patch('slide_notes.launcher.shutil.which',return_value='/usr/bin/should-not-run'), patch('slide_notes.launcher.subprocess.run') as run:
                target=desktop_install(base/'integration')
                run.assert_not_called()
                content=target.read_text(encoding='utf-8')
                self.assertIn('\\$test %%file',content)
                self.assertIn('-m slide_notes.launcher',content)
                self.assertIn('X-Slide-Notes-Managed=slide-notes-desktop-v1',content)
                self.assertEqual(target.parent,base/'integration/applications')
                self.assertEqual(desktop_install(base/'integration'),target)

    def test_linux_preserves_unrelated_desktop_file_and_icon(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary)
            target=base/'applications/slide-notes.desktop'
            target.parent.mkdir()
            target.write_text('[Desktop Entry]\nName=Another program\n',encoding='utf-8')
            with patch('slide_notes.launcher.sys.platform','linux'):
                with self.assertRaises(ValueError): desktop_install(base)
            self.assertIn('Another program',target.read_text())
            self.assertFalse((base/'icons').exists())

    def test_macos_bundle_has_quoted_absolute_interpreter_and_is_updatable(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary)/"空间 O'Brien"
            executable=base/'venv/bin/python'
            executable.parent.mkdir(parents=True)
            executable.touch()
            with patch('slide_notes.launcher.sys.platform','darwin'), patch('slide_notes.launcher.sys.executable',str(executable)):
                target=desktop_install(base/'integration')
                launcher=target/'Contents/MacOS/slide-notes'
                command=shlex.split(launcher.read_text(encoding='utf-8').splitlines()[1])
                self.assertEqual(command,['exec',str(executable),'-m','slide_notes.launcher','$@'])
                with (target/'Contents/Info.plist').open('rb') as incoming: info=plistlib.load(incoming)
                self.assertEqual(info['CFBundleExecutable'],'slide-notes')
                self.assertEqual(target.parent,base/'integration')
                self.assertEqual(desktop_install(base/'integration'),target)
                if os.name!='nt': self.assertTrue(launcher.stat().st_mode & 0o100)

    def test_macos_preserves_unrelated_application(self):
        with tempfile.TemporaryDirectory() as temporary:
            target=Path(temporary)/'Slide Notes.app'
            target.mkdir()
            (target/'user-file').write_text('keep',encoding='utf-8')
            with patch('slide_notes.launcher.sys.platform','darwin'):
                with self.assertRaises(ValueError): desktop_install(temporary)
            self.assertEqual(list(target.iterdir()),[target/'user-file'])

    def test_windows_shortcut_uses_pythonw_and_preserves_unicode_and_quotes(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary)/"空间 O'Brien"
            executable=base/'app/Scripts/python.exe'
            executable.parent.mkdir(parents=True)
            executable.touch()
            executable.with_name('pythonw.exe').touch()
            integration=base/'integration'
            def save_shortcut(target,interpreter,working_directory):
                self.assertEqual(target,integration/'Slide Notes.lnk')
                self.assertEqual(interpreter,executable.with_name('pythonw.exe'))
                self.assertEqual(working_directory,Path.home())
                (integration/'Slide Notes.lnk').write_bytes(b'fake COM shortcut')
            with patch('slide_notes.launcher.sys.platform','win32'), patch('slide_notes.launcher.sys.executable',str(executable)), patch('slide_notes.launcher._create_windows_shortcut',side_effect=save_shortcut), patch('slide_notes.launcher.subprocess.run') as run:
                target=desktop_install(integration)
                self.assertEqual(target.parent,integration)
                self.assertTrue((integration/'Slide Notes.lnk.slide-notes-managed').is_file())
                self.assertEqual(desktop_install(integration),target)
                run.assert_not_called()

    def test_windows_preserves_unrelated_shortcut_without_running_powershell(self):
        with tempfile.TemporaryDirectory() as temporary:
            target=Path(temporary)/'Slide Notes.lnk'
            target.write_bytes(b'user shortcut')
            with patch('slide_notes.launcher.sys.platform','win32'), patch('slide_notes.launcher.subprocess.run') as run:
                with self.assertRaises(ValueError): desktop_install(temporary)
                run.assert_not_called()
            self.assertEqual(target.read_bytes(),b'user shortcut')

    @unittest.skipUnless(sys.platform=='win32','requires native Windows Shell Link integration')
    def test_native_windows_shortcut_is_confined_to_custom_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            target=desktop_install(temporary)
            self.assertEqual(target,Path(temporary)/'Slide Notes.lnk')
            self.assertTrue(target.is_file())

    @unittest.skipUnless(sys.platform=='win32','requires native Windows Unicode Shell Link integration')
    def test_native_windows_shortcut_round_trips_unicode_spaces_and_apostrophe(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary)/"安装目录 空间 O'Brien"
            environment=base/'app'
            venv.EnvBuilder(with_pip=False).create(environment)
            executable=environment/'Scripts/python.exe'
            integration=base/"安装桌面 O'Brien"
            with patch('slide_notes.launcher.sys.executable',str(executable)):
                target=desktop_install(integration)
                self.assertEqual(desktop_install(integration),target)
            # Read through the independent Shell property store, not the writer
            # or a script-based target-path setter.
            quoted=lambda value:"'"+str(value).replace("'","''")+"'"
            script=("$ErrorActionPreference='Stop'; "
                    "$shell=New-Object -ComObject Shell.Application; "
                    f'$folder=$shell.NameSpace({quoted(integration)}); '
                    "$item=$folder.ParseName('Slide Notes.lnk'); "
                    "$data=@{target=$item.ExtendedProperty('System.Link.TargetParsingPath'); "
                    "arguments=$item.ExtendedProperty('System.Link.Arguments')} | ConvertTo-Json -Compress; "
                    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($data))")
            command=base64.b64encode(script.encode('utf-16-le')).decode('ascii')
            result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',command],
                                  capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            properties=json.loads(base64.b64decode(result.stdout.strip()).decode('utf-8'))
            self.assertEqual(Path(properties['target']).resolve(),executable.with_name('pythonw.exe').resolve())
            self.assertEqual(properties['arguments'],'-m slide_notes.launcher')
            self.assertEqual(target.parent,integration)

    @unittest.skipIf(sys.platform=='win32','requires POSIX installer')
    def test_source_installer_rejects_unrelated_install_directory_before_pip(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary)/"空间 O'Brien"
            base.mkdir()
            sentinel=base/'user-file'
            sentinel.write_text('keep',encoding='utf-8')
            installer=Path(__file__).resolve().parents[2]/'install.sh'
            env=dict(os.environ,SLIDE_NOTES_INSTALL_DIR=str(base),SLIDE_NOTES_BIN_DIR=str(base/'bin'),SLIDE_NOTES_PYTHON=sys.executable)
            result=subprocess.run(['bash',str(installer)],capture_output=True,text=True,env=env,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('Slide Notes',result.stderr)
            self.assertEqual(list(base.iterdir()),[sentinel])

if __name__=='__main__': unittest.main()
