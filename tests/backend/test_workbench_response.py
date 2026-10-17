"""Temporary-workspace browser checks for stable restoration and file moves."""
import base64
from pathlib import Path
import tempfile
import threading
import time
import unittest
from collections import Counter
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from slide_notes.application import Application, Environment
from slide_notes.web.server import handler_factory


class WorkbenchResponseTests(unittest.TestCase):
    def test_restore_one_surface_and_move_keeps_native_editor(self):
        from playwright.sync_api import sync_playwright
        from test_pdf_ai_context import sample_pdf
        with tempfile.TemporaryDirectory(prefix='notes-response-') as directory, patch.object(Environment, 'start', Environment.snapshot):
            app = Application(Path(directory) / 'config')
            info = app.open(str(Path(directory) / 'workspace'), create=True)
            workspace = app.get(info['id'])
            notes = [workspace.create(f'Temporary {index}') for index in range(4)]
            current = notes[-1]
            document = current['document']
            document['slides'][0]['cells'] = [
                {'id': f'response{index}', 'kind': 'markdown',
                 'source': f'## Temporary paragraph {index}\n\n普通文字 $x_k+x_k$，这是可以编辑、选择和移动的笔记内容。\n\n[[related.json|相对链接]]\n\n' + '长段落用于保留滚动位置。' * 16,
                 'display': 'normal', 'showCode': False}
                for index in range(12)
            ]
            workspace.notebook(current['path'])[1].save(document, current['revision'])
            app.remember(info['id'], current['path'], {'tabs': [{'kind': 'notebook', 'path': note['path']} for note in notes], 'active': current['path']})
            calls = []
            active_requests = 0
            maximum_requests = 0
            lock = threading.Lock()
            runtime_gate = threading.Event()
            document_gate, document_entered = threading.Event(), threading.Event()
            control = {'block': None}
            base = handler_factory(application=app)

            class Handler(base):
                def log_message(self, *args):
                    pass

                def do_GET(self):
                    nonlocal active_requests, maximum_requests
                    path = urlparse(self.path).path
                    with lock:
                        calls.append(self.path)
                    if path == '/api/document':
                        with lock:
                            active_requests += 1
                            maximum_requests = max(maximum_requests, active_requests)
                        try:
                            time.sleep(.12)
                            if parse_qs(urlparse(self.path).query).get('path') == [control['block']]:
                                document_entered.set()
                                document_gate.wait(4)
                            super().do_GET()
                        finally:
                            with lock:
                                active_requests -= 1
                    else:
                        if path == '/api/runtime':
                            runtime_gate.wait(4)
                        super().do_GET()

            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
                    page = browser.new_page(viewport={'width': 1300, 'height': 1000})
                    errors, navigations = [], []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('request', lambda request: navigations.append(request.url) if request.is_navigation_request() and request.frame == page.main_frame else None)
                    page.add_init_script("""window.responseFrames=[];function responseSample(){
                      const visible=node=>!!node&&getComputedStyle(node).display!=='none'&&getComputedStyle(node).visibility!=='hidden'&&node.getBoundingClientRect().height>0;
                      const loading=document.documentElement.classList.contains('workbench-loading'),welcome=document.getElementById('workbench-empty');
                      responseFrames.push({loading,welcome:visible(welcome)&&visible(document.getElementById('editor-deck')),cells:document.querySelectorAll('.code-cell').length});
                      if(responseFrames.length<600)requestAnimationFrame(responseSample);
                    }requestAnimationFrame(responseSample);""")
                    page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='domcontentloaded')
                    page.wait_for_function("typeof workbenchReady!=='undefined'&&workbenchReady&&!document.documentElement.classList.contains('workbench-loading')", timeout=30000)
                    # The runtime handler is still blocked: the document and editor
                    # are usable without waiting for an unrelated Python snapshot.
                    self.assertFalse(runtime_gate.is_set())
                    self.assertFalse(page.evaluate('editorTabs.switching'))
                    self.assertEqual(page.evaluate('state.path'), current['path'])
                    self.assertEqual(page.evaluate('workspaceKey'), info['id'])
                    self.assertEqual(len(navigations), 1, navigations)
                    self.assertGreaterEqual(maximum_requests, 2)
                    document_calls = [path for path in calls if urlparse(path).path == '/api/document']
                    self.assertEqual(len(document_calls), 4, document_calls)
                    self.assertTrue(all(count == 1 for count in Counter(document_calls).values()))
                    self.assertFalse(any(urlparse(path).path == '/api/search' for path in calls))
                    self.assertEqual(page.evaluate('responseFrames.filter(frame=>frame.welcome).length'), 0)
                    self.assertTrue(page.evaluate('responseFrames.some(frame=>frame.loading)'))
                    self.assertFalse(page.evaluate("[...document.getAnimations()].some(animation=>animation.effect?.target?.matches('#sidebar,#main'))"))
                    runtime_gate.set()
                    page.evaluate("async()=>{state.panel='files';renderInspector();explorer.expanded.add('notebooks');await refreshFileRows();}")
                    page.wait_for_selector('#file-tree .file-row[data-kind="notebook"]')

                    page.evaluate("""()=>{
                      const card=document.querySelector('.code-cell'),view=card.codeEditor,main=document.getElementById('main');
                      view.focus();view.dispatch({selection:{anchor:7,head:19}});main.scrollTo({top:380,behavior:'instant'});
                      window.responseBefore={card,view,sidebar:document.querySelector('.slide-tab'),treeRow:[...document.querySelectorAll('#file-tree .file-row')].find(row=>row.dataset.path===state.path),
                        siblingRow:[...document.querySelectorAll('#file-tree .file-row')].find(row=>row.dataset.kind==='notebook'&&row.dataset.path!==state.path),
                        selection:view.state.selection.toJSON(),scroll:main.scrollTop,source:view.state.doc.toString()};
                    }""")
                    before_calls = len(calls)
                    moved = 'notebooks/Moved Temporary.json'
                    result = page.evaluate("""async destination=>{
                      const before=responseBefore;await moveFile(state.path,destination);
                      return {sameCard:before.card===document.querySelector('.code-cell'),sameEditor:before.view===document.querySelector('.code-cell').codeEditor,
                        sameSidebar:before.sidebar===document.querySelector('.slide-tab'),sameTreeRow:before.treeRow===[...document.querySelectorAll('#file-tree .file-row')].find(row=>row.dataset.path===destination),
                        sameSibling:before.siblingRow.isConnected,selection:before.view.state.selection.toJSON(),previousSelection:before.selection,
                        scroll:document.getElementById('main').scrollTop,previousScroll:before.scroll,path:state.path,active:editorTabs.active};
                    }""", moved)
                    self.assertTrue(result['sameCard'], result)
                    self.assertTrue(result['sameEditor'], result)
                    self.assertTrue(result['sameSidebar'], result)
                    self.assertTrue(result['sameTreeRow'], result)
                    self.assertTrue(result['sameSibling'], result)
                    self.assertEqual(result['selection'], result['previousSelection'])
                    self.assertAlmostEqual(result['scroll'], result['previousScroll'], delta=1)
                    self.assertEqual(result['path'], moved)
                    self.assertEqual(result['active'], moved)
                    moved_calls = [path for path in calls[before_calls:] if urlparse(path).path == '/api/document']
                    self.assertEqual(len(moved_calls), 1, moved_calls)
                    self.assertIn('Moved%20Temporary.json', moved_calls[0])
                    page.evaluate("responseBefore.view.focus();responseBefore.view.dispatch({selection:{anchor:10}})")
                    page.keyboard.insert_text('验证')
                    page.evaluate('save()')
                    self.assertIn('验证', workspace.document(moved)['document']['slides'][0]['cells'][0]['source'])
                    page.keyboard.press('Control+z')
                    page.evaluate('save()')
                    self.assertEqual(workspace.document(moved)['document']['slides'][0]['cells'][0]['source'], document['slides'][0]['cells'][0]['source'])
                    page.evaluate("responseBefore.view.dispatch({selection:{anchor:0}});responseBefore.view.contentDOM.blur();responseBefore.view.requestMeasure()")
                    page.wait_for_selector('a.internal-link[data-href="related.json"]')
                    self.assertEqual(page.evaluate("""()=>{
                      const card=responseBefore.card;let sourcePath;
                      card.addEventListener('obsidian-open-link',event=>{sourcePath=event.detail.sourcePath;event.stopPropagation();},{once:true});
                      card.querySelector('a.internal-link[data-href="related.json"]').click();return sourcePath;
                    }"""), moved)
                    # A delayed metadata response cannot replace typing done while
                    # the moved notebook remains usable.
                    edited_move = 'notebooks/Edited During Move.json'
                    control['block'] = edited_move
                    page.evaluate("destination=>{window.pendingResponseMove=moveFile(state.path,destination);}", edited_move)
                    self.assertTrue(document_entered.wait(3))
                    page.evaluate('responseBefore.view.focus();responseBefore.view.dispatch({selection:{anchor:10}})')
                    page.keyboard.insert_text('并行输入')
                    document_gate.set()
                    page.evaluate('pendingResponseMove')
                    page.evaluate('save()')
                    self.assertIn('并行输入', workspace.document(edited_move)['document']['slides'][0]['cells'][0]['source'])
                    self.assertTrue(page.evaluate('responseBefore.card===document.querySelector(".code-cell")'))
                    # Moving an unrelated directory updates its tree without any
                    # reads or reconstruction of the four open notebooks.
                    workspace.mutate('mkdir', 'unrelated')
                    before_calls = len(calls)
                    page.evaluate("moveFile('unrelated','renamed-unrelated')")
                    self.assertFalse(any(urlparse(path).path == '/api/document' for path in calls[before_calls:]))
                    self.assertTrue(page.evaluate('responseBefore.card===document.querySelector(".code-cell")'))
                    page.screenshot(path='/tmp/slide-notes-workbench-response.png')
                    # Local pictures and an embedded notebook retain their DOM,
                    # but resolve URLs using the moved owner, including the nested
                    # notebook's own directory rather than its parent's directory.
                    workspace.mutate('mkdir', 'notebooks/pack')
                    workspace.mutate('mkdir', 'notebooks/pack/sub')
                    pixel = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWooAAAAASUVORK5CYII=')
                    (workspace.root / 'notebooks/pack/local.png').write_bytes(pixel)
                    (workspace.root / 'notebooks/pack/sub/nested.png').write_bytes(pixel)
                    (workspace.root / 'notebooks/pack/paper.pdf').write_bytes(sample_pdf())
                    nested = workspace.create('Nested', 'notebooks/pack/sub')
                    nested_doc = nested['document']
                    nested_doc['slides'][0]['cells'] = [{'id': 'nestedimage', 'kind': 'markdown', 'source': '![nested](nested.png)', 'display': 'normal', 'showCode': False}]
                    workspace.notebook(nested['path'])[1].save(nested_doc, nested['revision'])
                    resource = workspace.create('Resources', 'notebooks/pack')
                    resource_doc = resource['document']
                    resource_doc['slides'][0]['cells'] = [{'id': 'resourceimages', 'kind': 'markdown', 'source': '![[local.png]]\n\n![normal](local.png)\n\n![[paper.pdf]]\n\n![[sub/Nested.json]]', 'display': 'normal', 'showCode': False}]
                    workspace.notebook(resource['path'])[1].save(resource_doc, resource['revision'])
                    page.evaluate('path=>openNotebook(path)', resource['path'])
                    page.wait_for_function("document.querySelectorAll('#cells img').length===3&&[...document.querySelectorAll('#cells img')].every(image=>image.complete&&image.naturalWidth>0)")
                    page.evaluate("window.responseResources={card:document.querySelector('.code-cell'),images:[...document.querySelectorAll('#cells img')],body:document.querySelector('.markdown-embed-content'),pdf:document.querySelector('.markdown-pdf-embed')}")
                    page.evaluate("moveFile('notebooks/pack','notebooks/MovedPack')")
                    page.wait_for_function("[...document.querySelectorAll('#cells img')].every(image=>image.complete&&image.naturalWidth>0&&image.getAttribute('src').includes('MovedPack'))")
                    resource_result = page.evaluate("""()=>({sameCard:responseResources.card===document.querySelector('.code-cell'),sameImages:responseResources.images.every((image,index)=>image===document.querySelectorAll('#cells img')[index]),
                      sameBody:responseResources.body===document.querySelector('.markdown-embed-content'),sourcePath:responseResources.body.dataset.markdownSourcePath,urls:responseResources.images.map(image=>image.getAttribute('src')),
                      samePDF:responseResources.pdf===document.querySelector('.markdown-pdf-embed'),pdfURL:responseResources.pdf.getAttribute('src')})""")
                    self.assertTrue(resource_result['sameCard'], resource_result)
                    self.assertTrue(resource_result['sameImages'], resource_result)
                    self.assertTrue(resource_result['sameBody'], resource_result)
                    self.assertEqual(resource_result['sourcePath'], 'notebooks/MovedPack/sub/Nested.json')
                    self.assertIn('MovedPack%2Fsub%2Fnested.png', resource_result['urls'][-1])
                    self.assertTrue(resource_result['samePDF'], resource_result)
                    self.assertIn('MovedPack', resource_result['pdfURL'])
                    pdf_file = parse_qs(urlparse(resource_result['pdfURL']).query)['file'][0]
                    self.assertTrue(page.request.get(f'http://127.0.0.1:{server.server_port}' + pdf_file).ok)
                    self.assertEqual(errors, [])
                    browser.close()
            finally:
                runtime_gate.set()
                document_gate.set()
                server.shutdown()
                server.server_close()
                app.stop()
