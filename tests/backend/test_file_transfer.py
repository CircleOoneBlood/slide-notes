"""File exchange uses disposable workspaces and no model or user documents."""
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

from slide_notes.application import Application, Environment
from slide_notes.web.server import handler_factory


class FileTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.base=Path(self.temp.name)
        self.patch=patch.object(Environment,'start',Environment.snapshot);self.patch.start()
        self.app=Application(self.base/'config')
        self.info=self.app.open(str(self.base/'workspace'),create=True)
        self.workspace=self.app.get(self.info['id'])

    def tearDown(self):
        self.app.stop();self.patch.stop();self.temp.cleanup()

    def test_copy_same_folder_collision_and_independent_notebook_store(self):
        original=self.workspace.create('Original');raw=(self.workspace.root/original['path']).read_bytes()
        result=self.workspace.mutate('copy',original['path'],original['path'],self.workspace.impact(original['path'])['revision'])
        self.assertEqual(result['path'],'notebooks/Original (1).json')
        second=self.workspace.document(result['path']);doc=second['document'];doc['title']='Independent'
        self.workspace.notebook(result['path'])[1].save(doc,second['revision'])
        self.assertEqual((self.workspace.root/original['path']).read_bytes(),raw)
        self.assertIsNot(self.workspace.notebook(original['path'])[2],self.workspace.notebook(result['path'])[2])

    def test_copy_folder_preflight_preserves_sources_and_rejects_unsafe_children(self):
        root=self.workspace.root;folder=root/'folder';folder.mkdir();(folder/'nested').mkdir()
        (folder/'nested/data.bin').write_bytes(b'\0\xffexact')
        result=self.workspace.mutate('copy','folder','folder',self.workspace.impact('folder')['revision'])
        self.assertEqual((root/result['path']/'nested/data.bin').read_bytes(),b'\0\xffexact')
        with self.assertRaises(ValueError):self.workspace.mutate('copy','folder','folder/child',self.workspace.impact('folder')['revision'])
        (folder/'link').symlink_to(self.base/'config',target_is_directory=True)
        with self.assertRaises(ValueError):self.workspace.mutate('copy','folder','unsafe-copy',self.workspace.impact('folder')['revision'])
        self.assertFalse((root/'unsafe-copy').exists())

    def test_import_binary_zero_length_collision_and_incomplete_upload(self):
        workspace=self.workspace;data=b'\0\xff\nexact binary'
        self.assertEqual(workspace.import_file('docs/data.bin',io.BytesIO(data),len(data))['path'],'docs/data.bin')
        self.assertEqual(workspace.import_file('docs/data.bin',io.BytesIO(b'new'),3)['path'],'docs/data (1).bin')
        self.assertEqual((workspace.root/'docs/data.bin').read_bytes(),data)
        workspace.import_file('empty.txt',io.BytesIO(b''),0)
        with self.assertRaises(ValueError):workspace.import_file('incomplete.bin',io.BytesIO(b'short'),100)
        self.assertFalse((workspace.root/'incomplete.bin').exists())
        for path in ('../escape','/tmp/escape','.slide-notes/secret','.venv/file',
                     'C:/outside.txt','C:outside.txt',r'..\escape',r'\\server\share\file'):
            with self.subTest(path=path),self.assertRaises(ValueError):workspace.import_file(path,io.BytesIO(b'a'),1)
        with self.assertRaises(ValueError):workspace.import_file('too-big',io.BytesIO(),100*1024*1024+1)

    def test_unique_import_directory_and_export_zip_preserve_empty_directories(self):
        workspace=self.workspace
        self.assertEqual(workspace.import_directory('references')['path'],'references')
        self.assertEqual(workspace.import_directory('references')['path'],'references (1)')
        (workspace.root/'references/empty').mkdir();(workspace.root/'references/中文.txt').write_text('内容')
        with workspace.export_file('references') as (stream,name,mime):
            self.assertEqual((name,mime),('references.zip','application/zip'))
            with zipfile.ZipFile(stream) as archive:
                self.assertIn('references/empty/',archive.namelist())
                self.assertEqual(archive.read('references/中文.txt').decode(),'内容')
        (workspace.root/'references/link').symlink_to(self.base/'config',target_is_directory=True)
        with self.assertRaises(ValueError):
            with workspace.export_file('references'):pass

    def start_server(self):
        Base=handler_factory(application=self.app)
        class Handler(Base):
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:'+str(server.server_port)

    def test_http_binary_import_export_head_and_origin_workspace_boundaries(self):
        base=self.start_server();query={'workspace':self.info['id'],'path':'files/中文.bin'}
        url=base+'/api/files/import?'+urlencode(query);payload=b'\0\xffbinary'
        request=Request(url,data=payload,headers={'Content-Type':'application/octet-stream'})
        with urlopen(request) as response:self.assertEqual(json.load(response)['path'],query['path'])
        exported=base+'/api/files/export?'+urlencode(query)
        with urlopen(exported) as response:
            self.assertEqual(response.read(),payload);self.assertIn('attachment',response.headers['Content-Disposition'])
            self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
        with urlopen(Request(exported,method='HEAD')) as response:self.assertEqual(int(response.headers['Content-Length']),len(payload))
        with self.assertRaises(HTTPError) as error:urlopen(Request(url,data=payload,headers={'Content-Type':'application/octet-stream','Origin':'https://example.org'}))
        self.assertEqual(error.exception.code,403)
        other=self.app.open(str(self.base/'other'),create=True)
        with self.assertRaises(HTTPError):urlopen(base+'/api/files/export?'+urlencode({**query,'workspace':other['id']}))
        with self.assertRaises(HTTPError):urlopen(base+'/api/files/export?'+urlencode({**query,'path':'../config/settings.json'}))

    def test_real_browser_file_drop_folder_import_clipboard_move_and_export(self):
        from playwright.sync_api import sync_playwright
        original=self.workspace.create('Original');self.workspace.mutate('mkdir','notebooks/destination')
        doc=original['document'];doc['slides'][0]['cells']=[{'id':'md1','kind':'markdown','source':'## Original content','display':'normal','showCode':False}]
        self.workspace.notebook(original['path'])[1].save(doc,original['revision'])
        self.app.remember(self.info['id'],original['path'],{'tabs':[{'kind':'notebook','path':original['path']}],'active':original['path']})
        base=self.start_server()
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox'])
            context=browser.new_context(permissions=['clipboard-read','clipboard-write'],accept_downloads=True)
            page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/?workspace='+self.info['id'],wait_until='domcontentloaded')
            page.wait_for_function("typeof workbenchReady!=='undefined'&&workbenchReady")
            page.evaluate("state.panel='files';explorer.mode='all';renderInspector()")
            page.wait_for_selector('#file-tree .file-row')
            # Real browser File objects sent through the application's drop
            # listener; the server must preserve every binary byte.
            page.evaluate("""()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array([0,255,10,42])],'dropped.bin'));document.querySelector('#file-tree').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}""")
            page.wait_for_function('!fileActionBusy')
            self.assertEqual((self.workspace.root/'dropped.bin').read_bytes(),bytes([0,255,10,42]))
            # External files pasted onto the tree use the selected folder.
            page.evaluate("""()=>{explorer.selectedDirectory='notebooks/destination';const data=new DataTransfer();data.items.add(new File(['pasted bytes'],'pasted.txt'));document.querySelector('#file-tree').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}""")
            page.wait_for_function('!fileActionBusy')
            self.assertEqual((self.workspace.root/'notebooks/destination/pasted.txt').read_text(),'pasted bytes')
            # The native folder chooser supplies real relative paths.
            folder=self.base/'external-folder';(folder/'nested').mkdir(parents=True);(folder/'nested/a.txt').write_text('nested bytes')
            page.locator('.files-tools strong').click(button='right')
            with page.expect_file_chooser() as chooser:page.get_by_role('menuitem',name='导入文件夹…',exact=True).click()
            chooser.value.set_files(str(folder));page.wait_for_function('!fileActionBusy')
            self.assertEqual((self.workspace.root/'external-folder/nested/a.txt').read_text(),'nested bytes')
            self.assertEqual((folder/'nested/a.txt').read_text(),'nested bytes')
            # Directory drops include empty folders and readEntries may return
            # several batches, unlike a flat file chooser list.
            page.evaluate("""()=>{
             const file=name=>({name,isFile:true,file:resolve=>resolve(new File([name],name))});
             const empty={name:'empty',isDirectory:true,createReader:()=>({readEntries:resolve=>resolve([])})};
             const folder={name:'dropped-folder',isDirectory:true,createReader:()=>{const batches=[[empty,file('one.txt')],[file('two.txt')],[]];return {readEntries:resolve=>resolve(batches.shift()||[])};}};
             const event=new DragEvent('drop',{bubbles:true,cancelable:true});
             Object.defineProperty(event,'dataTransfer',{value:{types:['Files'],items:[{kind:'file',webkitGetAsEntry:()=>folder,getAsFile:()=>null}],files:[]}});
             document.querySelector('#file-tree').dispatchEvent(event);
            }""")
            page.wait_for_function('!fileActionBusy')
            self.assertTrue((self.workspace.root/'dropped-folder/empty').is_dir())
            self.assertEqual((self.workspace.root/'dropped-folder/two.txt').read_text(),'two.txt')
            # Ctrl+C / Ctrl+V are real browser clipboard events, not calls to
            # the file helper. Repeated paste must keep the original intact.
            source=page.locator('.file-row[data-path="dropped.bin"]');source.focus();page.keyboard.press('Control+c')
            page.locator('.files-tools strong').focus();page.evaluate("explorer.selectedDirectory=''")
            page.keyboard.press('Control+v')
            page.wait_for_function("!fileActionBusy&&!!document.querySelector('.file-row[data-path=\"dropped (1).bin\"]')")
            self.assertEqual((self.workspace.root/'dropped (1).bin').read_bytes(),bytes([0,255,10,42]))
            # Cut an open, unsaved note and paste into a folder. Save goes to
            # its new path and the tab follows; the original is not recreated.
            page.evaluate("async()=>{await toggleFileTreeDirectory('notebooks',true);const card=document.querySelector('.markdown-cell');if(card?.codeEditor)card.codeEditor.dispatch({changes:{from:0,to:card.codeEditor.state.doc.length,insert:'## Before moving'}})}")
            note=page.locator('.file-row[data-path="'+original['path']+'"]');note.focus();page.keyboard.press('Control+x')
            self.assertTrue(note.evaluate("node=>node.classList.contains('file-cut')"))
            destination=page.locator('.file-row[data-path="notebooks/destination"]');destination.focus();page.keyboard.press('Control+v')
            page.wait_for_function("state.path==='notebooks/destination/Original.json'&&!fileActionBusy")
            self.assertFalse((self.workspace.root/original['path']).exists())
            self.assertEqual(page.evaluate('editorTabs.active'),'notebooks/destination/Original.json')
            page.evaluate('async()=>await save()')
            self.assertTrue((self.workspace.root/'notebooks/destination/Original.json').exists())
            self.assertEqual(self.workspace.document('notebooks/destination/Original.json')['document']['slides'][0]['cells'][0]['source'],'## Before moving')
            # Drag-out advertises a concrete download URL, whose response is
            # the real file rather than a path string or an HTML preview.
            payload=source.evaluate("""node=>{const data=new DataTransfer();node.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));const result=data.getData('DownloadURL');node.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));return result;}""")
            self.assertIn('application/octet-stream:dropped.bin:',payload)
            with urlopen(payload.split(':',2)[2]) as response:self.assertEqual(response.read(),bytes([0,255,10,42]))
            source.click(button='right')
            with page.expect_download() as download:page.get_by_role('menuitem',name='导出文件',exact=True).click()
            self.assertEqual(Path(download.value.path()).read_bytes(),bytes([0,255,10,42]))
            # Files dropped over an unrelated panel must not import silently or
            # navigate the browser away from its unsaved notebook.
            ignored=page.evaluate("""()=>{state.panel='variables';renderInspector();const data=new DataTransfer();data.items.add(new File(['no'],'ignored.txt'));const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});document.querySelector('#inspector-content').dispatchEvent(event);return event.defaultPrevented;}""")
            self.assertTrue(ignored);self.assertFalse((self.workspace.root/'ignored.txt').exists())
            self.assertEqual(errors,[])
            browser.close()

    def test_real_browser_hide_config_toggle_search_and_persisted_workspace_preference(self):
        from playwright.sync_api import sync_playwright
        original=self.workspace.create('Original');root=self.workspace.root
        (root/'pyproject.toml').write_text('project configuration')
        (root/'package.json').write_text('{"name":"workspace"}')
        (root/'papers').mkdir();(root/'papers/existing.pdf').write_bytes(b'%PDF-example')
        base=self.start_server()
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/google-chrome',headless=True,args=['--no-sandbox'])
            page=browser.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/?workspace='+self.info['id'],wait_until='domcontentloaded')
            page.wait_for_function("typeof workbenchReady!=='undefined'&&workbenchReady")
            page.locator('#files-button').click()
            page.wait_for_selector('.file-row[data-path="papers"]')
            toggle=page.get_by_role('button',name='隐藏配置文件',exact=True)
            self.assertEqual(toggle.get_attribute('aria-pressed'),'true')
            self.assertEqual(page.locator('.file-row[data-path="pyproject.toml"]').count(),0)
            self.assertEqual(page.locator('.file-row[data-path="notebooks"]').count(),1)
            page.locator('#file-search').fill('package.json')
            page.wait_for_function("explorer.query==='package.json'&&!!document.querySelector('#file-tree .panel-empty')")
            toggle.click()
            page.wait_for_selector('.file-row[data-path="package.json"]')
            self.assertEqual(toggle.get_attribute('aria-pressed'),'false')
            page.reload();page.wait_for_function('workbenchReady')
            page.evaluate("state.panel='files';renderInspector()")
            page.wait_for_selector('.file-row[data-path="pyproject.toml"]')
            self.assertEqual(page.get_by_role('button',name='隐藏配置文件',exact=True).get_attribute('aria-pressed'),'false')
            page.get_by_role('button',name='隐藏配置文件',exact=True).click()
            page.wait_for_function("!document.querySelector('.file-row[data-path=\"pyproject.toml\"]')")
            # A newly imported file with a configuration-like name remains a
            # user file, while the original project file stays hidden.
            page.evaluate("""()=>{const data=new DataTransfer();data.items.add(new File(['my configuration notes'],'package.json'));document.querySelector('#file-tree').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}""")
            page.wait_for_function("!fileActionBusy&&!!document.querySelector('.file-row[data-path=\"package (1).json\"]')")
            self.assertEqual(page.locator('.file-row[data-path="package.json"]').count(),0)
            self.assertEqual((root/'package.json').read_text(),'{"name":"workspace"}')
            self.assertEqual((root/'package (1).json').read_text(),'my configuration notes')
            page.reload();page.wait_for_function('workbenchReady');page.evaluate("state.panel='files';renderInspector()")
            page.wait_for_selector('.file-row[data-path="package (1).json"]')
            self.assertEqual(page.locator('.file-row[data-path="pyproject.toml"]').count(),0)
            self.assertEqual(errors,[])
            browser.close()
