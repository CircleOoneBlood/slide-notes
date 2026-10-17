"""Workspace content capabilities, real PDF engine, no user files or models."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from slide_notes.application import Application,Environment
from slide_notes.ai.service import AIService
from slide_notes.ai.tools import NoteAgent
from slide_notes.ai.pdf_reader import available
from slide_notes.ai.command import available as command_available
from test_pdf_ai_context import sample_pdf


class WorkspaceToolTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.environment=patch.object(Environment,'start',Environment.snapshot);self.environment.start()
        self.app=Application(Path(self.temp.name)/'config');info=self.app.open(str(Path(self.temp.name)/'workspace'),create=True);self.workspace=self.app.get(info['id'])
        self.note=self.workspace.create('Origin');self.other=self.workspace.create('Other')
        self.ai=AIService(self.app.config);self.ai.configure({'baseUrl':'http://127.0.0.1:1/v1','model':'fake'})
        self.agent=NoteAgent(self.workspace,self.ai.context(self.workspace,self.note['path']))
        (self.workspace.root/'paper.pdf').write_bytes(sample_pdf())
        (self.workspace.root/'reference.md').write_text('first\nneedle text\nlast\n')
    def tearDown(self):
        self.app.stop();self.environment.stop();self.temp.cleanup()
    def execute(self,name,**args):return self.agent.execute(name,args)
    def test_workspace_listing_search_and_paginated_text(self):
        result,_=self.execute('list_workspace',limit=1);self.assertEqual(len(result['entries']),1);self.assertEqual(result['nextOffset'],1)
        result,_=self.execute('search_workspace',query='needle',mode='text',glob='*.md');self.assertEqual(result['matches'][0]['line'],2)
        result,_=self.execute('search_workspace',query='paper',mode='name');self.assertEqual(result['matches'][0]['path'],'paper.pdf')
        result,_=self.execute('read_file',path='reference.md',startLine=2,limit=1);self.assertEqual(result['text'],'2: needle text');self.assertEqual(result['nextLine'],3)
    def test_cross_notebook_read_edit_and_create_from_pdf_context(self):
        self.agent=NoteAgent(self.workspace,self.ai.context(self.workspace,'paper.pdf'))
        other,_=self.execute('inspect_note',path=self.other['path']);self.assertEqual(other['title'],'Other')
        result,event=self.execute('apply_note_operations',path=self.other['path'],revision=other['revision'],operations=[{'op':'cell.add','slide':other['slides'][0]['id'],'kind':'markdown','source':'Read from PDF'}])
        self.assertEqual(event['path'],self.other['path']);self.assertTrue(result['saved']);self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])
        result,event=self.execute('create_note',title='Reading notes',markdown='## Summary\n\n$x^2$')
        self.assertEqual(event['type'],'workspace-mutation');created=self.workspace.document(result['path']);self.assertEqual(created['document']['slides'][0]['cells'][0]['source'],'## Summary\n\n$x^2$')
        with self.assertRaises(ValueError):self.execute('apply_note_operations',path=self.other['path'],revision=other['revision'],operations=[{'op':'notebook.rename','title':'stale'}])
    def test_text_writes_are_atomic_versioned_and_do_not_overwrite_json_or_code(self):
        current,_=self.execute('read_file',path='reference.md')
        result,event=self.execute('write_text_file',path='reference.md',revision=current['revision'],text='Updated')
        self.assertEqual((self.workspace.root/'reference.md').read_text(),'Updated');self.assertEqual(event['operation'],'write')
        for path in ['code.py',self.note['path'],'AGENTS.md']:
            with self.assertRaises(ValueError):self.execute('write_text_file',path=path,revision='new',text='bad')
        with self.assertRaises(ValueError):self.execute('write_text_file',path='reference.md',revision=current['revision'],text='stale')
        self.execute('write_text_file',path='new.md',revision='new',text='new')
        with self.assertRaises(ValueError):self.execute('write_text_file',path='new.md',revision='new',text='overwrite')
    def test_path_boundaries_reject_absolute_traversal_symlinks_and_configuration(self):
        outside=Path(self.temp.name)/'outside.txt';outside.write_text('secret');(self.workspace.root/'link.txt').symlink_to(outside)
        (self.workspace.root/'.env').write_text('SECRET')
        for path in [str(outside),'../outside.txt','link.txt','.env','.git/config','sessions/workspace.json']:
            with self.assertRaises(ValueError):self.execute('read_file',path=path)
        for name in ['shell','run_python','write_file','change_config']:
            with self.assertRaises(ValueError):self.agent.execute(name,{})
        with self.assertRaises(ValueError):self.execute('read_pdf',path='../outside.pdf')
    def test_move_trash_restore_content_and_protect_software_directories(self):
        self.execute('manage_files',operation='mkdir',path='docs')
        impact,_=self.execute('manage_files',operation='impact',path='reference.md')
        result,event=self.execute('manage_files',operation='move',path='reference.md',destination='docs/reference.md',revision=impact['revision']);self.assertEqual(event['previous'],'reference.md')
        impact,_=self.execute('manage_files',operation='impact',path=result['path']);result,event=self.execute('manage_files',operation='trash',path=result['path'],revision=impact['revision'])
        self.assertFalse((self.workspace.root/'docs/reference.md').exists());trash,_=self.execute('manage_files',operation='trash_list');self.assertEqual(trash['entries'][0]['id'],result['id'])
        self.execute('manage_files',operation='restore',trashId=result['id']);self.assertTrue((self.workspace.root/'docs/reference.md').exists())
        (self.workspace.root/'docs/code.py').write_text('pass')
        with self.assertRaises(ValueError):self.execute('manage_files',operation='trash',path='docs',revision=self.workspace.impact('docs')['revision'])
        with self.assertRaises(ValueError):self.execute('manage_files',operation='move',path='docs/reference.md',destination='docs/code.py',revision=self.workspace.impact('docs/reference.md')['revision'])
    def test_src_checkout_software_is_readonly_while_content_remains_editable(self):
        marker=self.workspace.root/'src/slide_notes/web/server.py'
        marker.parent.mkdir(parents=True,exist_ok=True);marker.write_text('# application')
        (self.workspace.root/'pyproject.toml').write_text('[project]')
        protected=['src/slide_notes/ai/readme.md', 'frontend/src/workbench/readme.md',
                   'tests/fixtures/readme.md', 'docs/guide.md', 'scripts/guide.md',
                   'README.md', 'pyproject.toml', 'notes', 'idea.md']
        for path in protected:
            with self.subTest(path=path):
                target=self.workspace.root/path;target.parent.mkdir(parents=True,exist_ok=True)
                if path!='pyproject.toml':target.write_text('software')
                before=target.read_bytes()
                with self.assertRaises(ValueError):
                    self.execute('write_text_file',path=path,revision='new',text='changed')
                with self.assertRaises(ValueError):
                    self.execute('manage_files',operation='trash',path=path,
                                 revision=self.workspace.impact(path)['revision'])
                self.assertEqual(target.read_bytes(),before)
        for directory in ('src/new', 'frontend/new', 'tests/new', 'docs/new', 'scripts/new'):
            with self.assertRaises(ValueError):
                self.execute('manage_files',operation='mkdir',path=directory)
        self.execute('manage_files',operation='mkdir',path='material')
        for path in ('material/research.md', 'notebooks/research.md'):
            self.execute('write_text_file',path=path,revision='new',text='user content')
            self.assertEqual((self.workspace.root/path).read_text(),'user content')

    def test_no_active_file_can_start_workspace_agent_and_create_note(self):
        request=self.ai.prepare(self.workspace,{'requestId':'workspace-no-file','path':'','scope':'workspace','prompt':'Create notes'})
        agent=request['agent'];caps,_=agent.execute('agent_capabilities',{});self.assertTrue(caps['workspaceAccess']['pdfEngineAvailable']);self.assertIn('read_pdf',caps['workspaceAccess']['tools'])
        self.assertEqual(request['context']['scope'],'workspace');self.assertIn('read_pdf',[t['function']['name'] for t in request['payload']['tools']]);self.ai.jobs.pop(request['id'])
    def test_followup_context_remembers_pdf_progress_without_replaying_pages(self):
        from slide_notes.ai.tool_trace import clean_trace
        trace=[{'tool':'read_pdf','path':'paper.pdf','pages':[1],'pageCount':3,'nextPage':2,'revision':'file-revision'}]
        request=self.ai.prepare(self.workspace,{'requestId':'workspace-progress','path':'','scope':'workspace','prompt':'继续','messages':[{'role':'assistant','content':'已经读完第一页。','toolTrace':trace}]})
        historical=request['payload']['messages'][2]['content'];self.assertIn('"nextPage": 2',historical);self.assertIn('paper.pdf',historical);self.ai.jobs.pop(request['id'])
        with self.assertRaises(ValueError):clean_trace([{'tool':'read_pdf','pages':[True]}])
    @unittest.skipUnless(command_available(),'Bubblewrap unavailable')
    def test_normal_agent_sandbox_computes_and_imports_generated_data(self):
        import shlex
        code='import numpy; print(numpy.arange(4).sum()); open("/scratch/result.csv","w").write("value\\n6\\n")'
        result,_=self.execute('run_command',command='python -c '+shlex.quote(code),timeout=10)
        self.assertEqual(result['exitCode'],0);self.assertIn('6',result['output']);self.assertEqual(result['artifacts'][0]['name'],'result.csv')
        saved,event=self.execute('save_generated_file',runId=result['runId'],artifactId=result['artifacts'][0]['id'],destination='notebooks/assets/result.csv')
        self.assertEqual((self.workspace.root/saved['path']).read_text(),'value\n6\n');self.assertEqual(event['type'],'workspace-mutation')
        with self.assertRaises(FileExistsError):self.execute('save_generated_file',runId=result['runId'],artifactId=result['artifacts'][0]['id'],destination=saved['path'])
        with self.assertRaises(ValueError):self.execute('save_generated_file',runId=result['runId'],artifactId=result['artifacts'][0]['id'],destination='../outside.csv')
    @unittest.skipUnless(command_available(),'Bubblewrap unavailable')
    def test_commands_cannot_read_outside_workspace_inherit_secrets_or_change_originals(self):
        import shlex,os
        outside=Path(self.temp.name)/'private.txt';outside.write_text('OUTSIDE SECRET')
        code='''import os,socket
from pathlib import Path
print("outside",Path(%r).exists())
print("secret",os.environ.get("NOTE_TEST_SECRET"))
try:Path("/workspace/reference.md").write_text("overwritten")
except OSError:print("workspace readonly")
s=socket.socket();s.settimeout(.1)
try:s.connect(("127.0.0.1",1));print("network escaped")
except OSError:print("network isolated")
''' % str(outside)
        with patch.dict(os.environ,{'NOTE_TEST_SECRET':'PRIVATE-ENV'}):result,_=self.execute('run_command',command='python -c '+shlex.quote(code),timeout=10)
        self.assertEqual(result['exitCode'],0);self.assertIn('outside False',result['output']);self.assertIn('secret None',result['output']);self.assertIn('workspace readonly',result['output']);self.assertIn('network isolated',result['output'])
        self.assertEqual((self.workspace.root/'reference.md').read_text(),'first\nneedle text\nlast\n');self.assertEqual(outside.read_text(),'OUTSIDE SECRET')
    @unittest.skipUnless(command_available(),'Bubblewrap unavailable')
    def test_command_timeout_stops_owned_namespace(self):
        result,_=self.execute('run_command',command='sleep 20',timeout=1)
        self.assertEqual(result['exitCode'],124)
    @unittest.skipUnless(available(),'Poppler unavailable')
    def test_pdf_reader_reads_unseen_pages_searches_and_renders_scanned_page(self):
        original=(self.workspace.root/'paper.pdf').read_bytes()
        result,_=self.execute('read_pdf',path='paper.pdf',startPage=2,count=2)
        self.assertEqual(result['pageCount'],3);self.assertIn('SECOND PAGE',result['pages'][0]['text']);self.assertEqual(result['pages'][1]['text'],'');self.assertIn('image',result['pages'][1]);self.assertEqual(len(result['images']),1)
        self.assertNotIn('FIRST PAGE',json.dumps(result));self.assertEqual((self.workspace.root/'paper.pdf').read_bytes(),original)
        found,_=self.execute('search_pdf',path='paper.pdf',query='equation');self.assertEqual(found['matches'][0]['page'],2)
        for args in [{'startPage':4},{'count':True},{'includeImages':True,'count':5},{'textOffset':-1}]:
            with self.assertRaises(ValueError):self.execute('read_pdf',path='paper.pdf',**args)
        visual,_=self.execute('read_pdf',path='paper.pdf',startPage=2,count=1,includeImages=True)
        self.assertTrue(visual['images']);image=self.workspace.root/'sessions/assets'/visual['images'][0]['id'];self.assertTrue(image.is_file())
    @unittest.skipUnless(available(),'Poppler unavailable')
    def test_parallel_pdf_calls_finish_all_tool_responses_before_image_messages(self):
        import copy
        captured=[]
        def provider_round(request,payload):
            captured.append(copy.deepcopy(payload))
            if len(captured)==1:
                calls=[{'id':'pdf_'+str(page),'type':'function','function':{'name':'read_pdf','arguments':json.dumps({'path':'paper.pdf','startPage':page,'count':1,'includeImages':True})}} for page in (2,3)]
                yield {'type':'round','text':'','reasoning':'','calls':calls}
            else:
                yield {'type':'delta','text':'Read both pages.'};yield {'type':'round','text':'Read both pages.','reasoning':'','calls':[]}
        request=self.ai.prepare(self.workspace,{'requestId':'parallel-pdf-read','path':'paper.pdf','scope':'notebook','prompt':'Read following pages'})
        with patch.object(self.ai,'provider_round',provider_round):events=list(self.ai.stream(request))
        self.assertEqual(events[-1]['type'],'done',events)
        messages=captured[1]['messages'];index=next(i for i,m in enumerate(messages) if m.get('tool_calls'))
        self.assertEqual([m['role'] for m in messages[index+1:index+5]],['tool','tool','user','user'])
        self.assertEqual([m['tool_call_id'] for m in messages[index+1:index+3]],['pdf_2','pdf_3'])
