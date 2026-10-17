'use strict';
// PDF frames exchange selected regions or a send-time current-page snapshot.
const aiPDFNavigation=new Map();
const aiPDFContextRequests=new Map();
const aiPDFPageContexts=new WeakMap();
async function collectAIPDFContext(session,sources,images){
 if(session.request)delete session.request.pdfReadTarget;
 if(session.cell||!session.path.toLowerCase().endsWith('.pdf'))return;
 if(session.request?.controller.signal.aborted)return;
 if(sources.some(source=>source.path===session.path&&source.kind!=='pdf-page'))return;
 const request=session.request,path=session.path,active=editorTabs.active;
 const stopped=()=>{if(session.request!==request||session.path!==path||editorTabs.active!==active)request.controller.abort();return request.controller.signal.aborted;};
 const tab=editorTabs.items.find(tab=>tab.kind==='pdf'&&tab.path===path&&tab.path===active),frame=tab?.view&&$('iframe',tab.view),position=tab?.aiPDFPage;
 let readingPage=position?.page;
 const fallback=()=>{
  if(stopped())return;
  // This is a location hint, never a fabricated page snapshot or attachment.
  const target={path};if(Number.isInteger(readingPage)&&readingPage>=1&&readingPage<=100000)target.page=readingPage;
  request.pdfReadTarget=target;
 };
 if(!frame?.dataset.aiReady)return fallback();
 const cached=aiPDFPageContexts.get(frame);
 const key=position?.fingerprint?JSON.stringify([position.page,position.fingerprint,position.rotation||0]):null;
 if(key&&cached?.get(key)?.path===session.path)return cached.get(key);
 try{
 const includeImage=true,id=crypto.randomUUID();
 const raw=await new Promise((resolve,reject)=>{
  const signal=request.controller.signal;
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  const timer=setTimeout(()=>{aiPDFContextRequests.delete(id);cleanup();reject(Error('读取当前 PDF 页超时'));},2000);
  const abort=()=>{cleanup();aiPDFContextRequests.delete(id);reject(Error('已取消读取 PDF 页面'));};
  signal.addEventListener('abort',abort,{once:true});
  aiPDFContextRequests.set(id,{frame,resolve,reject,timer,cleanup});
  try{frame.contentWindow.postMessage({type:'slide-notes:pdf-context-request',id,includeImage},location.origin);}
  catch(error){cleanup();aiPDFContextRequests.delete(id);reject(error);}
 });
 if(stopped())return;
 if(Number.isInteger(raw?.page)&&Number.isInteger(raw?.pageCount)&&raw.page>=1&&raw.page<=raw.pageCount&&raw.pageCount<=100000)readingPage=raw.page;
 if(!raw||!Number.isInteger(raw.page)||raw.page<1||!Number.isInteger(raw.pageCount)||raw.page>raw.pageCount||raw.pageCount>100000||typeof raw.text!=='string'||raw.text.length>16000||typeof raw.fingerprint!=='string'||raw.fingerprint.length>100||!Array.isArray(raw.rects)||raw.rects.length!==1||!Array.isArray(raw.rects[0])||raw.rects[0].length!==4||raw.rects[0].some(n=>!Number.isFinite(n)))throw Error('PDF 页面快照无效，请重新打开 PDF');
 if(raw.sourceRevision!==undefined&&!(typeof raw.sourceRevision==='string'&&/^[0-9a-f]{64}$/.test(raw.sourceRevision)))throw Error('PDF 来源版本无效');
 const source={...(raw.sourceRevision?{sourceRevision:raw.sourceRevision}:{}),path:tab.path,page:raw.page,pageCount:raw.pageCount,rects:raw.rects,text:raw.text,fingerprint:raw.fingerprint,kind:'pdf-page',truncated:raw.truncated===true};
 if(raw.data){if(!includeImage||typeof raw.data!=='string'||raw.data.length>4000100)throw Error('PDF 页面截图无效');source.image=await api('/api/ai/images',{data:raw.data,name:tab.title+' · 第 '+raw.page+' 页'});}
 if(!source.text.trim()&&!source.image)throw Error('当前 PDF 页没有可用内容，请框选需要解释的区域');
 const reference=await api('/api/ai/pdf-context',{source});
 if(stopped())return;
 const cache=aiPDFPageContexts.get(frame)||new Map();
 cache.set(JSON.stringify([raw.page,raw.fingerprint,raw.rotation||0]),reference);
 if(cache.size>32)cache.delete(cache.keys().next().value);
 aiPDFPageContexts.set(frame,cache);return reference;
 }catch(error){if(stopped())return;return fallback();}
}
function renderAIOrigin(session,panel){
 const box=$('.ai-chat-origin',panel);if(!box)return;box.replaceChildren();
 box.hidden=!!session.workspace;if(session.workspace)return;
 const label=document.createElement('button');label.className='ai-origin-link';label.type='button';label.onclick=()=>openAIOrigin(session).catch(error=>toast(error.message));label.textContent=(session.path.toLowerCase().endsWith('.pdf')?'PDF · ':session.path.toLowerCase().endsWith('.json')?'笔记 · ':'图片 · ')+session.path.split('/').at(-1)+(session.cell?' · Cell '+session.cell.slice(0,8):'');label.title=session.path;box.append(label);
 if(!session.cell&&currentAIDocumentPath()&&currentAIDocumentPath()!==session.path){
  const change=aiButton('切到当前文档',()=>{aiState.sidebarKey=null;renderAI(panel.parentElement);});box.append(change);
 }
}
async function openAIOrigin(session){
 await openEditor(session.path.toLowerCase().endsWith('.pdf')?'pdf':session.path.toLowerCase().endsWith('.json')?'notebook':'image',session.path);
 if(session.cell){const card=document.getElementById('cell-'+session.cell);if(card)card.scrollIntoView({behavior:'smooth',block:'center'});else{const index=state.doc.slides.findIndex(slide=>slide.cells.some(cell=>cell.id===session.cell));if(index>=0){state.active=index;render();document.getElementById('cell-'+session.cell)?.scrollIntoView({behavior:'smooth',block:'center'});}else toast('原 cell 已不存在，对话历史仍然保留');}}
}
function renderAISources(sources,box,remove){
 if(!box)return;box.replaceChildren();
 for(const source of sources||[]){
  const card=document.createElement('div');card.className='ai-source-card';
  const linkedNote=source.kind==='selection-ref'&&['note-cells','cell-text'].includes(source.targetKind),notebook=source.kind==='notebook-region',picture=source.kind==='image-region';
  const link=aiButton(source.path.split('/').at(-1)+(linkedNote?' · '+(source.targetKind==='cell-text'?'文字选区':source.cells.length+' 个 cell'):picture?' · 图片选区':notebook?' · '+(source.cell?'Cell '+source.cell.slice(0,8):'第 '+source.page+' 页'):' · 第 '+source.page+' 页'+(source.kind==='pdf-page'?' · 整页':source.kind==='pdf-elements'||source.kind==='selection-ref'?' · 原文':'')),()=>(linkedNote?openAINoteSelectionSource(source):picture?openAIImageSource(source):notebook?openAINotebookSource(source):openAIPDFSource(source)).catch(error=>toast('无法返回来源：'+error.message)),'file-text');link.className='ai-source-link';link.title='回到来源位置';card.append(link);
  if(source.image){const images=document.createElement('div');images.className='ai-source-preview';renderAIImages([source.image],images);card.append(images);}
  if(source.text){const excerpt=document.createElement('p');excerpt.textContent=source.text;excerpt.title=source.text;card.append(excerpt);if(source.kind==='selection-ref'){const detail=document.createElement('small');detail.className='ai-source-reference';detail.textContent=(source.truncated?'预览 · '+source.characters+' 字 · Agent 可按需展开':'完整选区 · '+source.characters+' 字')+(source.stale?' · 来源已变化':'');card.append(detail);}}
  if(remove){const button=aiButton('',()=>remove(source),'x');button.className='ai-source-remove';button.title='移除选区';button.setAttribute('aria-label',button.title);card.append(button);}
  box.append(card);
 }
}
function aiPDFTargets(){
 const targets=new Map();
 if(state.panel==='ai'&&aiState.sidebarKey){const session=aiState.sessions.get(aiState.sidebarKey);if(session)targets.set(session.key,session);}
 for(const host of document.querySelectorAll('[data-ai-window]'))if(!host.hidden){const session=aiState.sessions.get(host.dataset.aiSession);if(session)targets.set(session.key,session);}
 return [...targets.values()].map(session=>({key:session.key,label:(session.cell?'Cell · ':'全局 · ')+session.title+' — '+session.path.split('/').at(-1),busy:session.busy}));
}
function postAIPDFTargets(frame){
 const targets=aiPDFTargets(),bounds=frame.getBoundingClientRect(),obstacles=[...document.querySelectorAll('[data-ai-window]')].filter(host=>!host.hidden).map(host=>{const r=host.getBoundingClientRect();return {left:r.left-bounds.left,top:r.top-bounds.top,right:r.right-bounds.left,bottom:r.bottom-bounds.top};});frame.contentWindow.postMessage({type:'slide-notes:pdf-targets',targets,obstacles,preferred:targets.some(item=>item.key===aiState.targetKey)?aiState.targetKey:targets[0]?.key||'__pdf__'},location.origin);
}
function broadcastAIPDFTargets(){
 if(typeof editorTabs!=='object')return;
 for(const tab of editorTabs.items)if(tab.kind==='pdf'&&tab.view){const frame=$('iframe',tab.view);if(frame?.dataset.aiReady)postAIPDFTargets(frame);}
}
async function openAIPDFSource(source){
 aiPDFNavigation.set(source.path,source);await openEditor('pdf',source.path);
 const tab=editorTabs.items.find(tab=>tab.kind==='pdf'&&tab.path===source.path),frame=tab?.view&&$('iframe',tab.view);
 if(frame?.dataset.aiReady){frame.contentWindow.postMessage({type:'slide-notes:pdf-locate',source},location.origin);aiPDFNavigation.delete(source.path);}
}
async function attachAIPDFSelection(tab,data){
 let session=data.targetKey!=='__pdf__'&&aiState.sessions.get(data.targetKey);
 if(data.targetKey!=='__pdf__'&&!aiPDFTargets().some(target=>target.key===data.targetKey))throw Error('目标对话已关闭，请重新选择');
 if(!session){const scope=loadAIScope(tab.path);if(!scope.ready)await hydrateAIScope(scope);session=scope.conversations.find(chat=>chat.id===scope.active);aiState.sidebarKey=session.key;state.panel='ai';renderInspector();}
 const scope=aiState.scopes.get(session.scopeKey);if(!scope.ready){await hydrateAIScope(scope);session=aiState.sessions.get(session.key);}
 if(!session||session.busy)throw Error('目标对话正在回复，请稍后添加');
 const batch=data.sources??[data.source];
 if(!Array.isArray(batch)||!batch.length||batch.length>20||session.sources.length+batch.length+(session.imageUploads||0)>20)throw Error('每条消息最多附加 20 个 PDF 选区');
 const selected=batch.map(raw=>{
 if(!raw||!Number.isInteger(raw.page)||raw.page<1||!Array.isArray(raw.rects)||!raw.rects.length||raw.rects.length>200||raw.rects.some(rect=>!Array.isArray(rect)||rect.length!==4||rect.some(n=>!Number.isFinite(n))))throw Error('选区坐标无效，请重新选择');
 if(typeof raw.text!=='string'||raw.text.length>16000||typeof raw.fingerprint!=='string'||raw.fingerprint.length>100)throw Error('选区内容过长，请缩小选区');
 if(raw.data||raw.image)throw Error('框选只接收原文引用；图片请直接粘贴');
 if(!raw.text.trim())throw Error('选区没有可选文字');
 if(tab.aiPDFPage?.pageCount&&raw.page>tab.aiPDFPage.pageCount||tab.aiPDFPage?.fingerprint&&raw.fingerprint!==tab.aiPDFPage.fingerprint)throw Error('PDF 已变化，请重新选择');
 if(raw.sourceRevision!==undefined&&!(typeof raw.sourceRevision==='string'&&/^[0-9a-f]{64}$/.test(raw.sourceRevision)))throw Error('PDF 来源版本无效');
 const source={...(raw.sourceRevision?{sourceRevision:raw.sourceRevision}:{}),path:tab.path,page:raw.page,rects:raw.rects,text:raw.text,fingerprint:raw.fingerprint,kind:'text'};
 if(raw.kind==='pdf-elements'){
  if(!Array.isArray(raw.elements)||!raw.elements.length||raw.elements.length>200||raw.elements.length!==raw.rects.length||raw.elements.some(e=>!e||!Number.isInteger(e.index)||e.index<0||e.index>1000000||!Number.isInteger(e.from)||!Number.isInteger(e.to)||e.from<0||e.from>=e.to||e.to>400000))throw Error('文字来源位置无效，请重新选择');
  source.kind='pdf-elements';source.elements=raw.elements.map(({index,from,to})=>({index,from,to}));
 }
 return source;
 });
 session.selectionUploads=(session.selectionUploads||0)+1;refreshAI(session);
 try{
  const references=typeof registerAISelectionEntries==='function'?await registerAISelectionEntries(selected):selected;
  if(session.busy||!aiPDFTargets().some(target=>target.key===session.key))throw Error('目标对话已关闭或正在回复，请重新选择');
  if(session.sources.length+references.length+(session.imageUploads||0)>20)throw Error('每条消息最多附加 20 个 PDF 选区');
  session.sources.push(...references);aiState.targetKey=session.key;persistAI(session);refreshAI(session);return session.title;
 }finally{session.selectionUploads--;refreshAI(session);}
}
window.addEventListener('message',event=>{
 if(event.origin!==location.origin||typeof editorTabs!=='object')return;
 const tab=editorTabs.items.find(tab=>tab.kind==='pdf'&&tab.view&&$('iframe',tab.view)?.contentWindow===event.source);if(!tab)return;
 const data=event.data;if(!data||typeof data!=='object')return;const frame=$('iframe',tab.view);
 if(data.type==='slide-notes:pdf-context-result'){
  const request=aiPDFContextRequests.get(data.id);if(!request||request.frame!==frame)return;
  aiPDFContextRequests.delete(data.id);clearTimeout(request.timer);request.cleanup();
  if(data.error)request.reject(Error(data.error));else request.resolve(data.source);return;
 }
 if(data.type==='slide-notes:pdf-select-state'){
  tab.aiPDFSelecting=data.active&&typeof data.targetKey==='string'?data.targetKey:null;
  for(const session of aiState.sessions.values())refreshAI(session);return;
 }
 if(data.type==='slide-notes:pdf-view-state'&&Number.isInteger(data.page)&&Number.isInteger(data.pageCount)&&data.page>0&&data.page<=data.pageCount){tab.aiPDFPage={page:data.page,pageCount:data.pageCount,fingerprint:typeof data.fingerprint==='string'?data.fingerprint:'',rotation:Number.isFinite(data.rotation)?data.rotation:0};for(const session of aiState.sessions.values())if(session.path===tab.path&&!session.cell)refreshAI(session);return;}
 if(data.type==='slide-notes:pdf-ready'||data.type==='slide-notes:pdf-targets-request'){
  frame.dataset.aiReady='true';postAIPDFTargets(frame);
  const source=aiPDFNavigation.get(tab.path);if(source){frame.contentWindow.postMessage({type:'slide-notes:pdf-locate',source},location.origin);aiPDFNavigation.delete(tab.path);}return;
 }
 if(data.type==='slide-notes:pdf-add'&&typeof data.id==='string')attachAIPDFSelection(tab,data).then(title=>{
  event.source.postMessage({type:'slide-notes:pdf-added',id:data.id,title},location.origin);broadcastAIPDFTargets();
 }).catch(error=>event.source.postMessage({type:'slide-notes:pdf-added',id:data.id,error:error.message},location.origin));
});
document.addEventListener('focusin',event=>{const host=event.target.closest('[data-ai-session]');if(host){aiState.targetKey=host.dataset.aiSession;broadcastAIPDFTargets();}});
