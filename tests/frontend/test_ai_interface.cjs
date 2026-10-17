const testPaths = require('./paths.cjs');
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{test}=require('node:test');
const root=testPaths.APP_ROOT;
test('Claude-inspired Note interface in real Chrome',()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'slide-notes-ai-interface-'));
 try{
  const read=name=>fs.readFileSync(root+'/static/'+name,'utf8');
  const fixture=`
  const $=(q,root=document)=>root.querySelector(q),escapeHTML=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'),managedWorkbench=false;
  const state={mode:'edit',panel:'ai',path:'notebooks/control.json',revision:'r1',doc:{title:'控制与优化',slides:[{id:'page1',cells:[{id:'one',kind:'code',source:'x = 1'},{id:'two',kind:'markdown',source:'公式说明'}]}]}};
  const editorTabs={active:state.path,items:[]},allCells=()=>state.doc.slides.flatMap(p=>p.cells),cellNumber=id=>id==='one'?1:2;
  const save=async()=>{},toast=message=>errors.push(message),resizePlots=()=>{},renderInspector=()=>{},markdown=text=>'<p>'+escapeHTML(text)+'</p>',DOMPurify={sanitize:text=>text};
  const sent=[],errors=[];const api=async(route,body)=>{if(route.includes('context'))return {path:state.path,characters:5,context:{title:'控制与优化'}};return {data:null,revision:'r1'};};
  `;
  const capture=read('ai-capture.js');
  const scenarios=`
  (async()=>{
   const results=[];function assert(value,message){if(!value)throw Error(message||'assertion failed');}
   async function check(name,fn){try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack});}}
   aiState.config={provider:'claude-code',claudeModel:'',model:''};loadAIConfig=async()=>aiState.config;queueAIScopeSave=()=>{};
   aiStream=async(route,body,request,callback)=>{sent.push(body);callback({type:'done',text:'收到，保持笔记格式。'});};
   const scope=loadAIScope(state.path);scope.ready=true;let session=currentAISession(),host=$('#host');renderAI(host);
   const panel=()=>$('.ai-panel',host),input=()=>$('.ai-input',host);
   await check('light paper surface and compact screenshot geometry',()=>{
    assert(getComputedStyle(panel()).backgroundColor==='rgb(250, 249, 246)');assert($('.ai-welcome-brand',host).textContent==='Claude · Notes');
    assert($('.ai-note-mascot svg',host));assert($('.ai-composer',host).getBoundingClientRect().width<=400);
    assert([...$('.ai-header-actions',host).children].map(b=>b.getAttribute('aria-label')).join('|')==='收藏对话|对话历史|新对话|AI 设置|关闭对话');
   });
   await check('welcome suggestion fills draft without a model call',()=>{
    $('.ai-welcome-suggestions button',host).click();assert(sent.length===0);assert(session.draft==='解释当前内容');assert(document.activeElement===input());assert(!$('.ai-send',host).disabled);
   });
   await check('dismissible mode guide stays dismissed on refresh',()=>{
    $('[aria-label="隐藏模式说明"]',host).click();refreshAI(session);assert(!$('.ai-mode-card',host));
   });
   await check('slash action opens real notebook commands without sending',()=>{
    input().value='';session.draft='';refreshAI(session);$('.ai-slash-button',host).click();assert(!$('.ai-command-menu',host).hidden);assert(input().value==='/');assert(sent.length===0);
    input().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert($('.ai-command-menu',host).hidden);
   });
   await check('mode menu migrates legacy ask to note collaboration and closes with Escape',()=>{
    session.responseMode='ask';refreshAI(session);assert(aiInterfaceMode(session).value==='edit');$('.ai-response-mode',host).click();assert($('.ai-mode-menu',host).getAttribute('role')==='menu');
    [...$('.ai-mode-menu',host).querySelectorAll('button')].find(b=>b.textContent.includes('笔记协作')).click();assert(session.responseMode==='edit');assert(panel().dataset.responseMode==='edit');assert(!$('.ai-mode-menu',host));
    $('.ai-response-mode',host).click();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert(!$('.ai-mode-menu',host));
   });
   await check('per-conversation model and effort are functional',()=>{
    $('.ai-model-chip',host).click();[...$('.ai-model-menu',host).querySelectorAll('button')].find(b=>b.textContent==='Sonnet').click();assert(session.modelOverride==='sonnet');
    $('.ai-model-chip',host).click();const select=$('[aria-label="Claude 思考强度"]',host);select.value='medium';select.dispatchEvent(new Event('change'));assert(session.claudeEffort==='medium');closeAIInterfaceMenus(panel());
    assert($('.ai-model-chip',host).textContent==='sonnet · Medium');
   });
   await check('sending uses chosen model, effort and notes-only software boundary',async()=>{
    fillAISuggestion(session,panel(),'解释当前推导');await sendAI(session,session.draft,'chat');
    assert(sent.at(-1).permission==='notes-only'&&sent.at(-1).model==='sonnet'&&sent.at(-1).claudeEffort==='medium');
    assert($('.ai-message.assistant',host).textContent.includes('保持笔记格式'));assert(session.messages.at(-1).status==='complete');
   });
   await check('suggestion mode maps to the review workflow',async()=>{
    changeAIResponseMode(session,panel(),'suggest');fillAISuggestion(session,panel(),'完善这个 cell');submitAIInput(session,session.draft);await new Promise(r=>setTimeout(r,0));assert(sent.at(-1).mode==='suggest');
   });
   await check('bookmark and conversation settings survive snapshots',()=>{
    $('.ai-bookmark',host).click();assert(session.bookmarked);assert($('.ai-bookmark',host).getAttribute('aria-pressed')==='true');
    const saved=aiScopeSnapshot(scope).conversations.find(c=>c.id===session.id);const restored=makeAISession(scope,saved);assert(restored.bookmarked&&restored.modelOverride==='sonnet'&&restored.responseMode==='suggest'&&restored.claudeEffort==='medium');aiState.sessions.set(session.key,session);
   });
   await check('plus selects notebook cells; chips remove only that context',()=>{
    $('.ai-add-cells',host).click();assert(!$('.ai-attachment-menu',host));assert(aiState.picking===session.key);
    $('#cell-one').click();assert(session.selectedCells.includes('one'));assert($('.ai-cell-chip',host));$('.ai-cell-chip',host).click();assert(!session.selectedCells.length);aiState.picking=null;syncAISelection();
   });
   await check('PDF/source chips stay attached to their notebook conversation',()=>{
    session.sources=[{path:'reference.pdf',page:2,text:'明确选中的公式',kind:'text',rects:[[0,0,1,1]],fingerprint:'test'}];refreshAI(session);assert($('.ai-source-card',host).textContent.includes('reference.pdf'));
    $('.ai-source-remove',host).click();assert(session.sources.length===0&&session.path===state.path);
   });
   await check('Ctrl Escape toggles composer focus and Alt M cycles modes',()=>{
    aiState.targetKey=session.key;input().focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',ctrlKey:true,bubbles:true,cancelable:true}));assert(document.activeElement!==input());
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',ctrlKey:true,bubbles:true,cancelable:true}));assert(document.activeElement===input());const previous=session.responseMode;
    input().dispatchEvent(new KeyboardEvent('keydown',{key:'m',altKey:true,bubbles:true,cancelable:true}));assert(session.responseMode!==previous);
   });
   await check('empty or busy composer blocks send and mode changes',()=>{
    session.draft='';input().value='';refreshAI(session);assert($('.ai-send',host).disabled);
    session.busy=true;refreshAI(session);assert($('.ai-response-mode',host).disabled&&$('.ai-model-chip',host).disabled&&!$('.ai-stop',host).hidden);session.busy=false;refreshAI(session);
   });
   await check('PDF conversation exposes only read-only mode',()=>{
    state.path=null;editorTabs.active='reference.pdf';editorTabs.items=[{path:'reference.pdf',kind:'pdf'}];const pdfScope=loadAIScope('reference.pdf');pdfScope.ready=true;const pdf=currentAISession();renderAI(host);assert(pdf===session);assert($('.ai-context-chip',host).textContent==='reference.pdf');
    assert(aiInterfaceMode(pdf).value==='ask');$('.ai-response-mode',host).click();const buttons=[...$('.ai-mode-menu',host).querySelectorAll('button')];assert(buttons.filter(b=>!b.disabled).length===1);closeAIInterfaceMenus(panel());
    state.path='notebooks/control.json';editorTabs.active=state.path;renderAI(host);
   });
   await check('workspace conversation and file mention follow the main view',async()=>{
    const id=session.id,count=session.messages.length;fillAISuggestion(session,panel(),'跨文件草稿');
    state.path='notebooks/summary.json';editorTabs.active=state.path;renderAI(host);
    assert(currentAISession().id===id&&session.messages.length===count&&input().value==='跨文件草稿');assert($('.ai-context-chip',host).textContent==='summary.json');assert($('.ai-chat-origin',host).hidden);
    session.selectedCells=['one'];refreshAI(session);assert($('.ai-context-chip',host).textContent==='summary.json');
    await sendAI(session,'解释新文件','chat');assert(sent.at(-1).path==='notebooks/summary.json');assert(session.messages.at(-2).path==='notebooks/summary.json');
    state.path='notebooks/control.json';editorTabs.active=state.path;renderAI(host);assert(currentAISession().id===id&&$('.ai-context-chip',host).textContent==='control.json');
   });
   await check('narrow layout keeps composer buttons within bounds',()=>{
    host.style.width='300px';const r=$('.ai-composer',host).getBoundingClientRect();assert($('.ai-send',host).getBoundingClientRect().right<=r.right+1);assert($('.ai-response-mode',host).getBoundingClientRect().left>=r.left);host.style.width='400px';
   });
   await check('history puts bookmarks first and preserves blank-chat action',()=>{
    const other=makeAISession(scope,{title:'Other',updatedAt:Date.now()+1000});scope.conversations.push(other);session.bookmarked=true;renderAIHistory(session,host,$('.ai-history-menu',host));
    assert($('.ai-history-item',host).textContent.includes(session.title));assert($('.ai-history-blank',host));
   });
   // Leave a representative initial state for the exported screenshot.
   session.messages=[];session.draft='';session.responseMode='edit';session.modelOverride='';session.claudeEffort='';session.sources=[];session.selectedCells=[];
   localStorage.removeItem('slide-notes-ai-mode-tip:'+aiWorkspace());renderAI(host);refreshAI(session);input().focus();
   $('#result').textContent=JSON.stringify(results);
  })().catch(error=>$('#result').textContent=JSON.stringify([{name:'setup',ok:false,error:error.stack}]));`;
  const css=read('style.css')+read('ai.css')+read('ai-interface.css');
  const sprite=read('icons.svg').replace('<svg','<svg style="display:none"');
  const html='<!doctype html><meta charset="utf-8"><style>'+css+'body{margin:0;height:660px;display:block;--ui-font:Arial,sans-serif;background:#fff}#host{height:650px;width:400px;overflow:hidden;margin:0}.ai-panel{height:100%}#cells{position:absolute;left:450px;top:0}#result{display:none}</style>'+sprite+'<div id="host"></div><div id="cells"><div class="cell" id="cell-one" data-cell="one" tabindex="0">x = 1</div><div class="cell" id="cell-two" data-cell="two" tabindex="0">公式说明</div></div><pre id="result"></pre><script>'+read('icons.js').replace('/icons.svg#','#')+'</script><script>'+fixture+'</script>'+['ai-interface.js','ai.js','ai-agent.js','ai-pdf.js','ai-branches.js'].map(name=>'<script>'+read(name)+'</script>').join('')+'<script>'+capture.slice(0,capture.indexOf('function captureFingerprint('))+'function cancelAINotebookCapture(){}function removeAICaptureMark(){}</script><script>'+scenarios+'</script>';
  const page=path.join(temp,'interface.html');fs.writeFileSync(page,html);
  const args=['--headless','--no-sandbox','--disable-gpu','--no-first-run','--user-data-dir='+path.join(temp,'profile'),'--allow-file-access-from-files','--window-size=720,720','--virtual-time-budget=3000','--dump-dom'];
  if(process.env.AI_SCREENSHOT)args.push('--screenshot='+process.env.AI_SCREENSHOT);
  const result=spawnSync(process.env.CHROME_BIN||'google-chrome',[...args,'file://'+page],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.equal(result.status,0,result.stderr);
  const match=result.stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/);assert.ok(match,'browser result missing');
  const rows=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  assert.deepEqual(rows.filter(row=>!row.ok),[]);assert.equal(rows.length,17);console.log('Verified 17 Note interface browser scenarios.');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
