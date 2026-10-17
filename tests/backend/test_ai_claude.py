"""Local CC integration against a fake executable; never uses account credentials."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from slide_notes.ai.service import AIService
from slide_notes.ai import claude as ai_claude
from slide_notes.application import Application, Environment


class ClaudeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.environment=patch.object(Environment,'start',Environment.snapshot);self.environment.start()
        self.app=Application(self.root/'config');info=self.app.open(str(self.root/'workspace'),create=True)
        self.workspace=self.app.get(info['id']);self.note=self.workspace.create('Local CC')
        doc=self.note['document'];doc['slides'][0]['cells']=[{'id':'one','kind':'code','source':'x = 1','display':'normal'},
            {'id':'two','kind':'markdown','source':'UNSELECTED PRIVATE CELL','display':'normal'}]
        self.workspace.notebook(self.note['path'])[1].save(doc,self.note['revision']);self.note=self.workspace.document(self.note['path'])
        self.script=self.root/'claude';self.plan=self.root/'plan.json';self.log=self.root/'calls.jsonl'
        self.script.write_text('#!'+sys.executable+'\n'+'''import json,sys,os,time
from pathlib import Path
root=Path(__file__).parent
plan=json.loads((root/'plan.json').read_text())
log=root/'calls.jsonl'
index=len(log.read_text().splitlines()) if log.exists() else 0
record={'argv':sys.argv[1:],'cwd':os.getcwd(),'input':json.loads(sys.stdin.readline())}
with log.open('a') as f:f.write(json.dumps(record)+'\\n')
item=plan[min(index,len(plan)-1)]
if item.get('sleep'):time.sleep(item['sleep'])
if item.get('stderr'):print(item['stderr'],file=sys.stderr)
if item.get('raw') is not None:print(item['raw'])
else:
 print(json.dumps({'type':'system','subtype':'init','private':'MUST NOT APPEAR'}))
 print(json.dumps({'type':'assistant','message':{'content':[{'type':'thinking','thinking':'PRIVATE REASONING'}]}}))
 print(json.dumps({'type':'result','subtype':item.get('subtype','success'),'is_error':item.get('error',False),'structured_output':item.get('output',{'text':'本地回复','calls':[]})}))
sys.exit(item.get('exit',0))
''');self.script.chmod(0o755)
        self.plan.write_text(json.dumps([{}]));self.ai=AIService(self.app.config)
        self.ai.configure({'provider':'claude-code','claudePath':str(self.script)})

    def tearDown(self):
        self.app.stop();self.environment.stop();self.temp.cleanup()

    def request(self,**extra):
        return self.ai.prepare(self.workspace,{'requestId':'local-cc-request','path':self.note['path'],
            'revision':self.note['revision'],'scope':'cell','cell':'one','prompt':'Explain',**extra})

    def responses(self,*items):self.plan.write_text(json.dumps(items))
    def calls(self):return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_selection_preview_and_on_demand_read_use_local_cc_protocol(self):
        from slide_notes.ai.selections import register
        current=self.workspace.document(self.note['path']);doc=current['document'];doc['slides'][0]['cells'][0]['source']='CC selected '+('source '*150)+'CC_SELECTION_TAIL'
        self.workspace.notebook(self.note['path'])[1].save(doc,current['revision']);self.note=self.workspace.document(self.note['path'])
        ref=register(self.workspace,{'selections':[{'kind':'note-cells','path':self.note['path'],'cells':['one']}]})['sources'][0]
        self.responses({'output':{'text':'','calls':[{'name':'read_selection','arguments':json.dumps({'id':ref['id'],'after':1})}]}},{'output':{'text':'已读取完整选区。','calls':[]}})
        events=list(self.ai.stream(self.request(selectionContext='references',sources=[ref])))
        self.assertEqual(events[-1]['type'],'done',events);calls=self.calls();self.assertEqual(len(calls),2)
        first=json.dumps(calls[0]['input']);second=json.dumps(calls[1]['input'])
        self.assertNotIn('CC_SELECTION_TAIL',first);self.assertNotIn('UNSELECTED PRIVATE CELL',first)
        self.assertIn('CC_SELECTION_TAIL',second);self.assertIn('UNSELECTED PRIVATE CELL',second)
        self.assertTrue(any(event.get('summary',{}).get('selectionId')==ref['id'] for event in events))

    def test_workspace_pdf_tools_read_unseen_pages_and_create_note_with_real_pixels(self):
        from test_pdf_ai_context import sample_pdf
        from slide_notes.ai.pdf_reader import available
        if not available():self.skipTest('Poppler unavailable')
        original=sample_pdf();(self.workspace.root/'paper.pdf').write_bytes(original)
        self.responses(
            {'output':{'text':'','calls':[{'name':'read_pdf','arguments':json.dumps({'path':'paper.pdf','startPage':2,'count':2,'includeImages':True})}]}},
            {'output':{'text':'','calls':[{'name':'create_note','arguments':json.dumps({'title':'PDF Reading','markdown':'SECOND PAGE equation 42'})}]}},
            {'output':{'text':'已读取后续页面并创建笔记。','calls':[]}})
        request=self.request(path='paper.pdf',revision=None,scope='notebook',cell=None,prompt='自己往下读并整理成笔记')
        events=[]
        for event in self.ai.stream(request):
            events.append(event)
            if event['type']=='guard':self.ai.guard(self.workspace,{'requestId':request['id'],'token':event['token'],'revision':event['revision'],'allowed':True})
        self.assertEqual(events[-1]['type'],'done',events);self.assertTrue(any(e['type']=='workspace-mutation' for e in events))
        second=self.calls()[1]['input']['message']['content'];self.assertIn('SECOND PAGE',second[0]['text']);self.assertEqual(sum(part['type']=='image' for part in second),2)
        self.assertEqual((self.workspace.root/'paper.pdf').read_bytes(),original)
        created=self.workspace.document('notebooks/PDF Reading.json');self.assertEqual(created['document']['slides'][0]['cells'][0]['source'],'SECOND PAGE equation 42')

    def test_local_config_preserves_api_settings_and_rejects_invalid_path(self):
        self.ai.configure({'provider':'api','model':'glm-test','apiKey':'SECRET-REMOTE'})
        self.ai.configure({'provider':'claude-code','claudeModel':''})
        config=self.ai.config();self.assertTrue(config['claudeAvailable']);self.assertEqual(config['provider'],'claude-code')
        self.assertNotIn('SECRET',json.dumps(config));self.assertEqual(self.ai.config(True)['apiKey'],'SECRET-REMOTE')
        with self.assertRaises(ValueError):self.ai.configure({'claudePath':'relative-path'})
        self.assertEqual(self.ai.config(True)['claudePath'],str(self.script))
        with self.assertRaises(ValueError):self.ai.configure({'provider':'shell'})

    def test_cli_scope_flags_no_secret_and_success(self):
        self.ai.configure({'model':'old-api-model','apiKey':'SECRET-REMOTE','claudeModel':'sonnet'})
        request=self.request();events=list(self.ai.stream(request))
        self.assertEqual(events[-1]['type'],'done');self.assertEqual(events[-1]['text'],'本地回复')
        call=self.calls()[0];flags=call['argv'];serialized=json.dumps(call,ensure_ascii=False)
        for flag in ('--safe-mode','--strict-mcp-config','--no-session-persistence','--disable-slash-commands'):self.assertIn(flag,flags)
        self.assertEqual(flags[flags.index('--tools')+1],'');self.assertEqual(flags[flags.index('--model')+1],'sonnet')
        self.assertNotIn('--dangerously-skip-permissions',flags);self.assertNotEqual(call['cwd'],str(self.workspace.root))
        self.assertNotIn('UNSELECTED PRIVATE CELL',serialized);self.assertNotIn('SECRET-REMOTE',serialized)
        self.assertIn('x = 1',serialized);self.assertNotIn('PRIVATE REASONING',json.dumps(events));self.assertFalse(self.ai.jobs)

    def test_connection_test_never_sends_note_or_uses_note_tools(self):
        request=self.ai.prepare(self.workspace,{'requestId':'test-local-123'},True)
        events=list(self.ai.stream(request));self.assertEqual(events[-1]['type'],'done')
        record=self.calls()[0];self.assertNotIn('x = 1',json.dumps(record));self.assertNotIn('UNSELECTED',json.dumps(record))
        schema=json.loads(record['argv'][record['argv'].index('--json-schema')+1]);self.assertEqual(schema['properties']['calls']['maxItems'],0)

    def test_existing_guard_revision_and_scoped_note_tools(self):
        revision=self.note['revision']
        self.responses({'output':{'text':'','calls':[{'name':'inspect_note','arguments':'{}'}]}},
            {'output':{'text':'','calls':[{'name':'apply_note_operations','arguments':json.dumps({'revision':revision,'operations':[{'op':'cell.update','id':'one','source':'x = 7'}]})}]}},
            {'output':{'text':'已保存，未运行。','calls':[]}})
        request=self.request();events=[]
        for event in self.ai.stream(request):
            events.append(event)
            if event['type']=='guard':self.ai.guard(self.workspace,{'requestId':request['id'],'token':event['token'],'revision':event['revision'],'allowed':True})
        self.assertEqual(events[-1]['type'],'done');self.assertTrue(any(e['type']=='mutation' for e in events))
        cells=self.workspace.document(self.note['path'])['document']['slides'][0]['cells']
        self.assertEqual(cells[0]['source'],'x = 7');self.assertEqual(cells[1]['source'],'UNSELECTED PRIVATE CELL')
        self.assertIsNone(self.workspace.notebook(self.note['path'])[2].snapshot()['state'])
        self.assertEqual(len(self.calls()),3);self.assertIn('role',json.dumps(self.calls()[-1]['input']))

    def test_out_of_scope_action_and_guard_denial_do_not_write(self):
        self.responses({'output':{'text':'','calls':[{'name':'Bash','arguments':'{}'}]}})
        events=list(self.ai.stream(self.request()));self.assertEqual(events[-1]['type'],'error')
        self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])
        self.log.unlink();self.responses({'output':{'text':'','calls':[{'name':'apply_note_operations','arguments':json.dumps({'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','source':'changed'}]})}]}}, {'output':{'text':'没有保存。','calls':[]}})
        request=self.request();events=[]
        for event in self.ai.stream(request):
            events.append(event)
            if event['type']=='guard':self.ai.guard(self.workspace,{'requestId':request['id'],'token':event['token'],'revision':event['revision'],'allowed':False})
        self.assertFalse(any(e['type']=='mutation' for e in events));self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])

    def test_suggestion_still_requires_review(self):
        text=json.dumps({'summary':'调整常数','changes':[{'cell':'one','source':'x = 3'}]})
        self.responses({'output':{'text':text,'calls':[]}})
        events=list(self.ai.stream(self.request(mode='suggest')))
        self.assertEqual(events[-1]['proposal']['changes'][0]['after'],'x = 3')
        self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])

    def test_cancel_terminates_cli_and_cleans_job(self):
        self.responses({'sleep':20});request=self.request();events=[]
        worker=threading.Thread(target=lambda:events.extend(self.ai.stream(request)));worker.start()
        deadline=time.monotonic()+3
        while not self.log.exists() and time.monotonic()<deadline:time.sleep(.01)
        self.assertTrue(self.log.exists());start=time.monotonic();self.ai.cancel(self.workspace,request['id']);worker.join(3)
        self.assertFalse(worker.is_alive());self.assertLess(time.monotonic()-start,3);self.assertFalse(self.ai.jobs)
        self.assertFalse(any(e['type']=='done' for e in events));self.assertIsNone(request['job']['stop'])

    def test_errors_timeout_and_output_limits_hide_raw_cli_data(self):
        for item in ({'exit':1,'stderr':'SECRET-CREDENTIAL','raw':'SECRET-CREDENTIAL'},
                     {'raw':'not json SECRET-CREDENTIAL'}, {'error':True}, {'output':{'text':4,'calls':[]}}):
            self.responses(item);events=list(self.ai.stream(self.request()))
            self.assertEqual(events[-1]['type'],'error');self.assertNotIn('SECRET-CREDENTIAL',json.dumps(events))
        self.responses({'sleep':20})
        with patch.object(ai_claude,'CLAUDE_TIMEOUT',.1):
            events=list(self.ai.stream(self.request()));self.assertIn('超时',events[-1]['error'])
        self.responses({'raw':'x'*2000})
        with patch.object(ai_claude,'MAX_RESPONSE_BYTES',1000):
            events=list(self.ai.stream(self.request()));self.assertIn('过大',events[-1]['error'])

    def test_image_translation_keeps_numbered_history_attachments(self):
        image={'type':'image_url','image_url':{'url':'data:image/png;base64,YQ=='}}
        messages=[{'role':'system','content':'system'},{'role':'user','content':[{'type':'text','text':'history'},image]},
                  {'role':'user','content':[{'type':'text','text':'current'},image]}]
        result=ai_claude.input_message(messages);content=result['message']['content']
        self.assertIn('图片 1',content[0]['text']);self.assertIn('图片 2',content[0]['text'])
        self.assertEqual([p['text'] for p in content[1:] if p['type']=='text'],['图片 1：','图片 2：'])
        self.assertEqual(len([p for p in content if p['type']=='image']),2);self.assertEqual(messages[1]['content'][1]['type'],'image_url')
        messages[1]['content'][1]={'type':'image_url','image_url':{'url':'https://example.com/private.png'}}
        with self.assertRaises(ValueError):ai_claude.input_message(messages)

    def test_conversation_model_and_effort_override_do_not_change_defaults(self):
        self.ai.configure({'claudeModel':'sonnet'})
        request=self.request(model='opus',claudeEffort='high')
        events=list(self.ai.stream(request));self.assertEqual(events[-1]['type'],'done')
        flags=self.calls()[0]['argv'];self.assertEqual(flags[flags.index('--model')+1],'opus');self.assertEqual(flags[flags.index('--effort')+1],'high')
        self.assertEqual(self.ai.config()['claudeModel'],'sonnet')
        with self.assertRaises(ValueError):self.request(model='bad\nmodel')
        with self.assertRaises(ValueError):self.request(claudeEffort='unlimited')
        with self.assertRaises(ValueError):self.request(permission='bypass')

    def test_software_read_only_still_allows_scoped_note_writes(self):
        request=self.request(permission='read-only',prompt='把当前 cell 改为 x = 9')
        self.assertTrue(request['agent'].writable)
        names=[tool['function']['name'] for tool in request['payload']['tools']]
        self.assertIn('apply_note_operations',names)
        self.assertFalse(any(name in names for name in ('Bash','Edit','Write','write_file','execute_python')))
        with self.assertRaises(ValueError):request['agent'].execute('write_file',{'path':'software.py','source':'changed'})
        with self.assertRaises(ValueError):request['agent'].execute('apply_note_operations',{'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'two','source':'out of scope'}]})
        with self.assertRaises(ValueError):request['agent'].execute('apply_note_operations',{'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','sourceFile':'software.py'}]})
        arguments={'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','source':'x = 9'}]}
        self.responses({'output':{'text':'','calls':[{'name':'apply_note_operations','arguments':json.dumps(arguments)}]}}, {'output':{'text':'已更新笔记。','calls':[]}})
        events=[]
        for event in self.ai.stream(request):
            events.append(event)
            if event['type']=='guard':self.ai.guard(self.workspace,{'requestId':request['id'],'token':event['token'],'revision':event['revision'],'allowed':True})
        self.assertEqual(events[-1]['type'],'done');self.assertTrue(any(event['type']=='mutation' for event in events))
        cells=self.workspace.document(self.note['path'])['document']['slides'][0]['cells']
        self.assertEqual(cells[0]['source'],'x = 9');self.assertEqual(cells[1]['source'],'UNSELECTED PRIVATE CELL')
        self.assertIsNone(self.workspace.notebook(self.note['path'])[2].snapshot()['state'])
