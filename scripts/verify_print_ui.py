"""PDF export browser check: uses only temporary notes and mock runtime outputs."""
import sys,tempfile,threading,json,subprocess
from pathlib import Path
from http.server import ThreadingHTTPServer
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent / "src"))
from slide_notes.application import Application,Environment
from slide_notes.web.server import handler_factory
from playwright.sync_api import sync_playwright
out=Path(tempfile.mkdtemp(prefix='slide-notes-pdf-check-'))
with tempfile.TemporaryDirectory() as tmp,patch.object(Environment,'start',Environment.snapshot):
 app=Application(Path(tmp)/'config');info=app.open(str(Path(tmp)/'workspace'),create=True);ws=app.get(info['id']);note=ws.create('PDF export test');doc=note['document'];doc['title']='PDF 导出验证'
 doc['slides']=[{'id':'pageone','name':'第一章 · 公式与图表','cells':[
  {'id':'md','kind':'markdown','source':'## 中文与 Markdown\n\n这是一段 **加粗文字**，包含公式 $E=mc^2$。\n\n$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$\n\n| 项目 | 数值 |\n| --- | --- |\n| 甲 | 42 |\n| 乙 | 98 |','display':'normal','layout':{'row':'r','column':'left','x':0,'width':50}},
  {'id':'py','kind':'code','source':'# VISIBLE_PYTHON_SOURCE\nx = [1,2,3]','showCode':True,'display':'fragment','layout':{'row':'r','column':'right','x':50,'width':50}},
  {'id':'fragment','kind':'markdown','source':'FRAGMENT_IS_PRINTED','display':'fragment'},
  {'id':'skip','kind':'markdown','source':'SKIP_MUST_NOT_PRINT','display':'skip'}]},
 {'id':'pagetwo','name':'第二章 · 运行结果','cells':[
  {'id':'other','kind':'markdown','source':'SECOND_PAGE_ONLY\n\n![示意图](data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%22300%22%20height=%2270%22%3E%3Crect%20width=%22300%22%20height=%2270%22%20fill=%22%23ddeaff%22/%3E%3Ctext%20x=%2230%22%20y=%2242%22%3EImage%20output%3C/text%3E%3C/svg%3E)','display':'normal'},
  {'id':'uncached','kind':'code','source':'HIDDEN_PYTHON_SOURCE','showCode':False,'display':'normal'},
  {'id':'mo','kind':'code','source':'HIDDEN_MO_SOURCE','showCode':False,'display':'normal'}]},
 {'id':'pagelong','name':'第三章 · 长内容分页','cells':[{'id':'long','kind':'markdown','source':'\n\n'.join(f'段落 {i+1:02d} - Long content flows to the next sheet without clipping.' for i in range(65))+'\n\nEND_OF_LONG_CONTENT','display':'normal'}]}]
 ws.notebook(note['path'])[1].save(doc,note['revision'])
 server=ThreadingHTTPServer(('127.0.0.1',0),handler_factory(application=app));server.daemon_threads=True;threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path=p.chromium.executable_path,headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1360,'height':1000});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   page.goto(f'http://127.0.0.1:{server.server_port}/?workspace='+info['id']);page.wait_for_function("typeof prepareNotebookPrint==='function'");page.evaluate('(path)=>loadNotebook(path)',note['path']);page.wait_for_selector('#cell-md')
   page.evaluate('''()=>{state.runtime={outputs:{py:{stdout:'PLOT_STDOUT',result:{kind:'plotly',figure:{data:[{x:[1,2,3],y:[2,4,3],type:'scatter',mode:'lines+markers'}],layout:{title:{text:'Vector chart → high resolution PNG'}}}}},uncached:{result:{kind:'markdown',text:'UNCACHED_RUNTIME_OUTPUT **成功**'}},mo:{result:{kind:'marimo',html:'<p>MO_OUTPUT <marimo-tex>||[x^2||]</marimo-tex></p><marimo-ui-element object-id="slider"></marimo-ui-element>',widgets:[{id:'slider',type:'slider',label:'参数',value:3}]}}},errors:{}};state.runtimeDirty=true;render();document.querySelector('#cell-md').startEditing();}''');page.wait_for_function("document.querySelector('#cell-py .plot')?.data");page.evaluate("document.querySelector('#cell-md').codeEditor.dispatch({selection:{anchor:5}})")
   before=page.evaluate('JSON.stringify({active:state.active,mode:state.mode,epoch:state.epoch,source:state.doc,editing:[...state.markdownEditing]})')
   # Keyboard and context-menu entries expose both scope choices.
   page.keyboard.press('Control+p');page.wait_for_selector('#notebook-print-dialog[open]');assert page.locator('#notebook-print-scope').input_value()=='all';page.locator('#notebook-print-cancel').click()
   page.locator('.slide-tab').nth(1).click(button='right');page.get_by_role('menuitem',name='导出此页 PDF / 打印…').click();assert page.locator('#notebook-print-scope').input_value()=='page';assert page.locator('#notebook-print-page').input_value()=='1';page.locator('#notebook-print-cancel').click()
   # Snapshot has cached Plotly on the active page and unvisited runtime outputs elsewhere.
   for scope,index,name in [('all',0,'entire-notebook'),('page',0,'single-page')]:
    html=page.evaluate('''async ({scope,index})=>{const frame=await prepareNotebookPrint(snapshotNotebookPrint(),{scope,index,orientation:'landscape'});return frame.contentDocument.documentElement.outerHTML;}''',{'scope':scope,'index':index})
    frame=page.locator('.notebook-print-frame').content_frame
    assert frame.locator('.print-page').count()==(3 if scope=='all' else 1)
    text=frame.locator('body').inner_text();assert 'FRAGMENT_IS_PRINTED' in text;assert 'SKIP_MUST_NOT_PRINT' not in text;assert 'VISIBLE_PYTHON_SOURCE' in text;assert 'HIDDEN_PYTHON_SOURCE' not in text;assert '可能已过期' in text
    assert frame.locator('.print-plot').count()==1;assert frame.locator('.obsidian-markdown mjx-container').count()>=2
    assert frame.locator('.print-row').first.locator('.print-column').count()==2
    if scope=='all':
     assert 'UNCACHED_RUNTIME_OUTPUT' in text and 'END_OF_LONG_CONTENT' in text and 'MO_OUTPUT' in text
     assert frame.locator('img').count()==2
     assert frame.locator('img[alt=示意图]').evaluate('(image)=>image.naturalWidth')==300
    else:assert 'SECOND_PAGE_ONLY' not in text
    proof=browser.new_page();proof.goto(f'http://127.0.0.1:{server.server_port}/notebook-paper.css');proof.set_content(html,wait_until='networkidle');proof.evaluate('document.fonts.ready');proof.pdf(path=str(out/(name+'.pdf')),print_background=True,prefer_css_page_size=True);proof.close()
   after=page.evaluate('JSON.stringify({active:state.active,mode:state.mode,epoch:state.epoch,source:state.doc,editing:[...state.markdownEditing]})');assert before==after
   # Submit hands the prepared document to print(), cancel leaves the note intact.
   page.evaluate("window.printCalled=0;window.originalPrepare=prepareNotebookPrint;prepareNotebookPrint=async(...args)=>{const frame=await originalPrepare(...args);frame.contentWindow.print=()=>{window.printCalled++;};return frame;};openNotebookPrintDialog('page',1)")
   page.locator('#notebook-print-submit').click();page.wait_for_function('window.printCalled===1');assert not page.locator('#notebook-print-dialog').evaluate('(dialog)=>dialog.open');assert page.locator('.notebook-print-frame').content_frame.locator('.print-page').count()==1
   page.evaluate("window.printCalled=0;prepareNotebookPrint=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,350));const frame=await originalPrepare(...args);frame.contentWindow.print=()=>{window.printCalled++;};return frame;};openNotebookPrintDialog('all')")
   page.locator('#notebook-print-submit').click();page.locator('#notebook-print-cancel').click();page.wait_for_function('!notebookPrintBusy');assert page.evaluate('window.printCalled')==0;assert page.locator('.notebook-print-frame').count()==0
   assert not errors,errors;browser.close()
  for name in ['entire-notebook','single-page']:
   path=out/(name+'.pdf');info=subprocess.check_output(['pdfinfo',str(path)],text=True);print(name,next(line for line in info.splitlines() if line.startswith('Pages:')))
   text=subprocess.check_output(['pdftotext',str(path),'-'],text=True)
   assert 'SKIP_MUST_NOT_PRINT' not in text
   if name=='single-page':assert 'SECOND_PAGE_ONLY' not in text;assert 'Pages:           1' in info
   else:
    assert 'SECOND_PAGE_ONLY' in text and 'END_OF_LONG_CONTENT' in text
    sheets=text.split('\f');assert '段落 01' in sheets[2], 'Long content must start beside its page heading, without an empty sheet'
    assert len([sheet for sheet in sheets if sheet.strip()])==5
  print('PDF samples:',out)
  print('PASS: PDF scope, complete pagination, Markdown/math/image/chart rendering, visibility, runtime snapshots, menu/shortcut and editor state preservation')
 finally:server.shutdown();server.server_close();app.stop()
