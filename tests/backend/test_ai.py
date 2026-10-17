"""AI integration uses a local fake provider; no credentials or user notebooks."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError
from unittest.mock import patch
from slide_notes.ai.service import AIService, endpoint, proposal
from slide_notes.application import Application, Environment
from slide_notes.web.server import handler_factory

class Provider(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append((self.path,payload,self.headers.get('Authorization')))
        mode=self.server.mode
        if mode=='error':
            self.send_response(401);self.end_headers();self.wfile.write(b'API key SECRET-TOKEN upstream body');return
        if mode=='redirect':
            self.send_response(307);self.send_header('Location','http://localhost:1/stolen');self.end_headers();return
        if mode=='agent':
            raw=json.dumps(self.server.responses.pop(0)).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw);return
        if mode=='json':
            raw=json.dumps({'choices':[{'message':{'content':'nonstream answer'},'finish_reason':'stop'}]}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw);return
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        try:
            texts=['你好','，这是回复']
            if mode=='proposal':
                context=json.loads(payload['messages'][1]['content'].split('\n',1)[1]);cell=context['slides'][0]['cells'][0]
                texts=[json.dumps({'summary':'让变量值更明确，保留其他 cell 不变。','changes':[{'cell':cell['id'],'source':'x = 2'}]},ensure_ascii=False)]
            for text in texts:
                chunk={'choices':[{'delta':{'content':text}}]}
                self.wfile.write(('data: '+json.dumps(chunk,ensure_ascii=False)+'\n\n').encode());self.wfile.flush()
                if mode=='slow':self.server.waiter.wait(2)
            if mode=='truncated': return
            self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError): pass

class AITests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();root=Path(self.temp.name)
        self.patch=patch.object(Environment,'start',Environment.snapshot);self.patch.start()
        self.app=Application(root/'config');self.info=self.app.open(str(root/'workspace'),create=True);self.workspace=self.app.get(self.info['id'])
        self.note=self.workspace.create('AI test');doc=self.note['document'];doc['slides'][0]['cells']=[{'id':'one','kind':'code','source':'x = 1','display':'normal'},{'id':'two','kind':'markdown','source':'PRIVATE OTHER CELL','display':'normal'}]
        self.workspace.notebook(self.note['path'])[1].save(doc,self.note['revision']);self.note=self.workspace.document(self.note['path'])
        self.provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);self.provider.daemon_threads=True;self.provider.calls=[];self.provider.mode='stream';self.provider.waiter=threading.Event();threading.Thread(target=self.provider.serve_forever,daemon=True).start()
        self.ai=AIService(self.app.config);self.ai.configure({'baseUrl':f'http://127.0.0.1:{self.provider.server_port}/v1','model':'mock-glm','apiKey':'SECRET-TOKEN'})
        self.server=ThreadingHTTPServer(('127.0.0.1',0),handler_factory(application=self.app));self.server.daemon_threads=True;threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
    def tearDown(self):
        self.provider.waiter.set();self.server.shutdown();self.server.server_close();self.provider.shutdown();self.provider.server_close();self.app.stop();self.patch.stop();self.temp.cleanup()
    def body(self,**extra):
        return {'requestId':'test-request-123','path':self.note['path'],'revision':self.note['revision'],'scope':'cell','cell':'one','prompt':'Explain',**extra}
    def request(self,path,body=None,headers=None):
        request=Request(self.base+path+'?workspace='+self.info['id'],data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json',**(headers or {})})
        return urlopen(request,timeout=5)
    def events(self,response):
        return [json.loads(line[5:]) for line in response.read().decode().splitlines() if line.startswith('data:')]
    def test_key_is_private_and_saved_outside_workspace(self):
        self.assertEqual(os.stat(self.ai.path).st_mode&0o777,0o600)
        with self.request('/api/ai/config') as response: data=json.load(response)
        self.assertTrue(data['hasKey']);self.assertNotIn('apiKey',data);self.assertNotIn('SECRET',json.dumps(data))
        self.assertFalse(self.ai.path.is_relative_to(self.workspace.root))
        self.ai.configure({'model':'other'});self.assertEqual(self.ai.config(True)['apiKey'],'SECRET-TOKEN')
        with self.assertRaises(ValueError): self.ai.configure({'baseUrl':'https://other.example/v1'})
        self.ai.configure({'apiKey':''});self.assertFalse(self.ai.config()['hasKey'])
    def test_scoped_context_never_includes_other_cell_or_notebook(self):
        other=self.workspace.create('Unrelated secret')
        context=self.ai.context(self.workspace,self.note['path'],'cell','one')
        self.assertNotIn('PRIVATE',json.dumps(context));self.assertEqual(context['context']['slides'][0]['cells'][0]['id'],'one')
        whole=self.ai.context(self.workspace,self.note['path'])
        self.assertIn('PRIVATE',json.dumps(whole));self.assertNotIn('Unrelated secret',json.dumps(whole))
        with self.assertRaises(ValueError):self.ai.context(self.workspace,self.note['path'],'cell','missing')
    def test_multiple_cells_context_and_stream_exclude_unselected_cells(self):
        doc=self.note['document']
        doc['slides'].append({'id':'secondpage','name':'Another page','cells':[{'id':'three','kind':'markdown','source':'THIRD SELECTED CELL','display':'normal'}]})
        self.workspace.notebook(self.note['path'])[1].save(doc,self.note['revision'])
        self.note=self.workspace.document(self.note['path'])
        context=self.ai.context(self.workspace,self.note['path'],'cells',cells=['one','three','one'])['context']
        self.assertEqual([cell['id'] for page in context['slides'] for cell in page['cells']],['one','three'])
        self.assertNotIn('PRIVATE',json.dumps(context))
        with urlopen(self.base+'/api/ai/context?'+urlencode({'workspace':self.info['id'],'path':self.note['path'],'scope':'cells','cells':json.dumps(['one','three'])})) as response:
            self.assertEqual(json.load(response)['context'],context)
        with self.request('/api/ai/chat',self.body(scope='cells',cells=['one','three'])) as response:
            self.assertEqual(self.events(response)[-1]['type'],'done')
        payload=json.dumps(self.provider.calls[-1][1])
        self.assertIn('THIRD SELECTED CELL',payload);self.assertNotIn('PRIVATE',payload)
        with self.assertRaises(ValueError):
            proposal(json.dumps({'summary':'Invalid','changes':[{'cell':'two','source':'outside selection'}]}),context)

    def test_invalid_multi_cell_selection_does_not_call_provider(self):
        for cells in [None,[],['one','missing'],'one',[123],['']]:
            with self.assertRaises(HTTPError) as error:
                self.request('/api/ai/chat',self.body(scope='cells',cells=cells))
            self.assertEqual(error.exception.code,400)
        self.assertEqual(self.provider.calls,[])

    def test_workspace_owned_history_api_needs_no_note_and_keeps_revision_conflicts(self):
        data={'active':'workspacechat','conversations':[{'id':'workspacechat','title':'Across files','createdAt':1,'updatedAt':2,'messages':[],'draft':'Workspace draft','contextPath':self.note['path'],'fileContexts':{}}]}
        with self.request('/api/ai/sessions',{'scope':'workspace','data':data,'revision':None}) as response:saved=json.load(response)
        self.assertEqual(saved['file'],'sessions/workspace.json')
        self.workspace.resolve(self.note['path']).unlink()
        with urlopen(self.base+'/api/ai/sessions?'+urlencode({'workspace':self.info['id'],'scope':'workspace'})) as response:loaded=json.load(response)
        self.assertEqual(loaded['revision'],saved['revision']);self.assertEqual(loaded['data']['conversations'][0]['draft'],'Workspace draft')
        with self.assertRaises(HTTPError) as error:self.request('/api/ai/sessions',{'scope':'workspace','data':data,'revision':None})
        self.assertEqual(error.exception.code,409)
        self.assertEqual(len(self.provider.calls),0)

    def test_workspace_history_api_round_trip_and_conflict(self):
        data={'active':'chat1','conversations':[{'id':'chat1','title':'Saved chat','customTitle':True,'createdAt':1000,'updatedAt':2000,'messages':[{'role':'user','content':'History only'}],'draft':'draft','selectedCells':['one']}]}
        body={'path':self.note['path'],'cell':None,'revision':None,'data':data}
        with self.request('/api/ai/sessions',body) as response: saved=json.load(response)
        with urlopen(self.base+'/api/ai/sessions?'+urlencode({'workspace':self.info['id'],'path':self.note['path']})) as response: loaded=json.load(response)
        self.assertEqual(loaded['revision'],saved['revision']);self.assertEqual(loaded['data']['conversations'],data['conversations'])
        self.assertTrue((self.workspace.root/saved['file']).is_file())
        self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])
        with self.assertRaises(HTTPError) as error: self.request('/api/ai/sessions',body)
        self.assertEqual(error.exception.code,409);self.assertEqual(self.provider.calls,[])

    def test_stale_revision_prevents_provider_request(self):
        with self.assertRaises(HTTPError) as error:self.request('/api/ai/chat',self.body(revision='stale'))
        self.assertEqual(error.exception.code,409);self.assertEqual(self.provider.calls,[])
    def test_streaming_and_compatible_payload(self):
        with self.request('/api/ai/chat',self.body()) as response:events=self.events(response)
        self.assertEqual(events[0]['type'],'meta');self.assertEqual(events[-1]['type'],'done');self.assertEqual(events[-1]['text'],'你好，这是回复')
        path,payload,auth=self.provider.calls[0];self.assertEqual(path,'/v1/chat/completions');self.assertEqual(auth,'Bearer SECRET-TOKEN');self.assertTrue(payload['stream'])
        self.assertNotIn('PRIVATE',json.dumps(payload));self.assertNotIn('SECRET',json.dumps(events))
    def test_test_connection_sends_no_notebook(self):
        with self.request('/api/ai/test',{'requestId':'connection-test'}) as response:events=self.events(response)
        self.assertEqual(events[-1]['type'],'done');payload=json.dumps(self.provider.calls[0][1]);self.assertNotIn('x = 1',payload);self.assertNotIn('PRIVATE',payload)
    def test_http_failure_is_redacted_and_redirect_not_followed(self):
        for mode in ('error','redirect'):
            self.provider.mode=mode
            with self.request('/api/ai/chat',self.body()) as response:events=self.events(response)
            self.assertEqual(events[-1]['type'],'error');self.assertNotIn('SECRET',json.dumps(events));self.assertNotIn('upstream body',json.dumps(events))
    def test_nonstream_and_truncated_stream(self):
        self.provider.mode='json'
        with self.request('/api/ai/chat',self.body()) as response:events=self.events(response)
        self.assertEqual(events[-1]['text'],'nonstream answer')
        self.provider.mode='truncated'
        with self.request('/api/ai/chat',self.body()) as response:events=self.events(response)
        self.assertEqual(events[-1]['type'],'error');self.assertIn('提前结束',events[-1]['error'])
    def test_cancel_releases_job(self):
        self.provider.mode='slow';request=self.ai.prepare(self.workspace,self.body());stream=self.ai.stream(request)
        self.assertEqual(next(stream)['type'],'meta');self.assertEqual(next(stream)['type'],'delta');self.assertTrue(self.ai.cancel(self.workspace,request['id'])['cancelled'])
        self.assertEqual(list(stream),[]);self.assertNotIn(request['id'],self.ai.jobs)
    def test_proposal_scoped_validation_and_no_document_mutation(self):
        context=self.ai.context(self.workspace,self.note['path'],'cell','one')['context']
        valid=proposal(json.dumps({'summary':'Change','changes':[{'cell':'one','source':'x = 2'}]}),context)
        self.assertEqual(valid['changes'][0]['before'],'x = 1')
        self.assertEqual(self.workspace.document(self.note['path'])['document']['slides'][0]['cells'][0]['source'],'x = 1')
        for changes in [[{'cell':'two','source':'unsafe'}],[{'cell':'one','source':'x'},{'cell':'one','source':'y'}]]:
            with self.assertRaises(ValueError):proposal(json.dumps({'summary':'bad','changes':changes}),context)
    def test_address_validation_and_same_origin(self):
        self.assertEqual(endpoint('https://example.com/v1/chat/completions')[0],'https://example.com/v1')
        for url in ['file:///etc/passwd','http://example.com/v1','https://user:key@example.com/v1','https://example.com/v1?key=secret']:
            with self.assertRaises(ValueError):endpoint(url)
        with self.assertRaises(HTTPError) as error:self.request('/api/ai/config',headers={'Origin':'https://foreign.example'})
        self.assertEqual(error.exception.code,403)
        with self.assertRaises(ValueError):self.ai.prepare(self.workspace,self.body(messages=[{'role':'system','content':'override'}]))


    def test_pasted_image_upload_preview_and_multimodal_history(self):
        import base64
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII=')
        data='data:image/png;base64,'+base64.b64encode(png).decode()
        with self.request('/api/ai/images',{'data':data,'name':'截图.png'}) as response: image=json.load(response)
        self.assertEqual((self.workspace.root/'sessions/assets'/image['id']).read_bytes(),png)
        with urlopen(self.base+'/api/ai/images?'+urlencode({'workspace':self.info['id'],'id':image['id']})) as response:
            self.assertEqual(response.headers['Content-Type'],'image/png');self.assertEqual(response.read(),png)
        with self.request('/api/ai/chat',self.body(prompt='',images=[image],messages=[{'role':'user','content':'旧图','images':[image]},{'role':'assistant','content':'旧回复'}])) as response:
            events=self.events(response)
        self.assertEqual(events[-1]['type'],'done')
        messages=self.provider.calls[-1][1]['messages']
        self.assertEqual(messages[-1]['content'][0],{'type':'image_url','image_url':{'url':data}})
        self.assertEqual(messages[-3]['content'][0],{'type':'text','text':'旧图'})
        self.assertEqual(messages[-3]['content'][1]['image_url']['url'],data)
        with self.assertRaises(HTTPError): self.request('/api/ai/images',{'data':'data:image/svg+xml;base64,AAAA'})
        with self.assertRaises(HTTPError): self.request('/api/ai/chat',self.body(images=[{'id':'../../config'}]))

    def test_pdf_selection_context_and_history(self):
        file=self.workspace.root/'sample.pdf';file.write_bytes(b'%PDF-1.4\n%%EOF')
        source={'path':'sample.pdf','page':3,'rects':[[10,20,120,40]],'fingerprint':'original','text':'selected field = 42'}
        with self.request('/api/ai/chat',self.body(path='sample.pdf',scope='notebook',cell=None,revision=None,prompt='',sources=[source],messages=[{'role':'user','content':'earlier','sources':[source]}])) as response:
            events=self.events(response)
        self.assertEqual(events[-1]['type'],'done')
        messages=self.provider.calls[-1][1]['messages'];context=messages[1]['content']
        self.assertIn('read_pdf',context);self.assertNotIn('PRIVATE OTHER CELL',context)
        self.assertIn('selected field = 42',messages[-1]['content']);self.assertIn('sample.pdf',messages[-1]['content']);self.assertIn('selected field = 42',messages[-2]['content'])
        import base64
        image_data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII='
        with self.request('/api/ai/images',{'data':image_data,'name':'PDF region'}) as response: image=json.load(response)
        with self.request('/api/ai/chat',self.body(prompt='',sources=[{**source,'text':'','image':image}])) as response: self.assertEqual(self.events(response)[-1]['type'],'done')
        content=self.provider.calls[-1][1]['messages'][-1]['content'];self.assertIn('sample.pdf',content[0]['text']);self.assertEqual(content[1]['image_url']['url'],image_data)
        for change in [{'path':'../outside.pdf'},{'page':0},{'rects':[[0,1]]},{'text':'x'*16001}]:
            with self.assertRaises(ValueError): self.ai.prepare(self.workspace,self.body(sources=[{**source,**change}]))
        with self.assertRaises(ValueError): self.ai.prepare(self.workspace,self.body(path='sample.pdf',scope='notebook',cell=None,mode='suggest'))

    def test_pdf_current_page_snapshot_reaches_provider_and_readonly_tool(self):
        from slide_notes.ai.tools import NoteAgent
        (self.workspace.root/'sample.pdf').write_bytes(b'%PDF-1.4\n%%EOF')
        data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII='
        with self.request('/api/ai/images',{'data':data,'name':'PDF page 2'}) as response:image=json.load(response)
        source={'path':'sample.pdf','page':2,'pageCount':7,'kind':'pdf-page','text':'CURRENT PAGE equation = 42','rects':[[0,0,612,792]],'fingerprint':'snapshot','image':image,'truncated':False}
        with self.request('/api/ai/chat',self.body(path='sample.pdf',cell=None,scope='notebook',revision=None,prompt='解释当前内容',sources=[source],messages=[{'role':'user','content':'earlier page','sources':[source]}])) as response:
            self.assertEqual(self.events(response)[-1]['type'],'done')
        messages=self.provider.calls[-1][1]['messages'];context=json.loads((messages[1]['content'][0]['text'] if isinstance(messages[1]['content'],list) else messages[1]['content']).split('\n',1)[1])
        self.assertEqual(context['pages'][0]['page'],2);self.assertIn('equation = 42',context['pages'][0]['text']);self.assertTrue(context['pages'][0]['hasImage'])
        self.assertEqual(messages[1]['content'][1]['image_url']['url'],data);self.assertIsInstance(messages[-1]['content'],str);self.assertNotIn('PRIVATE OTHER CELL',json.dumps(messages))
        from slide_notes.ai.claude import input_message
        cc=input_message(messages)['message']['content']
        self.assertIn('CURRENT PAGE',cc[0]['text']);self.assertEqual([part for part in cc if part['type']=='image'][-1]['source']['data'],data.split(',',1)[1])
        agent=NoteAgent(self.workspace,{'path':'sample.pdf','context':context});result,_=agent.execute('inspect_note',{})
        self.assertTrue(result['readOnly']);self.assertEqual(result['pages'][0]['text'],source['text']);self.assertFalse(agent.writable)
        for change in [{'pageCount':1},{'pageCount':True},{'rects':[[2,2,1,1]]}]:
            with self.assertRaises(ValueError):self.ai.prepare(self.workspace,self.body(sources=[{**source,**change}]))

    def test_agent_tool_loop_guard_and_private_reasoning(self):
        self.provider.mode='agent'
        def call(identity,name,args):
            return {'choices':[{'message':{'content':None,'reasoning_content':'PRIVATE MODEL REASONING','tool_calls':[{'id':identity,'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]},'finish_reason':'tool_calls'}]}
        self.provider.responses=[call('read','inspect_note',{}),call('write','apply_note_operations',{'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','source':'x = 2','showCode':True,'display':'fragment'}]}),{'choices':[{'message':{'content':'Saved'},'finish_reason':'stop'}]}]
        events=[]
        with self.request('/api/ai/chat',self.body(prompt='Change x to 2 and show code')) as response:
            for line in response:
                if not line.startswith(b'data:'):continue
                event=json.loads(line[5:]);events.append(event)
                if event['type']=='guard':
                    with self.request('/api/ai/guard',{**event,'allowed':True}) as ack:self.assertTrue(json.load(ack)['ok'])
        self.assertEqual(events[-1]['type'],'done',events)
        mutation=next(event for event in events if event['type']=='mutation')
        saved=self.workspace.document(self.note['path'])
        self.assertEqual(saved['revision'],mutation['revision']);self.assertEqual(saved['document']['slides'][0]['cells'][0]['source'],'x = 2')
        self.assertEqual(saved['document']['slides'][0]['cells'][1]['source'],'PRIVATE OTHER CELL')
        self.assertNotIn('PRIVATE MODEL REASONING',json.dumps(events))
        payload=self.provider.calls[-1][1];self.assertTrue(any(m.get('reasoning_content')=='PRIVATE MODEL REASONING' for m in payload['messages']))
        self.assertNotIn('PRIVATE OTHER CELL',json.dumps(payload))
        self.assertTrue(json.loads(payload['messages'][-1]['content'])['saved'])

    def test_agent_boundaries_atomic_revision_and_preferences(self):
        from slide_notes.ai.tools import NoteAgent
        agent=NoteAgent(self.workspace,self.ai.context(self.workspace,self.note['path'],'cell','one'))
        capabilities,_=agent.execute('agent_capabilities',{})
        self.assertEqual(capabilities['operations'],['cell.update']);self.assertIn('language',capabilities['unavailablePreferences'])
        attacks=[{'op':'cell.update','id':'two','source':'overwrite'}, {'op':'cell.delete','id':'one'}, {'op':'cell.update','id':'one','sourceFile':'/etc/passwd'}, {'op':'notebook.replace'}, {'op':'cell.add','source':'evil'}]
        for attack in attacks:
            with self.assertRaises(ValueError):agent.execute('apply_note_operations',{'revision':self.note['revision'],'operations':[attack]})
        for name in ['shell','read_file','write_file','change_config']:
            with self.assertRaises(ValueError):agent.execute(name,{})
        self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])
        agent.execute('apply_note_operations',{'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','showCode':True}]})
        with self.assertRaises(ValueError):agent.execute('apply_note_operations',{'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','source':'stale'}]})
        global_agent=NoteAgent(self.workspace,self.ai.context(self.workspace,self.note['path']))
        current,_=global_agent.execute('inspect_note',{})
        global_agent.execute('apply_note_operations',{'revision':current['revision'],'operations':[{'op':'notebook.rename','title':'Renamed by agent'}]})
        self.assertEqual(self.workspace.document(self.note['path'])['document']['title'],'Renamed by agent')

    def test_agent_guard_denial_does_not_write(self):
        self.provider.mode='agent'
        self.provider.responses=[{'choices':[{'message':{'tool_calls':[{'id':'write','type':'function','function':{'name':'apply_note_operations','arguments':json.dumps({'revision':self.note['revision'],'operations':[{'op':'cell.update','id':'one','source':'not saved'}]})}}]},'finish_reason':'tool_calls'}]},{'choices':[{'message':{'content':'Could not save'},'finish_reason':'stop'}]}]
        events=[]
        with self.request('/api/ai/chat',self.body()) as response:
            for line in response:
                if not line.startswith(b'data:'):continue
                event=json.loads(line[5:]);events.append(event)
                if event['type']=='guard':
                    with self.request('/api/ai/guard',{**event,'allowed':False}) as ack:ack.read()
        self.assertFalse(any(event['type']=='mutation' for event in events));self.assertEqual(self.workspace.document(self.note['path'])['revision'],self.note['revision'])

    def test_cell_selection_context_and_scope_validation(self):
        selected={'path':self.note['path'],'cell':'one','text':'x','from':0,'to':1,'startLine':1,'endLine':1,'kind':'source'}
        with self.request('/api/ai/chat',self.body(prompt='',cellSelections=[selected])) as response:self.assertEqual(self.events(response)[-1]['type'],'done')
        self.assertIn('"cell": "one"',self.provider.calls[-1][1]['messages'][-1]['content'])
        for change in [{'cell':'two'},{'path':'other.json'},{'from':-1},{'to':0}]:
            with self.assertRaises(ValueError):self.ai.prepare(self.workspace,self.body(cellSelections=[{**selected,**change}]))

    def test_notebook_region_image_and_anchor_context(self):
        image_data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII='
        with self.request('/api/ai/images',{'data':image_data,'name':'Selected note region'}) as response:image=json.load(response)
        source={'kind':'notebook-region','path':self.note['path'],'page':1,'slide':self.note['document']['slides'][0]['id'],'cell':'one','rects':[[.1,.2,.8,.9]],'text':'','fingerprint':'a123','image':image}
        with self.request('/api/ai/chat',self.body(prompt='',sources=[source])) as response:self.assertEqual(self.events(response)[-1]['type'],'done')
        content=self.provider.calls[-1][1]['messages'][-1]['content'];self.assertIn('notebook-region',content[0]['text']);self.assertEqual(content[1]['image_url']['url'],image_data)
        for change in [{'rects':[[0,0,2,1]]},{'rects':[[.5,0,.1,1]]},{'rects':[[0,0,1,1],[0,0,1,1]]},{'image':None},{'path':'../software.json'},{'slide':'bad/id'},{'cell':'../outside'}]:
            with self.assertRaises(ValueError):self.ai.prepare(self.workspace,self.body(sources=[{**source,**change}]))

    def test_image_scope_and_crop_attachment_are_read_only(self):
        import base64,hashlib
        image_data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1sAAAAASUVORK5CYII='
        raw=base64.b64decode(image_data.split(',')[1]);(self.workspace.root/'sample.png').write_bytes(raw)
        context=self.ai.context(self.workspace,'sample.png')['context'];self.assertEqual(context['scope'],'image');self.assertEqual(context['slides'],[])
        from slide_notes.ai.tools import NoteAgent
        agent=NoteAgent(self.workspace,self.ai.context(self.workspace,'sample.png'));self.assertFalse(agent.writable);self.assertIn('read_image',[t['function']['name'] for t in agent.tools()]);self.assertIn('create_note',[t['function']['name'] for t in agent.tools()])
        with self.request('/api/ai/images',{'data':image_data,'name':'Crop'}) as response:image=json.load(response)
        source={'kind':'image-region','path':'sample.png','page':1,'width':100,'height':80,'rects':[[10,15,70,60]],'fingerprint':hashlib.sha256(raw).hexdigest(),'image':image,'text':''}
        with self.request('/api/ai/chat',self.body(path='sample.png',scope='notebook',cell=None,revision=None,prompt='',sources=[source])) as response:self.assertEqual(self.events(response)[-1]['type'],'done')
        content=self.provider.calls[-1][1]['messages'][-1]['content'];self.assertIn('image-region',content[0]['text']);self.assertEqual(content[1]['image_url']['url'],image_data)
        for change in [{'width':0},{'width':True},{'height':100001},{'rects':[[0,0,101,80]]},{'rects':[[0,80,20,10]]},{'fingerprint':'invalid'},{'image':None},{'path':'../outside.png'}]:
            with self.assertRaises(ValueError):self.ai.prepare(self.workspace,self.body(sources=[{**source,**change}]))
        with self.assertRaises(ValueError):self.ai.prepare(self.workspace,self.body(path='sample.png',scope='notebook',cell=None,revision=None,mode='suggest'))
        data={'active':'chat','conversations':[{'id':'chat','title':'Image crop','createdAt':1000,'updatedAt':1000,'sources':[source],'messages':[],'draft':'','selectedCells':[]}]}
        with self.request('/api/ai/sessions',{'path':'sample.png','cell':None,'revision':None,'data':data}) as response:saved=json.load(response)
        self.assertEqual(json.loads((self.workspace.root/saved['file']).read_text())['conversations'][0]['sources'][0]['rects'],source['rects'])

if __name__=='__main__': unittest.main()
