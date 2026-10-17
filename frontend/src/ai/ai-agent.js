'use strict';
let aiWriteLock=null;
function releaseAIWriteLock(requestId){
 if(!aiWriteLock||aiWriteLock.requestId!==requestId)return;
 for(const [element,value] of aiWriteLock.elements)element.inert=value;
 for(const [scope,paused] of aiWriteLock.scopes||[]){scope.paused=paused;if(!paused&&scope.ready&&typeof queueAIScopeSave==='function')queueAIScopeSave(scope);}
 clearTimeout(aiWriteLock.timer);aiWriteLock=null;
}
async function guardAIAgentWrite(event,request){
 let allowed=false;
 try{
  if(request.workspaceSync)await request.workspaceSync;
  if(aiWriteLock&&aiWriteLock.requestId!==request.id)throw Error('另一个 agent 正在保存');
  const elements=['notebook-editor','editor-tabs','document-title'].map(id=>document.getElementById(id)).filter(Boolean).map(element=>[element,element.inert]);
  for(const [element] of elements)element.inert=true;
  aiWriteLock={requestId:request.id,elements,timer:setTimeout(()=>releaseAIWriteLock(request.id),12000)};
  if(event.kind==='files'&&typeof aiState==='object'){
   aiWriteLock.scopes=[...aiState.scopes.values()].map(scope=>[scope,scope.paused]);
   for(const [scope] of aiWriteLock.scopes){scope.paused=true;clearTimeout(scope.saveTimer);}
   await Promise.all(aiWriteLock.scopes.map(([scope])=>scope.savePromise));
  }
  const affected=state.path&&(state.path===event.path||event.kind==='files'&&state.path.startsWith(event.path+'/'));
  if(affected){await save();allowed=state.epoch===state.savedEpoch&&(event.kind&&event.kind!=='notebook'||state.revision===event.revision);}
  else allowed=true;
  if(request.controller.signal.aborted)allowed=false;
  await api('/api/ai/guard',{requestId:request.id,token:event.token,allowed,revision:event.revision});
 }catch{releaseAIWriteLock(request.id);}
 if(!allowed)releaseAIWriteLock(request.id);
}
function applyAIAgentMutation(event,session,assistant){
 if(!event.document||!Array.isArray(event.document.slides))return;
 if(typeof recordAIAgentChanges==='function')recordAIAgentChanges(event,session);
 assistant.operations=(assistant.operations||[]).concat(event.operations||[]);
 if(state.path!==event.path){if(typeof notebookSessions==='object')notebookSessions.delete(event.path);if(typeof updateEditorTitle==='function')updateEditorTitle(event.path,event.document.title);return;}
 if(state.revision===event.revision)return;
 if(state.revision!==event.beforeRevision||state.epoch!==state.savedEpoch){toast('Agent 已保存修改；当前编辑器有独立改动，已保留，请先备份并重新打开笔记核对');return;}
 ensureNotebookHistory();state.doc=structuredClone(event.document);state.revision=event.revision;state.active=Math.min(state.active,state.doc.slides.length-1);state.runtimeDirty=true;
 recordDocumentChange('ai-agent');render();$('#save-status').textContent='Agent 修改已保存 · Ctrl+Z 可撤销';
}
async function applyAIWorkspaceMutation(event,session,assistant){
 assistant.operations=(assistant.operations||[]).concat([{op:'workspace.'+event.operation,path:event.path}]);
 if(event.operation==='move'&&event.previous&&typeof remapFileState==='function')await remapFileState(event.previous,event.path);
 if(event.operation==='trash'&&typeof removeDeletedEditors==='function')await removeDeletedEditors(event.path);
 if(typeof refreshExplorer==='function')await refreshExplorer();
}
function updateAIToolTrace(article,message){
 const traces=message.toolTrace||[];if(!traces.length)return;
 let details=article.querySelector('.ai-tool-trace');
 if(!details){details=document.createElement('details');details.className='ai-tool-trace';details.append(document.createElement('summary'),document.createElement('ol'));article.append(details);}
 if(details.dataset.count===String(traces.length))return;details.dataset.count=String(traces.length);
 details.querySelector('summary').textContent='已使用 '+traces.length+' 项工具';const list=details.querySelector('ol');list.replaceChildren();
 const labels={read_selection:'读取选区',read_pdf:'读取 PDF',search_pdf:'检索 PDF',inspect_note:'读取笔记',read_file:'读取文件',read_image:'读取图片',run_command:'执行命令',create_note:'创建笔记',write_text_file:'保存内容',save_generated_file:'导入生成文件',apply_note_operations:'修改笔记',manage_files:'整理文件'};
 for(const trace of traces){const row=document.createElement('li');row.textContent=(labels[trace.tool]||trace.tool)+(trace.path?' · '+trace.path:'')+(trace.pages?.length?' · 第 '+trace.pages.join('、')+' 页':'')+(Number.isInteger(trace.exitCode)?' · 退出码 '+trace.exitCode:'');
  if(trace.output){const output=document.createElement('pre');output.textContent=trace.output;row.append(output);}list.append(row);
 }
}
function captureAICellSelection(session,card){
 const view=card?.codeEditor,range=view?.state.selection.main;let selected;
 if(typeof getSelection==='function'){
  const selection=getSelection();if(selection&&!selection.isCollapsed&&selection.rangeCount){const range=selection.getRangeAt(0),ancestor=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;if(ancestor?.closest('.markdown-preview,.cell-output')&&card?.contains(ancestor)&&selection.toString().length<=16000)selected={path:session.path,cell:session.cell,from:0,to:selection.toString().length,text:selection.toString(),kind:'rendered'};}
 }
 if(!selected&&range&&!range.empty&&range.to-range.from<=16000){selected={path:session.path,cell:session.cell,from:range.from,to:range.to,text:view.state.doc.sliceString(range.from,range.to),startLine:view.state.doc.lineAt(range.from).number,endLine:view.state.doc.lineAt(range.to).number,kind:'source'};}
 if(selected?.text.trim()){session.cellSelections=[selected];persistAI(session);}
}
function renderAICellSelections(selections,box,remove){
 if(!box)return;box.replaceChildren();
 for(const selected of selections||[]){const card=document.createElement('div');card.className='ai-source-card ai-selected-text';const title=document.createElement('strong');title.textContent=selected.kind==='rendered'?'已选文字':`已选第 ${selected.startLine||1}–${selected.endLine||1} 行`;card.append(title);const text=document.createElement('p');text.textContent=selected.text;card.append(text);if(remove){const button=aiButton('',()=>remove(selected),'x');button.className='ai-source-remove';button.title='移除 cell 文字选区';button.setAttribute('aria-label',button.title);card.append(button);}box.append(card);}
}
