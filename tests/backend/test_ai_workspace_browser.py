"""Real UI -> fake provider -> workspace/PDF tools -> guarded editor sync."""
import json
from pathlib import Path
import tempfile
import threading
import shlex
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from unittest.mock import patch
from slide_notes.application import Application,Environment
from slide_notes.ai.service import AIService
from slide_notes.web.server import handler_factory
from test_pdf_ai_context import sample_pdf


class WorkspaceBrowserTests(unittest.TestCase):
    def test_no_active_file_pdf_read_cross_note_write_and_move(self):
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory() as directory,patch.object(Environment,'start',Environment.snapshot):
            app=Application(Path(directory)/'config');info=app.open(str(Path(directory)/'workspace'),create=True);workspace=app.get(info['id']);other=workspace.create('Other')
            pdf=sample_pdf();(workspace.root/'paper.pdf').write_bytes(pdf)
            class Provider(BaseHTTPRequestHandler):
                def log_message(self,*args):pass
                def do_POST(self):
                    payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])));self.server.calls.append(payload);step=len(self.server.calls)-1
                    plans={0:('read_pdf',{'path':'paper.pdf','startPage':2,'count':2,'includeImages':True}),1:('create_note',{'title':'PDF Summary','markdown':'SECOND PAGE equation 42'}),2:('inspect_note',{'path':other['path']}),3:('apply_note_operations',{'path':other['path'],'revision':other['revision'],'operations':[{'op':'cell.add','slide':other['document']['slides'][0]['id'],'kind':'markdown','source':'Cross notebook update'}]}),5:('manage_files',{'operation':'impact','path':'notebooks/PDF Summary.json'}),6:('manage_files',{'operation':'move','path':'notebooks/PDF Summary.json','destination':'notebooks/Renamed Summary.json','revision':workspace.impact('notebooks/PDF Summary.json')['revision']}) if step==6 else ('inspect_note',{})}
                    if step==8:plans[8]=('run_command',{'command':'python -c '+shlex.quote('import numpy; print(numpy.arange(4).sum()); open("/scratch/result.csv","w").write("value\\n6\\n")'),'timeout':10})
                    if step==9:
                        execution=json.loads(next(m['content'] for m in reversed(payload['messages']) if m['role']=='tool'))
                        plans[9]=('save_generated_file',{'runId':execution['runId'],'artifactId':execution['artifacts'][0]['id'],'destination':'notebooks/assets/result.csv'})
                    if step in plans:
                        name,args=plans[step];message={'content':None,'tool_calls':[{'id':'tool_'+str(step),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]};reason='tool_calls'
                    else:message={'content':'已完成工作区操作。'};reason='stop'
                    raw=json.dumps({'choices':[{'message':message,'finish_reason':reason}]}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(raw)
            provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);provider.calls=[];threading.Thread(target=provider.serve_forever,daemon=True).start()
            AIService(app.config).configure({'baseUrl':f'http://127.0.0.1:{provider.server_port}/v1','model':'fake'})
            Base=handler_factory(application=app)
            class Handler(Base):
                def log_message(self,*args):pass
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox']);page=browser.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                    page.goto(f'http://127.0.0.1:{server.server_port}/?workspace='+info['id'],wait_until='domcontentloaded');page.wait_for_function("typeof workbenchReady!=='undefined'&&workbenchReady",timeout=30000)
                    page.evaluate("async()=>{for(const tab of [...editorTabs.items])await closeEditor(tab.path);state.panel='ai';renderInspector();const scope=loadAIScope('');if(!scope.ready)await hydrateAIScope(scope);}")
                    self.assertIsNone(page.evaluate('state.path'))
                    send="async()=>{const chat=currentAISession();await sendAI(chat,'自主读后面的 PDF 并整理成笔记','chat');return chat.messages.at(-1);}"
                    reply=page.evaluate(send);self.assertEqual(reply['status'],'complete',reply)
                    self.assertTrue((workspace.root/'notebooks/PDF Summary.json').is_file());self.assertEqual(workspace.document(other['path'])['document']['slides'][0]['cells'][0]['source'],'Cross notebook update')
                    second=provider.calls[1]['messages'];self.assertTrue(any(isinstance(m['content'],list) and any(part.get('type')=='image_url' for part in m['content']) for m in second));self.assertIn('SECOND PAGE',json.dumps(second))
                    self.assertEqual(page.evaluate('currentAISession().path'),'');self.assertEqual(len(provider.calls),5)
                    self.assertTrue(page.locator('.ai-tool-trace').count());trace=page.evaluate('currentAISession().messages.at(-1).toolTrace');self.assertEqual(trace[0]['pages'],[2,3]);self.assertEqual(trace[0]['tool'],'read_pdf')
                    reply=page.evaluate(send);self.assertEqual(reply['status'],'complete',reply);self.assertFalse((workspace.root/'notebooks/PDF Summary.json').exists());self.assertTrue((workspace.root/'notebooks/Renamed Summary.json').is_file())
                    reply=page.evaluate(send);self.assertEqual(reply['status'],'complete',reply);self.assertEqual((workspace.root/'notebooks/assets/result.csv').read_text(),'value\n6\n')
                    page.locator('.ai-tool-trace').last.locator('summary').click();self.assertIn('执行命令',page.locator('.ai-tool-trace').last.inner_text());self.assertEqual(len(provider.calls),11)
                    self.assertFalse(page.evaluate("!!aiWriteLock"));self.assertEqual((workspace.root/'paper.pdf').read_bytes(),pdf);self.assertEqual(errors,[])
                    await_save=page.evaluate("async()=>{await flushAIScope(loadAIScope(''));return loadAIScope('').saveError;}");self.assertIsNone(await_save)
                    browser.close()
            finally:
                server.shutdown();server.server_close();provider.shutdown();provider.server_close();app.stop()
