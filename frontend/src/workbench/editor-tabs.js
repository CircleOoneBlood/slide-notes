'use strict';
// A single switch queue keeps saves and late runtime responses attached to their document.
const editorTabs={items:[],active:null,queue:Promise.resolve(),restoring:false,switching:false};
function editorSession(){return {tabs:editorTabs.items.map(({kind,path})=>({kind,path})),active:editorTabs.active};}
function editorTask(action){
 const pending=editorTabs.queue.then(async()=>{
  editorTabs.switching=true;$('#notebook-editor').inert=true;
  try{return await action();}
  finally{editorTabs.switching=false;$('#notebook-editor').inert=false;}
 });
 editorTabs.queue=pending.catch(()=>{});return pending;
}
function cacheNotebookSession(){
 if(!state.doc||!state.path)return;
 notebookSessions.set(state.path,{active:state.active,fragment:state.fragment,cameras:state.cameras,outputs:state.outputs,runtime:state.runtime,markdownEditing:state.markdownEditing,selectedCell:state.selectedCell,source:JSON.stringify(state.doc),scrollTop:$('#main').scrollTop,mode:state.mode});
}
function updateEditorTitle(path,title){const tab=editorTabs.items.find(t=>t.path===path);if(tab&&tab.title!==title){tab.title=title;renderEditorTabs();}}
function renderEditorTabs(){
 const list=$('#editor-tabs');list.hidden=!editorTabs.items.length;
 const focused=document.activeElement;
 const focusPath=focused.closest('.editor-tab')?.dataset.path;
 const focusClose=focused.classList.contains('editor-tab-close');
 for(const tab of editorTabs.items){
  if(!tab.element){
   const item=document.createElement('div');item.className='editor-tab';
   const button=document.createElement('button');button.className='editor-tab-select';button.setAttribute('role','tab');
   button.innerHTML=uiIcon(tab.kind==='pdf'?'file-text':tab.kind==='image'?'image':'notebook-text');button.append(document.createElement('span'));
   button.onclick=()=>openEditor(tab.kind,tab.path).catch(error=>toast(error.message));
   button.onkeydown=e=>{const i=editorTabs.items.indexOf(tab);let next;if(e.key==='ArrowRight')next=(i+1)%editorTabs.items.length;if(e.key==='ArrowLeft')next=(i+editorTabs.items.length-1)%editorTabs.items.length;if(e.key==='Home')next=0;if(e.key==='End')next=editorTabs.items.length-1;if(next!==undefined){e.preventDefault();const target=editorTabs.items[next];openEditor(target.kind,target.path).then(()=>$('#editor-tabs [aria-selected=true]')?.focus()).catch(error=>toast(error.message));}if(e.key==='Delete'){e.preventDefault();closeEditor(tab.path).catch(error=>toast(error.message));}};
   const close=document.createElement('button');close.className='editor-tab-close';close.title='关闭标签页';close.innerHTML=uiIcon('x');close.onclick=()=>closeEditor(tab.path).catch(error=>toast(error.message));
   item.onauxclick=e=>{if(e.button===1){e.preventDefault();closeEditor(tab.path).catch(error=>toast(error.message));}};item.append(button,close);tab.element=item;
  }
  const item=tab.element,active=tab.path===editorTabs.active,button=$('.editor-tab-select',item);
  item.dataset.path=tab.path;item.classList.toggle('active',active);
  button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;button.title=tab.path;
  $('span',button).textContent=tab.title;$('.editor-tab-close',item).setAttribute('aria-label','关闭 '+tab.title);
 }
 let add=$('.editor-tab-new',list);
 if(!add){add=document.createElement('button');add.className='editor-tab-new';add.title='新建笔记';add.setAttribute('aria-label','新建笔记标签页');add.innerHTML=uiIcon('plus');add.onclick=()=>newNoteIn('');list.append(add);}
 const elements=new Set(editorTabs.items.map(tab=>tab.element));
 for(const item of list.querySelectorAll('.editor-tab'))if(!elements.has(item))item.remove();
 // Retain tab nodes, pointer hover and focus across switches; only reconcile ordering.
 editorTabs.items.forEach((tab,index)=>{if(list.children[index]!==tab.element)list.insertBefore(tab.element,list.children[index]||add);});
 if(focusPath&&!focused.isConnected){const target=editorTabs.items.find(tab=>tab.path===focusPath)||editorTabs.items.find(tab=>tab.path===editorTabs.active);if(target)$(focusClose?'.editor-tab-close':'.editor-tab-select',target.element).focus({preventScroll:true});}
 const active=$('.editor-tab.active',list);
 if(active){const r=active.getBoundingClientRect(),bounds=list.getBoundingClientRect();if(r.left<bounds.left||r.right>bounds.right)active.scrollIntoView({block:'nearest',inline:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
}
function revealEditor(kind){
 // Switching is one surface commit, without repeatedly dimming the document.
 if(kind==='notebook')document.querySelectorAll('.code-cell').forEach(card=>card.codeEditor?.requestMeasure());
}
function pdfURL(path,download=false){const query=new URLSearchParams({path});const workspace=new URL(location.href).searchParams.get('workspace');if(workspace)query.set('workspace',workspace);if(download)query.set('download','1');return '/api/pdf?'+query;}
function pdfView(tab){
 if(tab.view)return tab.view;
 const view=document.createElement('div');view.className='pdf-view';
 const frame=document.createElement('iframe');frame.title=tab.title+' · PDF';frame.src='/pdf-reader.html?'+new URLSearchParams({file:pdfURL(tab.path),name:tab.title});view.append(frame);$('#pdf-editors').append(view);tab.view=view;return view;
}
function clearNotebookEditor(){
 cacheNotebookSession();++runSerial;clearTimeout(saveTimer);destroyCodeEditors();state.controls.clear();
 Object.assign(state,{doc:null,path:null,revision:null,runtime:null,busy:false,epoch:0,savedEpoch:0,mode:'edit',selectedCell:null});
 syncAISelection();syncAICellWindows();
 $('#cells').replaceChildren();$('#slide-list').replaceChildren();$('#interrupt').hidden=true;document.body.classList.remove('present');
 if(['graph','variables','outline'].includes(state.panel)){state.panel=null;renderInspector();}
 syncWorkbenchAvailability(false);
}
function showEditorSurface(kind){
 for(const tab of editorTabs.items)if(tab.aiPDFSelecting&&tab.path!==editorTabs.active){$('iframe',tab.view)?.contentWindow.postMessage({type:'slide-notes:pdf-select-stop'},location.origin);tab.aiPDFSelecting=null;}
 $('#notebook-editor').hidden=kind==='pdf'||kind==='image';$('#pdf-editors').hidden=kind!=='pdf';$('#image-editors').hidden=kind!=='image';document.body.classList.toggle('viewing-pdf',kind==='pdf'||kind==='image');
 for(const item of editorTabs.items)if(item.view)item.view.hidden=item.path!==editorTabs.active;
 const url=new URL(location.href);if(kind==='notebook')url.searchParams.set('notebook',state.path);else url.searchParams.delete('notebook');history.replaceState(null,'',url);syncAICellWindows();if(state.panel==='ai')renderInspector();
}
async function activateEditor(kind,path){
 if(path&&editorTabs.active===path){renderEditorTabs();return;}
 await save();
 let tab=editorTabs.items.find(t=>t.path===path);
 if(kind==='pdf'||kind==='image'){
  // Validate before discarding the current view; no full PDF is read into JS memory.
  const response=await fetch(kind==='image'?imageFileURL(path):pdfURL(path),{method:'HEAD'});if(!response.ok)throw Error('无法打开文件：不存在或格式不正确');
  clearNotebookEditor();tab ||= {kind,path,title:path.split('/').at(-1)};
 }else{
  const preloaded=tab?.preloaded;
  if(tab)delete tab.preloaded;
  // Retain a PDF/image or the previous notebook until the new document is
  // available. Revealing an empty notebook shell here used to flash on slow IO.
  await loadNotebook(path,preloaded);
  path=state.path;tab=editorTabs.items.find(t=>t.path===path)||{kind,path};tab.title=state.doc.title;
 }
 if(!editorTabs.items.includes(tab))editorTabs.items.push(tab);editorTabs.active=path;
 if(kind==='pdf'||kind==='image'){if(kind==='pdf')pdfView(tab);else imageView(tab);$('#document-title').value=tab.title;$('#status-document').textContent=path;}
 showEditorSurface(kind);renderEditorTabs();revealEditor(kind);if(state.panel==='files')await revealActiveFile({automatic:true});
 if(!editorTabs.restoring)await rememberWorkbench();
}
function openEditor(kind,path){return editorTask(()=>activateEditor(kind,path));}
function openNotebook(path){return openEditor('notebook',path);}
function closeEditor(path){return editorTask(async()=>{
 await save();const index=editorTabs.items.findIndex(t=>t.path===path);if(index<0)return;
 const wasActive=editorTabs.active===path,tab=editorTabs.items[index];
 // Open the replacement first so a failed save/load never loses the visible document.
 const next=editorTabs.items[index+1]||editorTabs.items[index-1];
 if(wasActive&&next)await activateEditor(next.kind,next.path);
 else if(wasActive){clearNotebookEditor();editorTabs.active=null;showEditorSurface(null);}
 tab.view?.imageObserver?.disconnect();if(tab.view?.imageBlobURL)URL.revokeObjectURL(tab.view.imageBlobURL);tab.view?.remove();editorTabs.items.splice(editorTabs.items.indexOf(tab),1);notebookSessions.delete(path);renderEditorTabs();await rememberWorkbench();
 });}
async function restoreEditorSession(session,aliases,requested){
 editorTabs.restoring=true;
 try{
  const items=[...new Map((session.tabs||[]).map(item=>[aliases[item.path]||item.path,{...item,path:aliases[item.path]||item.path}])).values()];
  // Limit IO concurrency while avoiding a serial round trip per restored tab.
  const restored=new Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
   while(next<items.length){const index=next++,item=items[index],path=item.path;try{
    if(item.kind==='notebook'){const data=await api('/api/document?path='+encodeURIComponent(path));restored[index]={kind:'notebook',path:data.path,title:data.document.title,preloaded:data};}
    else if(['image','pdf'].includes(item.kind)&&(await fetch(item.kind==='image'?imageFileURL(path):pdfURL(path),{method:'HEAD'})).ok)restored[index]={kind:item.kind,path,title:path.split('/').at(-1)};
   }catch{/* A removed file must not prevent the workspace from opening. */}}
  }));
  for(const tab of restored)if(tab&&!editorTabs.items.some(item=>item.path===tab.path))editorTabs.items.push(tab);
  const preferred=aliases[requested]||requested||aliases[session.active]||session.active;
  const tab=editorTabs.items.find(t=>t.path===preferred)||editorTabs.items[0];
  if(requested&&!editorTabs.items.some(t=>t.path===preferred)){try{await openNotebook(preferred);}catch(error){toast(error.message);if(tab)await openEditor(tab.kind,tab.path);}}
  else if(tab)await openEditor(tab.kind,tab.path);
  // Only consume the active response. Inactive documents may change through an
  // external editor, so future switches always read a fresh revision.
  for(const item of editorTabs.items)delete item.preloaded;
  renderEditorTabs();
 }finally{editorTabs.restoring=false;}
 await rememberWorkbench();
}
async function remapEditorTabs(remap){
 const affected=[];
 for(const tab of editorTabs.items){const path=remap(tab.path);if(path!==tab.path){affected.push(tab);tab.view?.imageObserver?.disconnect();if(tab.view?.imageBlobURL)URL.revokeObjectURL(tab.view.imageBlobURL);tab.view?.remove();tab.view=null;tab.path=path;if(tab.kind==='pdf'||tab.kind==='image')tab.title=path.split('/').at(-1);}}
 editorTabs.active=editorTabs.active&&remap(editorTabs.active);
 const active=editorTabs.items.find(t=>t.path===editorTabs.active);
 if(active?.kind==='pdf'||active?.kind==='image'){if(active.kind==='pdf')pdfView(active);else imageView(active);$('#document-title').value=active.title;$('#status-document').textContent=active.path;}
 if(active?.kind==='notebook'&&state.doc&&state.path===active.path){active.title=state.doc.title;$('#document-title').value=state.doc.title;$('#document-title').title=state.doc.title;}
 // A plain filesystem move does not change notebook content. Keep the current
 // editor instances, native selection, history and scroll rather than rebuilding
 // every open notebook just to update a path in its tab.
 await Promise.all(affected.filter(tab=>tab.kind==='notebook').map(async tab=>{
  const document=state.path===tab.path?state.doc:null,epoch=state.epoch,clean=state.epoch===state.savedEpoch;
  const data=await api('/api/document?path='+encodeURIComponent(tab.path));tab.title=data.document.title;
  if(document&&state.path===tab.path&&state.doc===document&&state.epoch===epoch&&clean){
   const changed=JSON.stringify(state.doc)!==JSON.stringify(data.document);
   state.revision=data.revision;
   if(changed){state.doc=data.document;render();}
   else {$('#document-title').value=state.doc.title;$('#document-title').title=state.doc.title;$('#status-document').textContent=state.path;$('#status-document').title=state.path;}
  }
  else if(state.path===tab.path&&state.doc){tab.title=state.doc.title;$('#status-document').textContent=state.path;$('#status-document').title=state.path;}
 }));
 if(active?.kind==='notebook'&&affected.includes(active))syncNotebookResourcePaths(remap);
 showEditorSurface(active?.kind);renderEditorTabs();await rememberWorkbench();
}
async function removeDeletedEditors(path){
 return editorTask(async()=>{
  const removed=editorTabs.items.filter(t=>t.path===path||t.path.startsWith(path+'/'));
  const activeRemoved=removed.some(t=>t.path===editorTabs.active);
  editorTabs.items=editorTabs.items.filter(t=>!removed.includes(t));
  for(const tab of removed){tab.view?.imageObserver?.disconnect();if(tab.view?.imageBlobURL)URL.revokeObjectURL(tab.view.imageBlobURL);tab.view?.remove();notebookSessions.delete(tab.path);}
  if(activeRemoved){clearNotebookEditor();editorTabs.active=null;const next=editorTabs.items.at(-1);if(next)await activateEditor(next.kind,next.path);else showEditorSurface(null);}
  renderEditorTabs();await rememberWorkbench();
 });
}
// Route Find to the active PDF even while keyboard focus is still on its tab.
document.addEventListener('keydown',event=>{
 if(!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!=='f'||event.target.closest('input,textarea,[contenteditable]'))return;
 const tab=editorTabs.items.find(item=>item.path===editorTabs.active&&item.kind==='pdf');
 const reader=tab?.view?.querySelector('iframe')?.contentDocument;
 const button=reader?.querySelector('#search-toggle');
 if(!button||button.disabled)return;
 event.preventDefault();if(reader.querySelector('#searchbar').hidden)button.click();
 const query=reader.querySelector('#find-query');query.focus();query.select();
});
