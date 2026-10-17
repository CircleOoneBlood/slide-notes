"""Real PDF.js -> workspace -> fake AI provider integration; temporary files only."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from slide_notes.application import Application, Environment
from slide_notes.ai.service import AIService
from slide_notes.web.server import handler_factory
from test_ai import Provider


def sample_pdf():
    streams=[b'BT /F1 20 Tf 40 740 Td (FIRST PAGE ONLY) Tj ET',
             b'BT /F1 20 Tf 40 740 Td (SECOND PAGE equation 42) Tj ET',
             b'0.2 0.6 0.2 rg 40 500 400 150 re f']
    objects={1:b'<< /Type /Catalog /Pages 2 0 R >>',2:b'<< /Type /Pages /Count 3 /Kids [4 0 R 6 0 R 8 0 R] >>',3:b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'}
    for index,stream in enumerate(streams):
        key=4+2*index
        objects[key]=f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {key+1} 0 R >>'.encode()
        objects[key+1]=b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream'
    data=bytearray(b'%PDF-1.4\n');offsets=[0]
    for key,value in sorted(objects.items()):
        offsets.append(len(data));data.extend(f'{key} 0 obj\n'.encode()+value+b'\nendobj\n')
    xref=len(data);data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:data.extend(f'{offset:010} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode());return bytes(data)


class PDFContextTests(unittest.TestCase):
    def test_current_page_image_only_page_and_manual_selection(self):
        from playwright.sync_api import sync_playwright
        with tempfile.TemporaryDirectory() as directory,patch.object(Environment,'start',Environment.snapshot):
            app=Application(Path(directory)/'config');info=app.open(str(Path(directory)/'workspace'),create=True);workspace=app.get(info['id']);workspace.create('Temporary note')
            (workspace.root/'sample.pdf').write_bytes(sample_pdf());app.remember(info['id'],None,{'tabs':[{'kind':'pdf','path':'sample.pdf'}],'active':'sample.pdf'})
            provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);provider.calls=[];provider.mode='stream';provider.waiter=threading.Event();threading.Thread(target=provider.serve_forever,daemon=True).start()
            AIService(app.config).configure({'baseUrl':f'http://127.0.0.1:{provider.server_port}/v1','model':'fake','apiKey':'test-only'})
            Base=handler_factory(application=app)
            class Handler(Base):
                def log_message(self,*args):pass
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1300,'height':1000});errors=[];uploads=[];page.on('request',lambda request:uploads.append(request.url) if '/api/ai/images?' in request.url or '/api/ai/pdf-context?' in request.url else None);page.on('pageerror',lambda error:errors.append(str(error)))
                    page.goto(f'http://127.0.0.1:{server.server_port}/?workspace='+info['id'],wait_until='domcontentloaded')
                    page.wait_for_function("typeof workbenchReady!=='undefined'&&workbenchReady&&document.querySelector('#pdf-editors iframe')?.dataset.aiReady",timeout=30000)
                    frame=page.frame_locator('#pdf-editors iframe');frame.locator('#page-number').fill('2');frame.locator('#page-number').dispatch_event('change')
                    page.evaluate("async()=>{state.panel='ai';renderInspector();const scope=loadAIScope('sample.pdf');if(!scope.ready)await hydrateAIScope(scope);}")
                    async_send="async()=>{const chat=currentAISession();await sendAI(chat,'解释当前内容','chat');return chat.messages.at(-1);}"
                    reply=page.evaluate(async_send);self.assertEqual(reply['status'],'complete',reply)
                    messages=provider.calls[-1][1]['messages'];context=json.loads(messages[1]['content'][0]['text'].split('\n',1)[1]);self.assertEqual(context['pages'][0]['page'],2);self.assertIn('SECOND PAGE',context['pages'][0]['text']);self.assertNotIn('FIRST PAGE',context['pages'][0]['text']);self.assertIsInstance(messages[-1]['content'],str);self.assertEqual(len(messages[1]['content']),2)
                    self.assertEqual(page.evaluate("currentAISession().messages.at(-2).pdfContext.page"),2)
                    self.assertEqual(page.evaluate("currentAISession().messages.at(-2).sources.length"),0)
                    self.assertEqual(page.locator('.ai-message-sources').count(),0)
                    first_uploads=len(uploads);self.assertEqual(first_uploads,2)
                    reply=page.evaluate(async_send);self.assertEqual(reply['status'],'complete',reply);self.assertEqual(len(uploads),first_uploads)
                    repeated=provider.calls[-1][1]['messages'];self.assertEqual(repeated[1]['content'][0]['text'].count('SECOND PAGE'),1)
                    self.assertTrue(all(isinstance(m['content'],str) for m in repeated[2:]))
                    self.assertIn('第 2 页',page.locator('.ai-context-chip').inner_text())
                    frame.locator('#page-number').fill('3');frame.locator('#page-number').dispatch_event('change');reply=page.evaluate(async_send);self.assertEqual(reply['status'],'complete',reply)
                    context=json.loads(provider.calls[-1][1]['messages'][1]['content'][0]['text'].split('\n',1)[1]);self.assertEqual(context['pages'][0]['page'],3);self.assertEqual(context['pages'][0]['text'],'');self.assertTrue(context['pages'][0]['hasImage'])
                    self.assertEqual(len(uploads),first_uploads+2)
                    frame.locator('#page-number').fill('2');frame.locator('#page-number').dispatch_event('change');reply=page.evaluate(async_send);self.assertEqual(reply['status'],'complete',reply);self.assertEqual(len(uploads),first_uploads+2)
                    self.assertEqual(len(list((workspace.root/'sessions/pdf-context').glob('*.json'))),2)
                    page.evaluate("currentAISession().sources=[{path:'sample.pdf',page:1,text:'ONLY EXCERPT',rects:[[0,0,100,100]],fingerprint:'manual',kind:'text'}]")
                    reply=page.evaluate(async_send);self.assertEqual(reply['status'],'complete',reply);last=provider.calls[-1][1]['messages'][-1]['content'];self.assertIsInstance(last,str);self.assertIn('ONLY EXCERPT',last);self.assertNotIn('"kind": "pdf-page"',last)
                    # An unavailable automatic snapshot must not prevent the
                    # same chat from handing a real PDF path to the agent.
                    uploads_before_fallback=len(uploads)
                    page.evaluate("()=>{currentAISession().sources=[];delete document.querySelector('#pdf-editors iframe').dataset.aiReady;}")
                    reply=page.evaluate(async_send);self.assertEqual(reply['status'],'complete',reply)
                    payload=provider.calls[-1][1];content=payload['messages'][1]['content'];text=content[0]['text'] if isinstance(content,list) else content
                    context=json.loads(text.split('\n',1)[1]);self.assertEqual(context['readTarget'],{'path':'sample.pdf','page':2});self.assertNotIn('pages',context)
                    self.assertIn('未取得本轮自动页面快照',context['note']);self.assertIn('read_pdf(path,startPage=2)',context['note']);self.assertIn('search_pdf',context['note'])
                    self.assertIn('read_pdf',[tool['function']['name'] for tool in payload['tools']]);self.assertFalse(page.evaluate("!!currentAISession().messages.at(-2).pdfContext"))
                    self.assertEqual(len(uploads),uploads_before_fallback)
                    calls_before_cancel=len(provider.calls);messages_before_cancel=page.evaluate('currentAISession().messages.length')
                    page.evaluate("""async()=>{const original=prepareAIChanges;try{prepareAIChanges=async()=>{currentAISession().request.controller.abort();return null;};await sendAI(currentAISession(),'Cancelled before provider send','chat');}finally{prepareAIChanges=original;}}""")
                    self.assertEqual(len(provider.calls),calls_before_cancel);self.assertEqual(page.evaluate('currentAISession().messages.length'),messages_before_cancel)
                    page.evaluate("document.querySelector('#pdf-editors iframe').dataset.aiReady='true'")
                    self.assertEqual(errors,[]);browser.close()
            finally:
                server.shutdown();server.server_close();provider.shutdown();provider.server_close();app.stop()
