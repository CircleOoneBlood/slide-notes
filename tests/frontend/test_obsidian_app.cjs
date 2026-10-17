const testPaths = require('./paths.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const root=testPaths.APP_ROOT;
const scenarios=String.raw`
window.addEventListener('error',event=>document.getElementById('test-result').textContent=JSON.stringify({ok:false,error:event.message}));
window.addEventListener('load',()=>{(async()=>{
 const results=[];const check=(value,name)=>{if(!value)throw Error(name);results.push(name);};const tick=()=>new Promise(r=>setTimeout(r,40));
 for(let i=0;i<180&&(!state.doc||!workbenchReady);i++)await tick();
 check(!!state.doc,'temporary workspace boot');
 let card=document.querySelector('.markdown-cell');const cell=allCells().find(c=>c.kind==='markdown'),original=cell.source;
 check(card.dataset.markdownMode==='live'&&card.codeEditor,'default live preview');
 card.codeEditor.focus();card.codeEditor.dispatch({selection:{anchor:original.indexOf('x^2')}});await tick();
 check(card.querySelector('.markdown-math-edit-preview mjx-container[display="true"]'),'editing math retains its rendered preview');
 check(card.querySelectorAll('.markdown-math-edit-preview .math-source-active').length===1,'formula cursor highlights its rendered symbol');
 check(card.querySelector('.md-math-delimiter')&&cell.source===original,'math syntax highlighting preserves source');
 const filled=getComputedStyle(card.querySelector('.math-source-active'));check(filled.backgroundColor!=='rgba(0, 0, 0, 0)'&&filled.boxShadow==='none'&&filled.filter==='none','formula uses filled highlight without halo');
 card.codeEditor.dispatch({selection:{anchor:original.indexOf('z_k')}});await tick();
 check(card.querySelector('.md-math-source')&&!card.querySelector('.markdown-math-edit-preview'),'inline formula edits in one layer with colored source');
 const mode=value=>{card.querySelector('.markdown-edit').click();[...card.querySelectorAll('.markdown-mode-menu button')].find(button=>button.textContent===value).click();};
 mode('源码模式');check(NotebookCodeEditor.getMarkdownMode(card.codeEditor)==='source','source menu');
 mode('阅读视图');check(card.querySelector('.code-editor-host').hidden,'reading menu hides source');
 check(card.querySelector('.markdown-preview mjx-container'),'reading MathJax');check(cell.source===original,'view switches preserve Markdown');
 card.querySelector('.markdown-preview input[type=checkbox]').click();await save();
 check(cell.source===original.replace('- [ ] A','- [x] A'),'reading task edits one source marker');
 const saved=await api('/api/document?path='+encodeURIComponent(state.path));check(saved.document.slides[0].cells[0].source===cell.source,'task saves through revision API');
 card.dispatchEvent(new KeyboardEvent('keydown',{key:'e',ctrlKey:true,bubbles:true,cancelable:true}));check(card.dataset.markdownMode==='live','Ctrl E restores live preview');
 const view=card.codeEditor;view.focus();view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true,cancelable:true}));await tick();
 check(cell.source===original,'reading task remains undoable in native editor');await save();
 setMode('present');card=document.querySelector('.markdown-cell');check(card.dataset.markdownMode==='reading','presentation reading view');
 card.querySelector('input[type=checkbox]').click();check(allCells()[0].source===original,'presentation task cannot mutate');
 setMode('edit');card=document.querySelector('.markdown-cell');check(card.dataset.markdownMode==='live','editing mode restored');
 mode('阅读视图');for(let i=0;i<120&&!card.querySelector('.mermaid-block svg');i++)await tick();check(card.querySelector('.mermaid-block svg'),'offline Mermaid');
 const frame=await prepareNotebookPrint(snapshotNotebookPrint(),{scope:'all'});check(frame.contentDocument.querySelector('.obsidian-markdown mjx-container'),'print uses MathJax reading engine');check(frame.contentDocument.getElementById('obsidian-math-styles'),'print ships MathJax CSS');frame.remove();
 const firstPath=state.path,toggle=document.getElementById('toggle-sidebar');
 check(toggle.closest('#main')&&!toggle.closest('.activity-rail'),'page-directory toggle belongs to note content');
 toggle.click();check(document.body.classList.contains('sidebar-collapsed'),'current note directory collapses');
 const other=await api('/api/notebooks',{title:'Temporary sidebar scope'});await openEditor('notebook',other.path);
 check(!document.body.classList.contains('sidebar-collapsed'),'second note has independent expanded default');
 await openEditor('notebook',firstPath);check(document.body.classList.contains('sidebar-collapsed'),'return restores first note collapsed state');
 document.body.classList.remove('sidebar-collapsed');restoreNotebookSidebar();check(document.body.classList.contains('sidebar-collapsed'),'saved note view restores from browser preferences');
 check(document.getElementById('toggle-sidebar').getAttribute('aria-expanded')==='false','toggle accessibility follows restored state');
 document.getElementById('toggle-sidebar').click();await openEditor('notebook',other.path);check(!document.body.classList.contains('sidebar-collapsed'),'expanding first note leaves second note unchanged');
 await openEditor('notebook',firstPath);
 document.getElementById('test-result').textContent=JSON.stringify({ok:true,checks:results});
})().catch(error=>document.getElementById('test-result').textContent=JSON.stringify({ok:false,error:error.stack}));});`;

test('Obsidian Markdown integrates with real workspace save, undo, presentation and print',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'notes-obsidian-app-'));
 const fixture=path.join(temp,'browser.js');fs.writeFileSync(fixture,scenarios);
 const python=String.raw`
import sys,json,tempfile,threading
from pathlib import Path
from unittest.mock import patch
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(Path(sys.argv[1]).parent))
from slide_notes.application import Application,Environment
from slide_notes.web.server import handler_factory
with tempfile.TemporaryDirectory(prefix='notes-obsidian-server-') as directory,patch.object(Environment,'start',Environment.snapshot):
 app=Application(Path(directory)/'config');info=app.open(str(Path(directory)/'workspace'),create=True);workspace=app.get(info['id'])
 note=workspace.create('Temporary Markdown');doc=note['document'];doc['slides'][0]['cells']=[{'id':'mdone','kind':'markdown','source':'# Obsidian Notes\n\n- [ ] A\n- [ ] B\n\n> [!tip]+ Callout\n> body\n\n$$\nx^2+1\n$$\n\nInline $z_k+z_k$ context.\n\n~~~mermaid\ngraph LR\nA --> B\n~~~','display':'normal','showCode':False}]
 workspace.notebook(note['path'])[1].save(doc,note['revision']);app.remember(info['id'],note['path'],{'tabs':[{'kind':'notebook','path':note['path']}],'active':note['path']})
 Base=handler_factory(application=app)
 class Handler(Base):
  def log_message(self,*args):pass
  def do_GET(self):
   if self.path.startswith('/editor?'):
    content=(Path(sys.argv[1])/'static/index.html').read_text().replace('<body>','<body data-managed-workbench="true"><pre id="test-result" hidden>pending</pre>')
    content=content.replace('</body>','<script>'+Path(sys.argv[2]).read_text()+'</script></body>')
    raw=content.encode();self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
   else:super().do_GET()
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
 print(json.dumps({'url':'http://127.0.0.1:'+str(server.server_port)+'/editor?workspace='+info['id']}),flush=True)
 try:sys.stdin.read()
 finally:server.shutdown();server.server_close();app.stop()
`;
 const proc=spawn(testPaths.PYTHON,['-u','-c',python,root,fixture],{stdio:['pipe','pipe','pipe']});let error='';proc.stderr.on('data',chunk=>error+=chunk);let output='';
 try{
  const info=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server timeout '+error)),20000);proc.on('exit',code=>{clearTimeout(timer);reject(Error('server exit '+code+' '+error));});proc.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]));}catch(e){reject(e);}}});});
  const driver=String.raw`
import sys,json,base64
from pathlib import Path
from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
 browser=playwright.chromium.launch(executable_path=sys.argv[2],headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1300,'height':1100})
 page.goto(sys.argv[1],wait_until='domcontentloaded')
 page.wait_for_function("document.getElementById('test-result')?.textContent!=='pending'",timeout=40000)
 result=json.loads(page.locator('#test-result').text_content())
 if result.get('ok'):
  pointer_errors=[];page.on('pageerror',lambda error:pointer_errors.append(str(error)))
  source='Intro\n\n混合 $x_k+x_k$ 与 $\\frac{a}{b}$ 是公式，文字里也能编辑。\n\n$$x_k+x_k+\\frac{a}{b}$$\n\nAfter'
  page.evaluate("""source=>{
   const host=document.createElement('section');host.id='pointer-fixture';host.className='markdown-cell';host.style.cssText='position:fixed;right:24px;top:60px;width:620px;max-height:85vh;overflow:auto;z-index:9999;background:white';document.body.append(host);
   const changes=[],view=NotebookCodeEditor.create({parent:host,source,language:'markdown',label:'pointer fixture',markdownBlocks:ObsidianMarkdown.blocks,renderMarkdown:(region,documentSource)=>ObsidianMarkdown.render(region,{documentSource}),bindMarkdownPreview:ObsidianMarkdown.bindPreview,onChange:text=>changes.push(text)});
   window.pointerFixture={host,view,source,changes};
  }""",source)
  def formula_point(at):
   page.evaluate("""at=>{const {host}=pointerFixture;host.querySelectorAll('[data-pointer-target]').forEach(node=>node.removeAttribute('data-pointer-target'));
    const candidates=[...host.querySelectorAll('[data-math-from][data-math-to]')].filter(node=>Number(node.closest('[data-markdown-from]').dataset.markdownFrom)+Number(node.dataset.mathFrom)===at).sort((a,b)=>(Number(a.dataset.mathTo)-Number(a.dataset.mathFrom))-(Number(b.dataset.mathTo)-Number(b.dataset.mathFrom)));
    if(!candidates.length)throw Error('rendered source target missing '+at);candidates[0].dataset.pointerTarget='true';
   }""",at)
   return page.locator('#pointer-fixture [data-pointer-target]').bounding_box()
  def target(at):
   page.evaluate('pointerFixture.view.dispatch({selection:{anchor:0}});pointerFixture.view.contentDOM.blur()')
   formula_point(at)
   block=page.locator('#pointer-fixture [data-pointer-target]').evaluate("node=>!!node.closest('.markdown-preview-block')")
   page.locator('#pointer-fixture [data-pointer-target]').click()
   if block:page.wait_for_function("!!pointerFixture.host.querySelector('.markdown-math-edit-preview')",timeout=2000)
   assert page.evaluate('pointerFixture.view.hasFocus'),'formula click lost editor focus'
   page.wait_for_function('at=>pointerFixture.view.state.selection.main.head===at',arg=at,timeout=2000)
   assert page.evaluate('pointerFixture.view.state.selection.main.head')==at,'formula click mapped to wrong source occurrence'
  first=source.index('x_k');second=source.index('x_k',first+1)
  target(second);target(source.index('a}{b'))
  assert page.locator('#pointer-fixture .markdown-math-edit-preview').count()==0
  target(second)
  # Real mouse clicks in the expanded editable TeX must retain native selection/editing.
  at=second+2
  r=page.evaluate('at=>pointerFixture.view.coordsAtPos(at)',at)
  page.mouse.click(r['left']+.25,(r['top']+r['bottom'])/2)
  assert page.evaluate('pointerFixture.view.state.selection.main.head')==at,'expanded TeX stopped responding to mouse selection'
  page.keyboard.type('z')
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==source[:at]+'z'+source[at:],'typing after a TeX click went to the wrong position'
  page.keyboard.press('Control+z')
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==source,'formula click/edit broke native undo'
  result['checks'].append('real mouse: inline formula, numerator and editable TeX preserve focus, typing and undo')
  target(source.rindex('x_k'));target(source.rindex('a}{b'))
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==source
  assert not pointer_errors,pointer_errors
  result['checks'].append('real mouse: display formula opens and remains clickable at exact source positions')
  # A rendered block is revealed by a settled click, never by a press,
  # drag, or double click. This is separate from native inline editing.
  page.evaluate('pointerFixture.view.dispatch({selection:{anchor:0}});pointerFixture.view.contentDOM.blur()')
  a=formula_point(source.rindex('x_k'));b=formula_point(source.rindex('a}{b'))
  page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);page.mouse.down()
  assert page.locator('#pointer-fixture .markdown-math-edit-preview').count()==0,'press prematurely revealed display math'
  page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2,steps=10);page.mouse.up();page.wait_for_timeout(180)
  assert page.locator('#pointer-fixture .markdown-math-edit-preview').count()==1,'completed formula selection did not reveal its editable source'
  # CM's DOM observer may move its hidden cursor to the block boundary; that
  # is not a source reveal and must never rewrite the document.
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==source
  page.evaluate('window.getSelection().removeAllRanges();pointerFixture.view.dispatch({selection:{anchor:0}});pointerFixture.view.contentDOM.blur()')
  a=formula_point(source.rindex('x_k'));page.mouse.dblclick(a['x']+a['width']/2,a['y']+a['height']/2,delay=50);page.wait_for_timeout(180)
  assert page.locator('#pointer-fixture .markdown-math-edit-preview').count()==0,'double click revealed display math'
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==source
  result['checks'].append('real mouse: display math press stays stable, completed drag reveals source, and double click avoids click activation')
  # New paragraph starts unfocused and narrow enough to wrap. Coordinates come
  # from actual DOM characters, never from the editor's own position mapper.
  mixed='Intro\n\n前面文字重复，前面文字重复。$\\frac{x_k+x_k}{1+\\alpha^2}$ '+('连续中文让段落自动换行。'*5)+'后面文字重复，后面文字重复。$y_k$ 结尾文字。\n\nAfter'
  page.evaluate("""source=>{
   const {host,view}=pointerFixture;view.destroy();host.replaceChildren();host.style.width='340px';
   const changes=[],next=NotebookCodeEditor.create({parent:host,source,language:'markdown',label:'wrapped fixture',markdownBlocks:ObsidianMarkdown.blocks,renderMarkdown:(region,documentSource)=>ObsidianMarkdown.render(region,{documentSource}),bindMarkdownPreview:ObsidianMarkdown.bindPreview,onChange:text=>changes.push(text)});
   window.pointerFixture={host,view:next,source,changes};
  }""",mixed)
  def prose_point(phrase,ordinal=0,offset=0):
   return page.evaluate("""({phrase,ordinal,offset})=>{
    const walker=document.createTreeWalker(pointerFixture.view.contentDOM,NodeFilter.SHOW_TEXT);let node,seen=0;
    while(node=walker.nextNode()){
     if(node.parentElement.closest('mjx-container'))continue;
     for(let at=node.textContent.indexOf(phrase);at>=0;at=node.textContent.indexOf(phrase,at+1)){
      if(seen++!==ordinal)continue;
      const range=document.createRange();range.setStart(node,at+offset);range.setEnd(node,at+offset+1);
      const r=range.getBoundingClientRect();return {x:r.left+.25,y:(r.top+r.bottom)/2};
     }
    }throw Error('prose point missing '+phrase);
   }""",{'phrase':phrase,'ordinal':ordinal,'offset':offset})
  point=prose_point('后面文字重复',1,3)
  page.mouse.click(point['x'],point['y'])
  expected=mixed.index('后面文字重复',mixed.index('后面文字重复')+1)+3
  assert page.evaluate('pointerFixture.view.state.selection.main.head')==expected,'unfocused wrapped prose click chose wrong repeated occurrence'
  result['checks'].append('real mouse: first click on wrapped repeated Chinese prose is exact')
  # Collapse both formulas, then drag across them without letting live preview
  # move the target underneath the pointer during the gesture.
  page.evaluate('pointerFixture.view.contentDOM.blur()')
  start=prose_point('前面文字重复',1,2);end=prose_point('后面文字重复',1,4)
  page.mouse.move(start['x'],start['y']);page.mouse.down();page.mouse.move(end['x'],end['y'],steps=20);page.mouse.up()
  expected_from=mixed.index('前面文字重复',mixed.index('前面文字重复')+1)+2
  expected_to=mixed.index('后面文字重复',mixed.index('后面文字重复')+1)+4
  selected=page.evaluate('({from:pointerFixture.view.state.selection.main.from,to:pointerFixture.view.state.selection.main.to})')
  assert selected=={'from':expected_from,'to':expected_to},'drag across wrapped inline math shifted selection: '+str(selected)
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==mixed
  result['checks'].append('real mouse: wrapped prose drag across formulas keeps the intended source selection')
  def collapse():
   page.evaluate('pointerFixture.view.dispatch({selection:{anchor:0}});pointerFixture.view.contentDOM.blur()')
  # Drag can begin on a rendered glyph as well as on ordinary text.
  collapse();math_at=mixed.index('x_k',mixed.index('x_k')+1)
  glyph=formula_point(math_at);end=prose_point('后面文字重复',1,4)
  page.mouse.move(glyph['x']+glyph['width']/2,glyph['y']+glyph['height']/2);page.mouse.down()
  assert page.locator('#pointer-fixture .markdown-inline-math').count()==2,'formula expanded during mousedown'
  page.mouse.move(end['x'],end['y'],steps=20)
  assert page.locator('#pointer-fixture .markdown-inline-math').count()==2,'formula expanded during drag'
  page.mouse.up()
  selected=page.evaluate('({anchor:pointerFixture.view.state.selection.main.anchor,head:pointerFixture.view.state.selection.main.head})')
  assert selected=={'anchor':math_at,'head':expected_to},'drag starting on a glyph lost its source anchor: '+str(selected)
  result['checks'].append('real mouse: dragging from a rendered glyph preserves layout and exact source anchor')
  # The same mapping is used at the end of a reversed drag, not just the start.
  collapse();start=prose_point('后面文字重复',1,4);glyph=formula_point(math_at)
  page.mouse.move(start['x'],start['y']);page.mouse.down();page.mouse.move(glyph['x']+glyph['width']/2,glyph['y']+glyph['height']/2,steps=20);page.mouse.up()
  selected=page.evaluate('({anchor:pointerFixture.view.state.selection.main.anchor,head:pointerFixture.view.state.selection.main.head})')
  formula_from=mixed.rfind('$',0,math_at);formula_to=mixed.index('$',math_at)+1
  assert selected['anchor']==expected_to and selected['head'] in (formula_from,formula_to),'native reverse drag did not select a complete inline formula: '+str(selected)
  result['checks'].append('real mouse: native prose drag selects rendered inline formulas as source units')
  collapse();start=prose_point('前面文字重复',1,2);page.mouse.click(start['x'],start['y'])
  glyph=page.evaluate('at=>pointerFixture.view.coordsAtPos(at)',math_at)
  page.keyboard.down('Shift');page.mouse.click(glyph['left']+.25,(glyph['top']+glyph['bottom'])/2);page.keyboard.up('Shift')
  selected=page.evaluate('({anchor:pointerFixture.view.state.selection.main.anchor,head:pointerFixture.view.state.selection.main.head})')
  assert selected=={'anchor':expected_from,'head':math_at},'Shift click did not extend selection to rendered glyph: '+str(selected)
  result['checks'].append('real mouse: Shift click extends prose selection into native colored TeX')
  # Selection remains an ordinary native source edit, including undo.
  page.keyboard.type('replacement');assert page.evaluate('pointerFixture.view.state.doc.toString()')==mixed[:expected_from]+'replacement'+mixed[math_at:]
  page.keyboard.press('Control+z');assert page.evaluate('pointerFixture.view.state.doc.toString()')==mixed
  assert not pointer_errors,pointer_errors
  result['checks'].append('real mouse: replacing a cross-formula selection remains natively undoable')
  cell5=Path(sys.argv[3]).read_text()
  page.evaluate("""source=>{
   const {host,view}=pointerFixture;view.destroy();host.replaceChildren();host.style.width='740px';
   const changes=[],next=NotebookCodeEditor.create({parent:host,source,language:'markdown',label:'iLQR Cell 05',markdownBlocks:ObsidianMarkdown.blocks,renderMarkdown:(region,documentSource)=>ObsidianMarkdown.render(region,{documentSource}),bindMarkdownPreview:ObsidianMarkdown.bindPreview,onChange:text=>changes.push(text)});
   window.pointerFixture={host,view:next,source,changes};
  }""",cell5)
  # Actual Cell 05: a horizontal drag through the compiled Bellman equation
  # must track the source symbols, even though MathJax uses pseudo glyphs.
  begin=cell5.index('V(x_k)');finish=cell5.index('ell(x_k')+4
  a=formula_point(begin)
  page.evaluate("""()=>{
   const node=pointerFixture.host.querySelector('[data-pointer-target]'),container=node.closest('mjx-container');
   const stats={node,container,classes:new Map(),typesets:0};
   stats.observer=new MutationObserver(records=>{for(const record of records){
    if(record.type==='attributes'&&record.attributeName==='class'&&(record.target===node||node.contains(record.target))&&record.target.dataset.mathFrom===node.dataset.mathFrom&&!record.target.querySelector('[data-math-from]'))stats.classes.set(record.target,(stats.classes.get(record.target)||0)+1);
    if(record.type==='childList'&&container.contains(record.target))stats.typesets++;
   }});stats.observer.observe(pointerFixture.host,{subtree:true,childList:true,attributes:true});pointerFixture.dragStats=stats;
  }""")
  b=formula_point(finish)
  page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);page.mouse.down()
  page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2,steps=24)
  page.wait_for_timeout(80)
  if '--screenshot' in sys.argv:page.locator('#pointer-fixture').screenshot(path='/tmp/slide-notes-ilqr-cell5-selection.png')
  selected=page.evaluate('({from:pointerFixture.view.state.selection.main.from,to:pointerFixture.view.state.selection.main.to})')
  assert selected=={'from':begin,'to':finish},'Cell 05 compiled formula drag did not track symbols: '+str(selected)
  assert page.locator('#pointer-fixture .math-rendered-selection').count()>0,'Cell 05 formula selection is invisible during drag'
  assert page.evaluate('Math.max(0,...pointerFixture.dragStats.classes.values())')==1,'unchanged selected glyph flickered during horizontal drag'
  assert page.evaluate('pointerFixture.dragStats.typesets')==0,'formula was typeset during horizontal selection'
  assert page.evaluate('pointerFixture.dragStats.node.isConnected'),'drag replaced the original formula DOM'
  page.mouse.up()
  page.evaluate("""()=>{pointerFixture.dragStats.observer.disconnect();
   pointerFixture.view.contentDOM.addEventListener('copy',event=>{pointerFixture.copied=event.clipboardData.getData('text/plain')});
  }""")
  page.keyboard.press('Control+c')
  assert page.evaluate('pointerFixture.copied')==cell5[begin:finish],'compiled formula copy lost its original TeX source'
  result['checks'].append('actual iLQR Cell 05: horizontal compiled-formula drag tracks source symbols with visible selection')
  collapse();start=prose_point('是从状态',0,1);end=prose_point('按最优策略行动时的',0,6)
  page.mouse.move(start['x'],start['y']);page.mouse.down();page.mouse.move(end['x'],end['y'],steps=24)
  selected=page.evaluate('({from:pointerFixture.view.state.selection.main.from,to:pointerFixture.view.state.selection.main.to})')
  assert selected=={'from':cell5.index('是从状态')+1,'to':cell5.index('按最优策略行动时的')+6},'Cell 05 prose selection shifted while crossing inline math: '+str(selected)
  page.mouse.up()
  assert page.evaluate('pointerFixture.view.state.doc.toString()')==cell5
  assert page.evaluate('pointerFixture.changes.length')==0
  assert page.locator('#pointer-fixture .markdown-inline-math').count()==0,'active Cell 05 prose still contains noneditable formula islands'
  assert page.locator('#pointer-fixture .md-math-source').count()>=5,'active Cell 05 did not reveal all inline TeX'
  result['checks'].append('actual iLQR Cell 05: prose and all inline TeX form one native selectable paragraph')
  # Verify the visible selection as well as the state. The reported sentence
  # must be ordinary editable DOM text, including every inline formula.
  def source_point(at):
   r=page.evaluate('at=>pointerFixture.view.coordsAtPos(at)',at)
   return {'x':r['left']+.25,'y':(r['top']+r['bottom'])/2}
  def selection_image():
   return page.locator('#pointer-fixture').screenshot()
  def assert_visible_fill(before,after):
   pixels=page.evaluate("""async ({before,after})=>{
    const decode=async raw=>{const image=new Image();image.src='data:image/png;base64,'+raw;await image.decode();
     const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
     const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {width:image.width,height:image.height,data:ctx.getImageData(0,0,image.width,image.height).data};};
    const [a,b]=await Promise.all([decode(before),decode(after)]);let colored=0;
    for(let i=0;i<b.data.length;i+=4){const r=b.data[i],g=b.data[i+1],blue=b.data[i+2];
     if((a.data[i]!==r||a.data[i+1]!==g||a.data[i+2]!==blue)&&r>200&&r<250&&g>180&&g<245&&blue>245&&blue>r+5&&blue>g+5)colored++;}
    return {sameSize:a.width===b.width&&a.height===b.height,colored};
   }""",{'before':base64.b64encode(before).decode(),'after':base64.b64encode(after).decode()})
   assert pixels['sameSize'],'native drag unexpectedly reflowed the paragraph'
   assert pixels['colored']>250,'selection range exists internally but its visible fill is missing: '+str(pixels)
  whole_from=cell5.index('是从状态');whole_to=cell5.index('从而得到局部最优的修正量。')+len('从而得到局部最优的修正量。')
  page.mouse.click(**source_point(whole_from));before=selection_image()
  start=source_point(whole_from);end=source_point(whole_to)
  page.mouse.move(start['x'],start['y']);page.mouse.down();page.mouse.move(end['x'],end['y'],steps=40)
  page.wait_for_timeout(35);after=selection_image()
  assert_visible_fill(before,after)
  assert page.evaluate('String(window.getSelection())')==cell5[whole_from:whole_to],'Cell 05 full paragraph is not a native continuous DOM selection'
  page.mouse.up();page.keyboard.press('Control+c')
  assert page.evaluate('pointerFixture.copied')==cell5[whole_from:whole_to],'Cell 05 full paragraph copy differs from source'
  if '--screenshot' in sys.argv:Path('/tmp/slide-notes-native-paragraph-selection.png').write_bytes(after)
  result['checks'].append('actual iLQR Cell 05: full wrapped paragraph has continuous native DOM selection, visible pixels and exact copy')
  # Click the reported final wrapped words using DOM character rectangles,
  # independently of CodeMirror's position-to-coordinate implementation.
  for width in (740,1190):
   page.evaluate('width=>pointerFixture.host.style.width=width+"px"',width)
   page.wait_for_timeout(550)
   for offset in range(len('局部最优的修正量。')):
    hit=prose_point('局部最优的修正量。',0,offset)
    diagnostic=page.evaluate("""p=>{const v=pointerFixture.view,n=document.caretRangeFromPoint(p.x,p.y);return {mapped:v.posAtCoords(p),native:n&&v.posAtDOM(n.startContainer,n.startOffset),hit:document.elementsFromPoint(p.x,p.y).slice(0,5).map(n=>n.className),before:{anchor:v.state.selection.main.anchor,head:v.state.selection.main.head}}}""",hit)
    page.mouse.click(**hit)
    expected=cell5.index('局部最优的修正量。')+offset
    actual=page.evaluate('({head:pointerFixture.view.state.selection.main.head,empty:pointerFixture.view.state.selection.main.empty,focus:pointerFixture.view.hasFocus})')
    assert actual=={'head':expected,'empty':True,'focus':True},'Cell 05 final-line click missed '+str((width,offset,hit,actual,expected,diagnostic))
    page.keyboard.type('!')
    assert page.evaluate('pointerFixture.view.state.doc.toString()')==cell5[:expected]+'!'+cell5[expected:],'typing did not enter the clicked final-line position'
    page.keyboard.press('Control+z')
    assert page.evaluate('pointerFixture.view.state.doc.toString()')==cell5
    page.wait_for_timeout(550)
  result['checks'].append('actual iLQR Cell 05: every final-line Chinese character accepts a real click, typing and undo at two widths')
  # Exact heading from the user's Obsidian screenshot: select 和 plus the
  # following colored TeX in both directions, with no formula widgets left.
  heading='### 分别展开 $l(x_k,u_k)$ 和 $V\\big(f(x_k,u_k)\\big)$'
  page.evaluate("""source=>{
   const {host,view}=pointerFixture;view.destroy();host.replaceChildren();host.style.width='1000px';
   const changes=[],next=NotebookCodeEditor.create({parent:host,source,language:'markdown',label:'native heading selection',markdownBlocks:ObsidianMarkdown.blocks,renderMarkdown:(region,documentSource)=>ObsidianMarkdown.render(region,{documentSource}),bindMarkdownPreview:ObsidianMarkdown.bindPreview,onChange:text=>changes.push(text)});
   next.contentDOM.addEventListener('copy',event=>{pointerFixture.copied=event.clipboardData.getData('text/plain')});
   window.pointerFixture={host,view:next,source,changes};
  }""",heading)
  hit=prose_point('分别展开',0,1);page.mouse.click(hit['x'],hit['y'])
  assert page.locator('#pointer-fixture mjx-container').count()==0,'focused heading still mixes glyph widgets with source'
  assert page.locator('#pointer-fixture .md-math-source').count()>=2
  heading_from=heading.index('和');heading_to=len(heading)
  page.mouse.click(**source_point(heading_from));before=selection_image()
  start=source_point(heading_from);end=source_point(heading_to)
  page.mouse.move(start['x'],start['y']);page.mouse.down();heads=[]
  for step in range(1,31):
   page.mouse.move(start['x']+(end['x']-start['x'])*step/30,start['y'])
   heads.append(page.evaluate('pointerFixture.view.state.selection.main.head'))
  after=selection_image();assert_visible_fill(before,after)
  assert all(a<=b for a,b in zip(heads,heads[1:])),'heading source selection jumps backwards while dragging right'
  assert page.evaluate('String(window.getSelection())')==heading[heading_from:heading_to]
  if '--screenshot' in sys.argv:Path('/tmp/slide-notes-native-heading-selection.png').write_bytes(after)
  page.mouse.up();page.keyboard.press('Control+c');assert page.evaluate('pointerFixture.copied')==heading[heading_from:heading_to]
  # Clear the previous selection with a click before making a reverse gesture.
  page.mouse.click(**source_point(heading_to));start=source_point(heading_to);end=source_point(heading_from)
  page.mouse.move(start['x'],start['y']);page.mouse.down();page.mouse.move(end['x'],end['y'],steps=30);page.mouse.up()
  assert page.evaluate('String(window.getSelection())')==heading[heading_from:heading_to],'reverse native heading selection differs'
  page.keyboard.type('验证');assert page.evaluate('pointerFixture.view.state.doc.toString()')==heading[:heading_from]+'验证'
  page.keyboard.press('Control+z');assert page.evaluate('pointerFixture.view.state.doc.toString()')==heading
  assert not pointer_errors,pointer_errors
  result['checks'].append('Obsidian reference heading: forward/reverse source selection is visibly filled, monotonic, copyable, editable and undoable')
  if '--screenshot' in sys.argv:page.screenshot(path='/tmp/slide-notes-mixed-formula-click.png')
  page.evaluate('pointerFixture.view.destroy();pointerFixture.host.remove();delete window.pointerFixture')
  # Repeat the reported click in an actual app cell, with its normal shell,
  # saved layout height, resize handles, adjacent cell and save callbacks.
  page.evaluate("""source=>{
   const cell=slide().cells[0];cell.source=source;cell.layout={height:100.99,y:0};
   slide().cells=[cell,{id:'caretneighbor',kind:'markdown',source:'## Next cell',display:'normal',showCode:false}];render();updateCellRows();
   const host=document.getElementById('cell-'+cell.id);host.startEditing();host.scrollIntoView({block:'center'});
   window.pointerFixture={host,view:host.codeEditor,source};
  }""",cell5)
  for width in (1100,1600):
   page.set_viewport_size({'width':width,'height':1100});page.wait_for_timeout(550)
   for offset in (0,1,3,7):
    hit=prose_point('局部最优的修正量。',0,offset)
    assert page.evaluate('p=>pointerFixture.view.contentDOM.contains(document.elementFromPoint(p.x,p.y))',hit),'app cell overlay intercepted the reported character'
    page.mouse.click(**hit);expected=cell5.index('局部最优的修正量。')+offset
    assert page.evaluate('pointerFixture.view.state.selection.main.head')==expected,'real app cell caret missed the clicked final-line character'
    page.keyboard.type('!')
    assert page.evaluate('slide().cells[0].source')==cell5[:expected]+'!'+cell5[expected:],'real app cell typed at the wrong location'
    page.keyboard.press('Control+z');assert page.evaluate('slide().cells[0].source')==cell5
    page.wait_for_timeout(550)
  if '--screenshot' in sys.argv:page.locator('.cell.markdown-cell').first.screenshot(path='/tmp/slide-notes-ilqr-caret-click.png')
  # Slow real gestures after clicking/editing/undoing must retain their press
  # anchor on every move, including reversed motion on the final wrapped row.
  for first,last in ((1,7),(7,1)):
   a=prose_point('局部最优的修正量。',0,first);b=prose_point('局部最优的修正量。',0,last)
   page.mouse.click(**a);page.wait_for_timeout(550)
   page.mouse.move(a['x'],a['y']);page.mouse.down()
   anchor=cell5.index('局部最优的修正量。')+first
   for step in range(1,9):
    page.mouse.move(a['x']+(b['x']-a['x'])*step/8,a['y']+(b['y']-a['y'])*step/8)
    page.wait_for_timeout(80)
    selection=page.evaluate('({anchor:pointerFixture.view.state.selection.main.anchor,head:pointerFixture.view.state.selection.main.head,dom:String(window.getSelection())})')
    assert selection['anchor']==anchor,'slow drag moved the press anchor: '+str(selection)
    if step==8:assert selection['head']==cell5.index('局部最优的修正量。')+last and selection['dom'],'slow drag followed the mouse as a cursor instead of selecting: '+str(selection)
   page.mouse.up()
  result['checks'].append('real workspace cell: slow forward/reverse final-row dragging retains its anchor and native visible selection after editing and undo')
  await_save=page.evaluate('async()=>{await save();return (await api("/api/document?path="+encodeURIComponent(state.path))).document.slides[0].cells[0].source}')
  assert await_save==cell5,'caret checks changed the saved temporary note after undo'
  result['checks'].append('real workspace cell: clicked final-line text accepts exact input and undo at two viewport widths, with layout handles and revision save')
  # Current user screenshot: the shortened Bellman explanation wraps, and a
  # correct DOM range was painted as a narrow vertical strip on both rows.
  explanation=cell5.split('iLQR 不直接求解')[0].rstrip()
  page.set_viewport_size({'width':1500,'height':1100})
  page.evaluate('source=>{const v=pointerFixture.view;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:source}})}',explanation)
  page.mouse.click(**prose_point('出发',0,0));page.wait_for_timeout(550)
  a=prose_point('出发',0,0);b=prose_point('后的最优代价',0,6)
  page.mouse.move(a['x'],a['y']);page.mouse.down();page.mouse.move(b['x'],b['y'],steps=30)
  expected_from=explanation.index('出发');expected_to=explanation.index('后的最优代价')+6
  assert page.evaluate('String(window.getSelection())')==explanation[expected_from:expected_to],'screenshot reproduction has incorrect native selection'
  host=page.locator('.cell.markdown-cell').first;image=host.screenshot()
  if '--screenshot' in sys.argv:Path('/tmp/slide-notes-bellman-wrapped-selection.png').write_bytes(image)
  rectangles=page.evaluate("""()=>{
   const {view,host}=pointerFixture,sel=view.state.selection.main,base=host.getBoundingClientRect(),rectangles=[];
   const walker=document.createTreeWalker(view.contentDOM,NodeFilter.SHOW_TEXT);let node;
   while(node=walker.nextNode()){
    if(node.parentElement.closest('.markdown-preview-block,.markdown-inline-math'))continue;
    const from=view.posAtDOM(node,0);
    for(let i=Math.max(0,sel.from-from);i<Math.min(node.length,sel.to-from);i++){
     if(!/[a-zA-Z\u4e00-\u9fff]/.test(node.textContent[i]))continue;
     const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();
     if(r.width>2&&r.height>5)rectangles.push({x:r.left-base.left,y:r.top-base.top,w:r.width,h:r.height});
    }
   }return rectangles;
  }""")
  coverage=page.evaluate("""async ({image,rectangles})=>{
   const img=new Image();img.src='data:image/png;base64,'+image;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
   const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,img.width,img.height).data,rows={};
   for(const r of rectangles){const row=Math.round(r.y/10)*10;const stats=rows[row]||={total:0,filled:0};stats.total++;let purple=0,total=0;
    for(let y=Math.ceil(r.y+1);y<Math.floor(r.y+r.h-1);y++)for(let x=Math.ceil(r.x+1);x<Math.floor(r.x+r.w-1);x++){
     const i=(y*img.width+x)*4,red=pixels[i],green=pixels[i+1],blue=pixels[i+2];total++;
     if(red>200&&red<250&&green>180&&green<245&&blue>245&&blue>red+5&&blue>green+5)purple++;
    }if(purple>total*.3)stats.filled++;
   }return Object.values(rows).filter(r=>r.total>=5);
  }""",{'image':base64.b64encode(image).decode(),'rectangles':rectangles})
  assert len(coverage)>=2,'screenshot reproduction did not wrap across two visual rows'
  assert all(row['filled']>=row['total']*.9 for row in coverage),'actual range is correct but selected characters lack visible fill on a wrapped row: '+str(coverage)
  page.mouse.up()
  result['checks'].append('current Bellman screenshot: selected letters and Chinese characters are visibly filled across every wrapped row, not only inside a narrow vertical strip')
  assert not pointer_errors,pointer_errors
  page.evaluate('delete window.pointerFixture')
 print(json.dumps(result))
 browser.close()
`;
  const run=spawnSync(testPaths.PYTHON,['-c',driver,info.url,process.env.CHROME_BIN||'/usr/bin/google-chrome',path.join(testPaths.FIXTURES_ROOT,'ilqr-cell5.md'),...(process.env.TEST_SCREENSHOT?['--screenshot']:[])],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024});
  assert.equal(run.status,0,run.stderr);let result;try{result=JSON.parse(run.stdout.trim());}catch{throw Error('incomplete app browser: '+run.stdout+' '+error);}
  assert.equal(result.ok,true,result.error);assert(result.checks.length>=14);console.log('Verified '+result.checks.length+' full workspace Markdown checks.');
 }finally{proc.stdin.end();await new Promise(resolve=>{proc.once('exit',resolve);setTimeout(()=>{proc.kill('SIGTERM');resolve();},3000).unref();});fs.rmSync(temp,{recursive:true,force:true});}
});
