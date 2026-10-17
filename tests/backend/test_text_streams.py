"""Installed entry points must support UTF-8 under isolated legacy-codepage pipes."""
import io
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from slide_notes.paths import PACKAGE_ROOT, configure_text_streams


# Select the package imported by this test process. Native installed smoke tests
# therefore exercise that venv's site-packages, never the checkout beside tests.
MODULE_ROOT=PACKAGE_ROOT.parent


class TextStreamTests(unittest.TestCase):
    def isolated(self,body,stdin=b''):
        # Explicit ASCII streams reproduce the Windows redirected-codepage
        # failure without relying on a machine's locale or environment vars.
        bootstrap='''import sys
sys.path.insert(0,sys.argv[1])
for stream in (sys.stdin,sys.stdout,sys.stderr):
    stream.reconfigure(encoding='ascii',errors='strict')
'''
        return subprocess.run([sys.executable,'-I','-c',bootstrap+body,str(MODULE_ROOT)],input=stdin,capture_output=True,timeout=30)

    def test_isolated_launcher_and_cli_help_write_chinese_to_legacy_pipes(self):
        for module in ('launcher','cli'):
            with self.subTest(module=module):
                result=self.isolated(f'from slide_notes import {module}\nsys.argv=["slide-notes","--help"]\n{module}.main()\n')
                self.assertEqual(result.returncode,0,result.stderr.decode('utf-8',errors='replace'))
                self.assertIn('工作区',result.stdout.decode('utf-8'))

    def test_isolated_cli_reads_unicode_json_stdin_and_returns_utf8_json(self):
        document={'version':1,'title':'中文笔记 📝','slides':[{'id':'page','name':'公式与文字','cells':[{'id':'cell','kind':'markdown','source':'中文 $x_k$ 📝','display':'normal'}]}]}
        payload=json.dumps(document,ensure_ascii=False).encode('utf-8')
        result=self.isolated('from slide_notes.cli import main\nsys.exit(main(["validate","--file","-"]))\n',payload)
        self.assertEqual(result.returncode,0,result.stderr.decode('utf-8',errors='replace'))
        output=json.loads(result.stdout.decode('utf-8'))
        self.assertTrue(output['valid'])
        self.assertEqual(output['title'],document['title'])
        self.assertEqual(output['slides'][0]['name'],document['slides'][0]['name'])

    def test_isolated_cli_errors_are_utf8_json_on_stderr(self):
        result=self.isolated('from slide_notes.cli import main\nsys.exit(main(["--url","https://example.com","list"]))\n')
        self.assertEqual(result.returncode,2)
        output=json.loads(result.stderr.decode('utf-8'))
        self.assertFalse(output['ok'])
        self.assertIn('本机 HTTP 地址',output['error'])

    def test_mock_and_absent_streams_are_preserved(self):
        source=io.StringIO('中文');output=io.StringIO()
        with patch.object(sys,'stdin',source),patch.object(sys,'stdout',output),patch.object(sys,'stderr',None):
            configure_text_streams(include_stdin=True)
            self.assertIs(sys.stdin,source)
            self.assertIs(sys.stdout,output)
            self.assertIsNone(sys.stderr)


if __name__=='__main__':unittest.main()
