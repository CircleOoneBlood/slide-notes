"""Pointer selection in real Chrome, real PDF.js and a fake local AI provider."""
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from slide_notes.application import Application,Environment
from slide_notes.ai.service import AIService
from slide_notes.ai.sources import sources
from slide_notes.ai.selections import read_selection
from slide_notes.ai.sessions import SessionStorage
from slide_notes.web.server import handler_factory
from test_ai import Provider
from test_pdf_ai_context import sample_pdf


class SelectionTests(unittest.TestCase):
    def test_pdf_source_validation(self):
        source={'path':'paper.pdf','page':1,'text':'FIRST','fingerprint':'original','rects':[[1,2,50,20]],'kind':'pdf-elements','elements':[{'index':0,'from':0,'to':5}]}
        self.assertEqual(sources([source]),[source])
        for change in [{'elements':[]},{'elements':[{'index':True,'from':0,'to':5}]},{'elements':[{'index':0,'from':5,'to':1}]},{'fingerprint':''},{'elements':[{'index':0,'from':0,'to':400001}]}]:
            with self.assertRaises(ValueError):sources([{**source,**change}])
        duplicate={**source,'rects':source['rects']*2,'elements':source['elements']*2}
        with self.assertRaises(ValueError):sources([duplicate])

    def test_notebook_and_pdf_direct_source_selection(self):
        from playwright.sync_api import sync_playwright, expect
        with tempfile.TemporaryDirectory() as directory,patch.object(Environment,'start',Environment.snapshot):
            app=Application(Path(directory)/'config');info=app.open(str(Path(directory)/'workspace'),create=True);workspace=app.get(info['id']);note=workspace.create('Selection fixture')
            doc=note['document'];doc['slides'][0]['cells']=[{'id':name,'kind':'markdown','source':'# '+name+'\n\nSource $x^2$ '+('paragraph ' * 8),'display':'normal','showCode':False} for name in ('one','two','three','four','five','six')]
            workspace.notebook(note['path'])[1].save(doc,note['revision']);original=copy.deepcopy(workspace.document(note['path']))
            pdf=sample_pdf();(workspace.root/'paper.pdf').write_bytes(pdf)
            app.remember(info['id'],note['path'],{'tabs':[{'kind':'notebook','path':note['path']}],'active':note['path']})
            provider=ThreadingHTTPServer(('127.0.0.1',0),Provider);provider.calls=[];provider.mode='stream';provider.waiter=threading.Event();threading.Thread(target=provider.serve_forever,daemon=True).start()
            AIService(app.config).configure({'baseUrl':f'http://127.0.0.1:{provider.server_port}/v1','model':'fake','apiKey':'test-only'})
            Base=handler_factory(application=app)
            class Handler(Base):
                def log_message(self,*args):pass
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
            try:
                with sync_playwright() as p:
                    browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1400,'height':1000});errors=[];uploads=[]
                    page.on('pageerror',lambda error:errors.append(str(error)))
                    page.on('request',lambda request:uploads.append(request.url) if request.method=='POST' and ('/api/ai/images' in request.url or '/api/ai/pdf-context' in request.url) else None)
                    page.goto(f'http://127.0.0.1:{server.server_port}/?workspace='+info['id'],wait_until='domcontentloaded')
                    page.wait_for_function("typeof workbenchReady!=='undefined'&&workbenchReady&&!!state.doc",timeout=30000)
                    page.evaluate("async()=>{state.panel='ai';renderInspector();const scope=loadAIScope(state.path);if(!scope.ready)await hydrateAIScope(scope);}")
                    plus=page.locator('#inspector .ai-add-cells');plus.click();self.assertEqual(plus.get_attribute('aria-pressed'),'true');self.assertEqual(page.locator('.ai-attachment-menu').count(),0)
                    first=page.locator('#cell-one').bounding_box();second=page.locator('#cell-two').bounding_box()
                    # Touch a thin strip of each card, never enclosing either card.
                    x=first['x']+first['width']-8
                    page.mouse.move(x,first['y']+first['height']-5);page.mouse.down();page.mouse.move(x+3,second['y']+6,steps=8);page.mouse.up()
                    self.assertEqual(page.evaluate('currentAISession().selectedCells'),['one','two'])
                    page.locator('#cell-two').click(position={'x':20,'y':20});self.assertEqual(page.evaluate('currentAISession().selectedCells'),['one'])
                    page.locator('#cell-three').click(position={'x':20,'y':20});self.assertEqual(page.evaluate('currentAISession().selectedCells'),['one','three'])
                    page.wait_for_function("!currentAISession().selectionUploads&&currentAISession().selectionReference?.cells.join('|')==='one|three'")
                    frozen=page.evaluate('currentAISession().selectionReference')
                    page.evaluate("async()=>{const view=document.getElementById('cell-one').codeEditor;view.dispatch({changes:{from:view.state.doc.length,insert:'\\n\\nAFTER_PICK_LATEST'}});await save();}")
                    self.assertNotIn('AFTER_PICK_LATEST',read_selection(workspace,{'id':frozen['id']})['text'])
                    self.assertIn('AFTER_PICK_LATEST',read_selection(workspace,{'id':frozen['id'],'version':'latest'})['text'])
                    self.assertTrue(read_selection(workspace,{'id':frozen['id']})['stale'])
                    # Cancel a drag restores the previous committed selection.
                    page.mouse.move(x,second['y']+4);page.mouse.down();page.mouse.move(x+5,second['y']+30);page.keyboard.press('Escape');page.mouse.up()
                    self.assertEqual(page.evaluate('currentAISession().selectedCells'),['one','three']);self.assertEqual(page.locator('.ai-capture-box').count(),0)
                    page.evaluate("async()=>{const s=currentAISession();s.draft='explain selected source';await sendAI(s,s.draft,'chat');}")
                    payload=provider.calls[-1][1];context=json.loads(payload['messages'][1]['content'].split('\n',1)[1]);self.assertEqual([c['id'] for slide in context['slides'] for c in slide['cells']],['one','three'])
                    self.assertTrue(all('source' not in cell for slide in context['slides'] for cell in slide['cells']));self.assertIn('Source $x^2$',payload['messages'][-1]['content']);self.assertEqual(uploads,[])
                    self.assertEqual(page.evaluate('currentAISession().messages.at(-2).sources.at(-1).id'),frozen['id'])
                    page.evaluate("async()=>{const view=document.getElementById('cell-one').codeEditor,marker='\\n\\nAFTER_PICK_LATEST';view.dispatch({changes:{from:view.state.doc.length-marker.length,to:view.state.doc.length,insert:''}});await save();}")
                    plus.click();page.evaluate("const s=currentAISession();s.selectedCells=[];document.getElementById('main').scrollTop=0;syncAISelection();refreshAI(s);")
                    first=page.locator('#cell-one').bounding_box();pane=page.locator('#main').bounding_box()
                    page.mouse.move(first['x']+10,first['y']+5);page.mouse.down();page.mouse.move(first['x']+20,pane['y']+pane['height']-4,steps=5)
                    page.wait_for_function("document.getElementById('main').scrollTop>100")
                    page.mouse.up();self.assertGreaterEqual(len(page.evaluate('currentAISession().selectedCells')),4)
                    page.evaluate("async()=>{await openEditor('pdf','paper.pdf');state.panel='ai';renderInspector();}")
                    page.wait_for_function("document.querySelector('#pdf-editors iframe')?.dataset.aiReady",timeout=30000)
                    frame=page.frame_locator('#pdf-editors iframe');frame.locator('#zoom').select_option('0.75')
                    frame.locator('.page[data-page-number="1"] .textLayer span').filter(has_text='FIRST PAGE ONLY').wait_for()
                    self.assertEqual(frame.locator('#pdf-crop').count(),0)
                    plus.click();page.wait_for_function("editorTabs.items.find(t=>t.path==='paper.pdf').aiPDFSelecting===currentAISession().key")
                    span=frame.locator('.page[data-page-number="1"] .textLayer span').filter(has_text='FIRST PAGE ONLY');r=span.bounding_box()
                    # Partial item selection keeps original item offsets and only touched characters.
                    page.mouse.move(r['x']+2,r['y']-2);page.mouse.down();page.mouse.move(r['x']+r['width']*.35,r['y']+r['height']+2,steps=5);page.mouse.up()
                    page.wait_for_function('currentAISession().sources.length===1')
                    source=page.evaluate('currentAISession().sources[0]');self.assertEqual(source['kind'],'selection-ref');self.assertEqual(source['targetKind'],'pdf-elements');snapshot=read_selection(workspace,{'id':source['id']});self.assertEqual(snapshot['locator']['elements'][0]['index'],0);self.assertLess(snapshot['locator']['elements'][0]['to'],len('FIRST PAGE ONLY'));self.assertNotIn('image',source)
                    self.assertEqual(frame.locator('.pdf-selection-menu').is_visible(),False);self.assertTrue(frame.locator('.pdf-source-highlight').count());self.assertEqual(uploads,[])
                    # A click chooses a text item; no screenshot is produced.
                    span.click();page.wait_for_function('currentAISession().sources.length===2');self.assertEqual(page.evaluate('currentAISession().sources[1].text'),'FIRST PAGE ONLY')
                    plus.click();page.wait_for_function("!editorTabs.items.find(t=>t.path==='paper.pdf').aiPDFSelecting")
                    # A single rectangle can select source items on two pages after zoom.
                    frame.locator('#zoom-out').click();frame.locator('#zoom-out').click()
                    span2=frame.locator('.page[data-page-number="2"] .textLayer span').filter(has_text='SECOND PAGE equation 42');span2.wait_for()
                    page.wait_for_timeout(200);plus.click()
                    r1=span.bounding_box();r2=span2.bounding_box()
                    page.mouse.move(r1['x']-2,r1['y']-2);page.mouse.down();page.mouse.move(r2['x']+r2['width']+2,r2['y']+r2['height']+2,steps=10);page.mouse.up()
                    page.wait_for_function('currentAISession().sources.length===4')
                    self.assertEqual(page.evaluate('currentAISession().sources.slice(-2).map(s=>s.page)'),[1,2]);self.assertEqual(page.evaluate('currentAISession().sources.at(-1).text'),'SECOND PAGE equation 42')
                    plus.click();page.wait_for_function("!editorTabs.items.find(t=>t.path==='paper.pdf').aiPDFSelecting")
                    # Native text selection also retains exact PDF text item offsets.
                    frame.locator('body').evaluate("()=>{const span=[...document.querySelectorAll('.textLayer span')].find(s=>s.textContent==='FIRST PAGE ONLY');const r=document.createRange();r.setStart(span.firstChild,6);r.setEnd(span.firstChild,10);const selection=getSelection();selection.removeAllRanges();selection.addRange(r);}")
                    frame.locator('.pdf-selection-menu').wait_for(state='visible')
                    self.assertEqual(frame.locator('.selection-excerpt').inner_text(),'PAGE')
                    frame.locator('.selection-add').click();page.wait_for_function('currentAISession().sources.length===5')
                    self.assertEqual(read_selection(workspace,{'id':page.evaluate('currentAISession().sources[4].id')})['locator']['elements'],[{'index':0,'from':6,'to':10}])
                    frame.locator('#zoom-out').click();frame.locator('.pdf-source-highlight').first.wait_for(state='visible')
                    page.evaluate("async()=>{const s=currentAISession();s.draft='explain source';await sendAI(s,s.draft,'chat');}")
                    payload=provider.calls[-1][1];self.assertFalse(any(part.get('type') in ('image_url','image') for m in payload['messages'] if isinstance(m.get('content'),list) for part in m['content']));self.assertIn('pdf-elements',payload['messages'][-1]['content']);self.assertEqual(uploads,[])
                    page.evaluate("async()=>{await flushAIScope(loadAIScope(''));}")
                    stored=SessionStorage().read(workspace,None,scope='workspace')['data'];stored_chat=next(chat for chat in stored['conversations'] if chat['id']==stored['active'])
                    self.assertEqual(stored_chat['messages'][-2]['sources'][0]['id'],source['id']);self.assertNotIn('elements',stored_chat['messages'][-2]['sources'][0])
                    # Backlink remains anchored after scale/rotation. Esc exits selection.
                    page.locator('#inspector .ai-source-link').filter(has_text='paper.pdf').first.click();frame.locator('#rotate').click();frame.locator('#zoom').select_option('0.75')
                    frame.locator('.pdf-source-highlight').first.wait_for(state='visible')
                    plus.click()
                    # The + command and its state acknowledgement cross the
                    # iframe asynchronously. Escape must follow activation;
                    # the previous inactive parent state is not an acknowledgement.
                    expect(frame.locator('#pdf-select')).to_have_attribute('aria-pressed','true')
                    frame.locator('#viewerContainer').press('Escape')
                    expect(frame.locator('#pdf-select')).to_have_attribute('aria-pressed','false')
                    page.wait_for_function("!editorTabs.items.find(t=>t.path==='paper.pdf').aiPDFSelecting")
                    # Image-only page must not silently fall back to a screenshot.
                    frame.locator('#page-number').fill('3');frame.locator('#page-number').dispatch_event('change');frame.locator('.page[data-page-number="3"] canvas').wait_for()
                    plus.click();expect(frame.locator('#pdf-select')).to_have_attribute('aria-pressed','true')
                    page.wait_for_function("editorTabs.items.find(t=>t.path==='paper.pdf').aiPDFSelecting===currentAISession().key")
                    r=frame.locator('.page[data-page-number="3"]').bounding_box();page.mouse.move(r['x']+50,r['y']+100);page.mouse.down();page.mouse.move(r['x']+250,r['y']+200,steps=5);page.mouse.up()
                    frame.locator('.pdf-selection-toast').filter(has_text='没有可选文字').wait_for(timeout=5000);self.assertEqual(page.evaluate('currentAISession().sources.length'),0);self.assertEqual(uploads,[])
                    self.assertEqual(workspace.document(note['path']),original);self.assertEqual((workspace.root/'paper.pdf').read_bytes(),pdf);self.assertEqual(errors,[])
                    browser.close()
            finally:
                server.shutdown();server.server_close();provider.shutdown();provider.server_close();app.stop()
